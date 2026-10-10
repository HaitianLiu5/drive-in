import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "@useyolo/core";
import { checkInitCode, registrationOptions, relyingParty } from "../../src/auth/passkeys.js";
import { createSession, destroySession, getSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { issueRealtimeTicket, redeemRealtimeTicket } from "../../src/realtime.js";
import { markInitCodeUsed } from "../../src/store/users.js";
import { escapeHtml, consentPage } from "../../src/auth/pages.js";
import { createTestD1 } from "../helpers/d1.js";
import { createMemoryKv } from "../helpers/kv.js";

const env = { OWNER_INIT_CODE: "init-code-0123456789abcdef", PUBLIC_ORIGIN: "https://yolo.example.com" };
const request = new Request("https://yolo.example.com/login");

test("init codes work once and must be long", async () => {
  const db = createTestD1();
  assert.equal(await checkInitCode(env, db, "short"), null);
  assert.equal(await checkInitCode(env, db, "init-code-0123456789abcdeX"), null);
  const hash = await checkInitCode(env, db, ` ${env.OWNER_INIT_CODE} `);
  assert.equal(hash, await sha256(env.OWNER_INIT_CODE));
  await markInitCodeUsed(db, "usr_1", hash);
  assert.equal(await checkInitCode(env, db, env.OWNER_INIT_CODE), null);
  assert.equal(await checkInitCode({}, db, env.OWNER_INIT_CODE), null);
});

test("registration options need a valid code or a session", async () => {
  const db = createTestD1();
  const kv = createMemoryKv();
  await assert.rejects(registrationOptions({ env, db, kv, request, initCode: "wrong-wrong-wrong-wrong" }), { code: "forbidden" });
  const { options, setCookie } = await registrationOptions({ env, db, kv, request, initCode: env.OWNER_INIT_CODE });
  assert.equal(options.rp.id, "yolo.example.com");
  assert.equal(options.authenticatorSelection.userVerification, "required");
  assert.match(setCookie, /^__Host-yolo-webauthn=.+SameSite=Strict/);
  assert.deepEqual(relyingParty(env, request), { origin: "https://yolo.example.com", rpID: "yolo.example.com", rpName: "Yolo" });
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
