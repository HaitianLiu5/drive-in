import assert from "node:assert/strict";
import { test } from "node:test";
import { signMediaToken, verifyMediaToken, signNodeRequest, verifyNodeRequest, safeEqual } from "../src/index.js";

const secret = "test-secret-with-enough-entropy";

test("media tokens verify until they expire and reject tampering", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = await signMediaToken(secret, { sessionId: "ses_a", userId: "usr_b", exp });
  assert.deepEqual(await verifyMediaToken(secret, token), { sessionId: "ses_a", userId: "usr_b", exp });
  assert.equal(await verifyMediaToken(secret, token.replace("ses_a", "ses_c")), null);
  assert.equal(await verifyMediaToken("other-secret", token), null);
  assert.equal(await verifyMediaToken(secret, token, (exp + 1) * 1000), null);
});

test("node request signatures bind method, path, body and time", async () => {
  const timestamp = Date.now();
  const headers = await signNodeRequest(secret, { method: "POST", path: "/internal/v1/prepare", body: "{}", timestamp });
  const ok = (overrides = {}) => verifyNodeRequest(secret, {
    method: "POST", path: "/internal/v1/prepare", body: "{}", headers, now: timestamp, ...overrides,
  });
  assert.equal(await ok(), true);
  assert.equal(await ok({ method: "GET" }), false);
  assert.equal(await ok({ path: "/internal/v1/health" }), false);
  assert.equal(await ok({ body: "{\"x\":1}" }), false);
  assert.equal(await ok({ now: timestamp + 10 * 60 * 1000 }), false);
});

test("safeEqual compares strings of equal length only", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});
