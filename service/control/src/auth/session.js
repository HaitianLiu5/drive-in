import { randomToken, sha256 } from "@useyolo/core";

// Owner sessions after passkey sign-in. The cookie holds a random id; KV holds
// only its hash.

export const SESSION_COOKIE = "__Host-yolo-session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_PREFIX = "yolo:session:";
const kvKey = async (id) => `${SESSION_PREFIX}${await sha256(id)}`;

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function cookie(name, value, { maxAge, sameSite = "Lax" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=${sameSite}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`;
}

export async function createSession(kv, userId) {
  const id = randomToken();
  await kv.put(await kvKey(id), JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: SESSION_TTL_SECONDS });
  return cookie(SESSION_COOKIE, id, { maxAge: SESSION_TTL_SECONDS });
}

export async function getSession(kv, request) {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!id) return null;
  const value = await kv.get(await kvKey(id));
  return value ? JSON.parse(value) : null;
}

export async function destroySession(kv, request) {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (id) await kv.delete(await kvKey(id));
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

// Sign the owner out everywhere; a pairing-code reset does this (decision 16).
// KV lists are eventually consistent, which is fine for one owner's sessions.
export async function revokeAllSessions(kv) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: SESSION_PREFIX, cursor });
    names.push(...page.keys.map(({ name }) => name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  await Promise.all(names.map((name) => kv.delete(name)));
}
