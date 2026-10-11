import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/core";
import { createAuthApp } from "../../src/auth/app.js";
import { CHALLENGE_COOKIE, registrationOptions, relyingParty } from "../../src/auth/passkeys.js";
import { createSession, destroySession, getSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { issueRealtimeTicket, redeemRealtimeTicket } from "../../src/realtime.js";
import { addPasskey, ensureOwner, listPasskeys } from "../../src/store/users.js";
import { escapeHtml, consentPage, loginPage } from "../../src/auth/pages.js";
import { createTestD1 } from "../helpers/d1.js";
import { createFakeNode } from "../helpers/fakes.js";
import { createMemoryKv } from "../helpers/kv.js";
import { createCredential } from "../helpers/webauthn.js";

const ORIGIN = "https://yolo.example.com";
const env = { PUBLIC_ORIGIN: ORIGIN };
const request = new Request(`${ORIGIN}/login`);

// A node holding one pairing code, with the verify / consume semantics of
// service/node/src/owner-code.js (issuing is not reachable from here).
function pairingNode(code = "123456") {
  const node = createFakeNode();
  node.code = code;
  const check = ({ code: given }) => {
    if (!node.code) throw new YoloError("forbidden", "No pairing code is active");
    if (given !== node.code) throw new YoloError("forbidden", "Wrong pairing code; 4 tries left");
  };
  node.routes["POST /internal/v1/owner-code/verify"] = (body) => {
    check(body);
    return { ok: true };
  };
  node.routes["POST /internal/v1/owner-code/consume"] = (body) => {
    check(body);
    node.code = null;
    return { ok: true };
  };
  return node;
}

// The auth app over a fake node, plus a cookie jar for one browser.
function signInHarness(node = pairingNode()) {
  const db = createTestD1();
  const kv = createMemoryKv();
  const app = createAuthApp({ nodeClient: () => node });
  const bindings = { ...env, DB: db, OAUTH_KV: kv };
  const cookies = new Map();
  async function post(path, body) {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }, bindings);
    const set = response.headers.get("set-cookie");
    if (set) {
      const [name, ...value] = set.split(";")[0].split("=");
      cookies.set(name, value.join("="));
    }
    return { status: response.status, body: await response.json() };
  }
  // Options, a software passkey, then verify; returns both responses.
  async function register({ code, verifyCode = code } = {}) {
    const options = await post("/auth/passkey/register/options", { code });
    if (options.status !== 200) return { options };
    const credential = createCredential(options.body, ORIGIN);
    const verify = await post("/auth/passkey/register/verify", { code: verifyCode, response: credential });
    return { options, verify, credential };
  }
  return { app, db, kv, node, bindings, cookies, post, register };
}

const sessionKeys = (kv) => [...kv.map.keys()].filter((key) => key.startsWith("yolo:session:"));

test("the setup page asks for a 6-digit code from npm run owner-code", () => {
  for (const hasPasskey of [false, true]) {
    const html = loginPage({ hasPasskey });
    assert.match(html, /inputmode="numeric"/);
    assert.match(html, /autocomplete="one-time-code"/);
    assert.match(html, /pattern="\[0-9\]\{6\}" maxlength="6"/);
    assert.match(html, /npm run owner-code/);
    assert.equal(html.includes("OWNER_INIT_CODE"), false);
  }
});

test("first setup: the node verifies the code, then consumes it once the passkey checks out", async () => {
  const h = signInHarness();
  const { options, verify, credential } = await h.register({ code: " 123 456 " });
  assert.equal(options.status, 200);
  assert.equal(options.body.rp.id, "yolo.example.com");
  assert.equal(options.body.authenticatorSelection.userVerification, "required");
  assert.equal(verify.status, 200);
  assert.deepEqual(h.node.calls.map(({ path, body }) => [path, body.code]), [
    ["/internal/v1/owner-code/verify", "123456"],
    ["/internal/v1/owner-code/consume", "123456"],
  ]);
  const owner = await ensureOwner(h.db);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [credential.id]);
  const signedIn = new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${h.cookies.get(SESSION_COOKIE)}` } });
  assert.equal((await getSession(h.kv, signedIn)).userId, owner.id);
  // The code is used up.
  assert.equal((await h.register({ code: "123456" })).options.status, 403);
});

test("the code is never stored in Cloudflare", async () => {
  const h = signInHarness();
  await h.post("/auth/passkey/register/options", { code: "123456" });
  const challenges = [...h.kv.map].filter(([key]) => key.startsWith("yolo:webauthn:"));
  assert.equal(challenges.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(challenges[0][1])).sort(), ["challenge", "exp", "kind", "userId", "viaCode"]);
  const table = h.db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'init_codes_used'").get();
  assert.equal(table, undefined, "migration 0002 drops the old init code table");
});

test("a wrong or malformed code gets no challenge", async () => {
  const h = signInHarness();
  const wrong = await h.post("/auth/passkey/register/options", { code: "654321" });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error.message, /Wrong pairing code; 4 tries left/);
  for (const code of [undefined, "", "12345", "1234567", "abcdef"]) {
    const response = await h.post("/auth/passkey/register/options", { code });
    assert.equal(response.status, 400, String(code));
    assert.match(response.body.error.message, /6-digit code/);
  }
  assert.equal(h.node.calls.length, 1, "malformed codes never reach the node");
  assert.equal(h.cookies.has(CHALLENGE_COOKIE), false);
  await assert.rejects(registrationOptions({ env, db: h.db, kv: h.kv, request, code: "000000", node: h.node }), { code: "forbidden" });
});

test("setup says clearly when the home node is offline or too old", async () => {
  const h = signInHarness();
  h.node.offline = true;
  const offline = await h.post("/auth/passkey/register/options", { code: "123456" });
  assert.equal(offline.status, 503);
  assert.match(offline.body.error.message, /needs the home media node online/);

  const old = signInHarness(createFakeNode());
  const outdated = await old.post("/auth/passkey/register/options", { code: "123456" });
  assert.equal(outdated.status, 503);
  assert.match(outdated.body.error.message, /Update and restart it/);
});

test("a code that dies before verify saves no passkey", async () => {
  const h = signInHarness();
  const options = await h.post("/auth/passkey/register/options", { code: "123456" });
  h.node.code = "999999"; // Reissued on the home machine meanwhile.
  const verify = await h.post("/auth/passkey/register/verify", { code: "123456", response: createCredential(options.body, ORIGIN) });
  assert.equal(verify.status, 403);
  assert.equal((await listPasskeys(h.db, (await ensureOwner(h.db)).id)).length, 0);
  assert.equal(h.cookies.has(SESSION_COOKIE), false);
});

test("a code registration with passkeys present is a reset: other passkeys and sessions go", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "old-phone", publicKey: "x", counter: 0, transports: ["internal"] });
  await addPasskey(h.db, owner.id, { id: "old-laptop", publicKey: "x", counter: 0, transports: ["hybrid"] });
  for (let i = 0; i < 3; i += 1) await createSession(h.kv, owner.id);
  await h.kv.put("token:unrelated", "kept");

  const { options, verify, credential } = await h.register({ code: "123456" });
  assert.deepEqual(options.body.excludeCredentials, [], "the authenticator may overwrite an old passkey");
  assert.equal(verify.status, 200);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id), [credential.id]);
  assert.equal(sessionKeys(h.kv).length, 1, "only the session just created survives");
  const signedIn = new Request(ORIGIN, { headers: { cookie: `${SESSION_COOKIE}=${h.cookies.get(SESSION_COOKIE)}` } });
  assert.equal((await getSession(h.kv, signedIn)).userId, owner.id);
  assert.equal(await h.kv.get("token:unrelated"), "kept");
});

test("a signed-in owner adds a passkey without a code and keeps the others", async () => {
  const h = signInHarness();
  const owner = await ensureOwner(h.db);
  await addPasskey(h.db, owner.id, { id: "phone", publicKey: "x", counter: 0, transports: ["internal"] });
  await createSession(h.kv, owner.id); // Another device.
  const cookie = (await createSession(h.kv, owner.id)).split(";")[0].split("=");
  h.cookies.set(cookie[0], cookie.slice(1).join("="));

  const { options, verify, credential } = await h.register({});
  assert.equal(verify.status, 200);
  assert.deepEqual(options.body.excludeCredentials.map((item) => item.id), ["phone"]);
  assert.equal(h.node.calls.length, 0);
  assert.deepEqual((await listPasskeys(h.db, owner.id)).map((passkey) => passkey.id).sort(), [credential.id, "phone"].sort());
  assert.equal(sessionKeys(h.kv).length, 3);
  assert.deepEqual(relyingParty(env, request), { origin: ORIGIN, rpID: "yolo.example.com", rpName: "Yolo" });
});

test("sessions live in KV under a hash of the cookie", async () => {
  const kv = createMemoryKv();
  const setCookie = await createSession(kv, "usr_1");
  const value = setCookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
  assert.equal([...kv.map.keys()].some((key) => key.includes(value)), false);
  const withCookie = new Request("https://x.test", { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
  assert.equal((await getSession(kv, withCookie)).userId, "usr_1");
  await destroySession(kv, withCookie);
  assert.equal(await getSession(kv, withCookie), null);
});

test("realtime tickets are single use", async () => {
  const kv = createMemoryKv();
  const { ticket } = await issueRealtimeTicket({ OAUTH_KV: kv }, "usr_1");
  assert.equal(await redeemRealtimeTicket({ OAUTH_KV: kv }, ticket), "usr_1");
  assert.equal(await redeemRealtimeTicket({ OAUTH_KV: kv }, ticket), null);
  assert.equal(await redeemRealtimeTicket({ OAUTH_KV: kv }, null), null);
});

test("consent page escapes client-supplied text and warns about local apps", () => {
  assert.equal(escapeHtml("<b>\"x\"</b>"), "&#60;b&#62;&#34;x&#34;&#60;/b&#62;");
  const html = consentPage({ clientName: "<script>alert(1)</script>", redirectHost: "127.0.0.1", redirectIsLoopback: true, scope: ["read", "manage"] }, "h1");
  assert.equal(html.includes("<script>alert"), false);
  assert.match(html, /app on your computer/);
  assert.match(html, /value="manage" checked/);
});
