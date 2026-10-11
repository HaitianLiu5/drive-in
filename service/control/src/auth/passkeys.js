import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { randomToken, YoloError } from "@useyolo/core";
import {
  addPasskey,
  countPasskeys,
  deletePasskeysExcept,
  ensureOwner,
  getPasskey,
  listPasskeys,
  updatePasskeyCounter,
} from "../store/users.js";
import { readCookie, revokeAllSessions } from "./session.js";

// Owner sign-in is passkey-only (decision 16). Without a session, registering
// a passkey needs the 6-digit pairing code the home node prints for
// `npm run owner-code`. The node checks the code and uses it up; nothing about
// it is stored in Cloudflare, and the node's 5-attempt limit is what makes six
// digits enough. A code registration is also the only recovery: the new
// passkey replaces every other one and every owner session is revoked. A
// signed-in owner may add more passkeys without a code.

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

function normalizeOwnerCode(code) {
  const value = String(code ?? "").replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(value)) {
    throw new YoloError("invalid_request", "Enter the 6-digit code that `npm run owner-code` prints on the home machine");
  }
  return value;
}

// Ask the node to check (`verify`) or use up (`consume`) a pairing code. Its
// own errors (wrong, expired, too many attempts) pass through as they are.
async function ownerCodeOnNode(node, action, code) {
  try {
    return await node.post(`/internal/v1/owner-code/${action}`, { code });
  } catch (error) {
    if (error?.code === "node_offline") {
      throw new YoloError("node_offline", "Setting up a passkey needs the home media node online. Start it, then try again.");
    }
    if (error?.code === "not_found") {
      throw new YoloError("node_offline", "The home media node does not issue pairing codes yet. Update and restart it.");
    }
    if (error?.code === "unauthorized") {
      throw new YoloError("node_offline", "The home media node rejected this server. Check that both use the same NODE_SECRET.");
    }
    throw error;
  }
}

export async function setupState(db) {
  return { hasPasskey: (await countPasskeys(db)) > 0 };
}

export async function registrationOptions({ env, db, kv, request, code, session, node }) {
  // A code means a reset even when signed in, as the /login page says.
  const viaCode = !session || String(code ?? "").trim() !== "";
  if (viaCode) await ownerCodeOnNode(node, "verify", normalizeOwnerCode(code));
  const owner = viaCode ? await ensureOwner(db) : { id: session.userId, displayName: "Owner" };
  const { rpID, rpName } = relyingParty(env, request);
  // A code registration replaces every passkey, so let the authenticator
  // overwrite one it may still hold.
  const existing = viaCode ? [] : await listPasskeys(db, owner.id);
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
  const setCookie = await saveChallenge(kv, { kind: "register", challenge: options.challenge, userId: owner.id, viaCode });
  return { options, setCookie };
}

// `code` is sent again here rather than kept with the challenge, so the code
// never sits in KV.
export async function verifyRegistration({ env, db, kv, request, response, name, code, node }) {
  const pending = await takeChallenge(kv, request, "register");
  const { origin, rpID } = relyingParty(env, request);
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!result.verified) throw new YoloError("unauthorized", "Passkey registration failed");
  // Use the code up only after the passkey checks out, so a failed ceremony
  // does not burn it.
  if (pending.viaCode) await ownerCodeOnNode(node, "consume", normalizeOwnerCode(code));
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
  if (pending.viaCode) {
    await deletePasskeysExcept(db, pending.userId, credential.id);
    await revokeAllSessions(kv);
  }
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
