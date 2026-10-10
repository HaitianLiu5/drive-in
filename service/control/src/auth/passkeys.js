import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { randomToken, safeEqual, sha256, YoloError } from "@useyolo/core";
import {
  addPasskey,
  countPasskeys,
  ensureOwner,
  getPasskey,
  isInitCodeUsed,
  listPasskeys,
  markInitCodeUsed,
  updatePasskeyCounter,
} from "../store/users.js";
import { readCookie } from "./session.js";

// Owner sign-in is passkey-only (decision 16). The first passkey, and any
// recovery after losing every device, needs the one-time init code stored in
// the OWNER_INIT_CODE Worker secret. Each code works once; rotate the secret
// to register again. A signed-in owner may add more passkeys without a code.

export const CHALLENGE_COOKIE = "__Host-yolo-webauthn";
const CHALLENGE_TTL_SECONDS = 300;

export function relyingParty(env, request) {
  const origin = new URL(env.PUBLIC_ORIGIN || request.url).origin;
  return { origin, rpID: new URL(origin).hostname, rpName: "Yolo" };
}

async function saveChallenge(kv, value) {
  const flow = randomToken(18);
  // KV's minimum TTL is 60s; `exp` enforces the shorter lifetime.
  await kv.put(`yolo:webauthn:${flow}`, JSON.stringify({ ...value, exp: Date.now() + CHALLENGE_TTL_SECONDS * 1000 }), {
    expirationTtl: CHALLENGE_TTL_SECONDS,
  });
  return `${CHALLENGE_COOKIE}=${flow}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${CHALLENGE_TTL_SECONDS}`;
}

async function takeChallenge(kv, request, kind) {
  const flow = readCookie(request.headers.get("cookie"), CHALLENGE_COOKIE);
  if (!flow) throw new YoloError("invalid_request", "Sign-in expired; start again");
  const key = `yolo:webauthn:${flow}`;
  const value = JSON.parse((await kv.get(key)) || "null");
  await kv.delete(key);
  if (!value || value.kind !== kind || value.exp < Date.now()) throw new YoloError("invalid_request", "Sign-in expired; start again");
  return value;
}

// Is `code` the configured init code, and still unused?
export async function checkInitCode(env, db, code) {
  if (!env.OWNER_INIT_CODE || typeof code !== "string" || code.length < 16) return null;
  const [given, expected] = await Promise.all([sha256(code.trim()), sha256(env.OWNER_INIT_CODE.trim())]);
  if (!safeEqual(given, expected)) return null;
  if (await isInitCodeUsed(db, expected)) return null;
  return expected;
}

export async function setupState(db) {
  return { hasPasskey: (await countPasskeys(db)) > 0 };
}

export async function registrationOptions({ env, db, kv, request, initCode, session }) {
  const codeHash = session ? null : await checkInitCode(env, db, initCode);
  if (!session && !codeHash) throw new YoloError("forbidden", "Init code is wrong or already used");
  const owner = session ? { id: session.userId, displayName: "Owner" } : await ensureOwner(db);
  const { rpID, rpName } = relyingParty(env, request);
  const existing = await listPasskeys(db, owner.id);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: owner.displayName,
    userID: new TextEncoder().encode(owner.id),
    attestationType: "none",
    excludeCredentials: existing.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const setCookie = await saveChallenge(kv, { kind: "register", challenge: options.challenge, userId: owner.id, codeHash });
  return { options, setCookie };
}

export async function verifyRegistration({ env, db, kv, request, response, name }) {
  const pending = await takeChallenge(kv, request, "register");
  const { origin, rpID } = relyingParty(env, request);
  // Re-check the code: it may have been used in another tab meanwhile.
  if (pending.codeHash && (await isInitCodeUsed(db, pending.codeHash))) {
    throw new YoloError("forbidden", "Init code is already used");
  }
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!result.verified) throw new YoloError("unauthorized", "Passkey registration failed");
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  await addPasskey(db, pending.userId, {
    id: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    name: name ? String(name).slice(0, 100) : null,
  });
  if (pending.codeHash) await markInitCodeUsed(db, pending.userId, pending.codeHash);
  return { userId: pending.userId };
}

export async function authenticationOptions({ env, kv, request }) {
  const { rpID } = relyingParty(env, request);
  // Discoverable credentials: the authenticator picks the passkey.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const setCookie = await saveChallenge(kv, { kind: "login", challenge: options.challenge });
  return { options, setCookie };
}

export async function verifyAuthentication({ env, db, kv, request, response }) {
  const pending = await takeChallenge(kv, request, "login");
  const passkey = await getPasskey(db, String(response?.id || ""));
  if (!passkey) throw new YoloError("unauthorized", "Unknown passkey");
  const { origin, rpID } = relyingParty(env, request);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: passkey.id,
      publicKey: isoBase64URL.toBuffer(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports,
    },
  });
  if (!result.verified) throw new YoloError("unauthorized", "Passkey sign-in failed");
  await updatePasskeyCounter(db, passkey.id, result.authenticationInfo.newCounter);
  return { userId: passkey.userId };
}
