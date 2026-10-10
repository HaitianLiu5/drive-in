import { base64url } from "./ids.js";

// HMAC helpers built on WebCrypto, so the same code runs in Workers and Node.
// Two uses (yolo-v1.md §3, §8):
// - media tokens in `/m/{token}/…`, verified by the node without a callback;
// - request signatures on control plane → node calls (defense in depth on top
//   of the Workers VPC binding).

const encoder = new TextEncoder();
const keyCache = new Map();

async function hmacKey(secret) {
  if (!secret || typeof secret !== "string") throw new TypeError("A shared secret is required");
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmac(secret, message) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return base64url(new Uint8Array(signature));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// Constant-time comparison for equal-length ASCII strings.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const MEDIA_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const ID_PART = /^[A-Za-z0-9_-]{1,64}$/;

export async function signMediaToken(secret, { sessionId, userId, exp }) {
  if (!ID_PART.test(sessionId) || !ID_PART.test(userId)) throw new TypeError("Invalid media token ids");
  const expiry = Math.floor(Number(exp));
  const signature = await hmac(secret, `${sessionId}|${userId}|${expiry}`);
  return `${sessionId}.${userId}.${expiry}.${signature}`;
}

export async function verifyMediaToken(secret, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const [sessionId, userId, expText, signature] = parts;
  const exp = Number(expText);
  if (!ID_PART.test(sessionId) || !ID_PART.test(userId) || !Number.isInteger(exp)) return null;
  if (exp * 1000 <= now) return null;
  const expected = await hmac(secret, `${sessionId}|${userId}|${exp}`);
  return safeEqual(expected, signature) ? { sessionId, userId, exp } : null;
}

export const SIGNATURE_HEADER = "x-yolo-signature";
export const TIMESTAMP_HEADER = "x-yolo-timestamp";
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalRequest({ method, path, timestamp, bodyHash }) {
  return [timestamp, String(method).toUpperCase(), path, bodyHash].join("\n");
}

export async function signNodeRequest(secret, { method, path, body = "", timestamp = Date.now() }) {
  const bodyHash = await sha256(body);
  const signature = await hmac(secret, canonicalRequest({ method, path, timestamp, bodyHash }));
  return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: signature };
}

export async function verifyNodeRequest(secret, { method, path, body = "", headers, now = Date.now() }) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const timestamp = Number(get(TIMESTAMP_HEADER));
  const signature = get(SIGNATURE_HEADER);
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;
  const bodyHash = await sha256(body);
  const expected = await hmac(secret, canonicalRequest({ method, path, timestamp, bodyHash }));
  return safeEqual(expected, signature);
}
