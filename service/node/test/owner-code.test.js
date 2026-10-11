import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createLocalApp, createNodeApp } from "../src/app.js";
import { listenLocal, requestLocal } from "../src/local.js";
import { createOwnerCodes, OWNER_CODE_TTL_MS } from "../src/owner-code.js";

const secret = "node-test-secret";

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

const wrongFor = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

test("codes are six digits and work exactly once", () => {
  const codes = createOwnerCodes();
  for (let i = 0; i < 200; i += 1) assert.match(codes.issue().code, /^[0-9]{6}$/);
  const { code } = codes.issue();
  assert.equal(codes.verify(code).ok, true);
  assert.equal(codes.verify(code).ok, true, "verify does not use the code up");
  assert.deepEqual(codes.consume(code), { ok: true });
  assert.throws(() => codes.verify(code), { code: "forbidden", message: /No pairing code is active/ });
  assert.throws(() => codes.consume(code), { code: "forbidden" });
});

test("codes expire after 15 minutes", () => {
  const time = clock();
  const codes = createOwnerCodes({ now: time.now });
  const { code, expiresAt } = codes.issue();
  assert.equal(expiresAt, time.now() + OWNER_CODE_TTL_MS);
  time.advance(OWNER_CODE_TTL_MS - 1);
  assert.equal(codes.verify(code).ok, true);
  time.advance(1);
  assert.throws(() => codes.consume(code), { message: /No pairing code is active/ });
});

test("five wrong attempts invalidate the code; fewer do not", () => {
  const codes = createOwnerCodes();
  let { code } = codes.issue();
  for (let i = 1; i <= 4; i += 1) {
    assert.throws(() => codes.verify(wrongFor(code)), { code: "forbidden", message: new RegExp(`${5 - i} tr`) });
  }
  assert.deepEqual(codes.consume(code), { ok: true });

  ({ code } = codes.issue());
  for (let i = 0; i < 4; i += 1) assert.throws(() => codes.consume(wrongFor(code)), { message: /Wrong pairing code/ });
  assert.throws(() => codes.verify(wrongFor(code)), { message: /Too many wrong codes/ });
  assert.throws(() => codes.verify(code), { message: /No pairing code is active/ });
});

test("issuing again replaces the old code and resets the attempts", () => {
  const codes = createOwnerCodes();
  const first = codes.issue().code;
  for (let i = 0; i < 4; i += 1) assert.throws(() => codes.verify(wrongFor(first)));
  let second = codes.issue().code;
  while (second === first) second = codes.issue().code;
  assert.throws(() => codes.verify(first), { message: /4 tries left/ });
  assert.equal(codes.verify(second).ok, true);
});

test("any input is compared as a fixed-length digest and counts as an attempt", () => {
  const codes = createOwnerCodes();
  const { code } = codes.issue();
  // Raw timingSafeEqual throws on length mismatch; digests never mismatch.
  for (const input of ["1", `${code}0`, null, Number(code)]) {
    assert.throws(() => codes.verify(input), { code: "forbidden", message: /Wrong pairing code/ });
  }
  assert.throws(() => codes.verify(""), { message: /Too many wrong codes/ });
  assert.throws(() => codes.verify(code), { message: /No pairing code is active/ });
});

async function signed(app, method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signNodeRequest(secret, { method, path, body: payload });
  return app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
}

function nodeApp(ownerCodes) {
  return createNodeApp({ secret, ownerCodes, plex: {}, ytdlp: {}, legacy: {} });
}

test("the control plane's listener can verify and consume a code but never issue one", async () => {
  const ownerCodes = createOwnerCodes();
  const app = nodeApp(ownerCodes);
  for (const path of ["/internal/v1/owner-code", "/internal/v1/owner-code/issue", "/local/v1/owner-code", "/m/x/../../local/v1/owner-code"]) {
    const response = await signed(app, "POST", path, {});
    assert.equal(response.status, 404, path);
  }
  assert.throws(() => ownerCodes.verify("000000"), { message: /No pairing code is active/ }, "nothing was issued");

  const { code } = ownerCodes.issue();
  assert.equal((await app.request("/internal/v1/owner-code/verify", { method: "POST", body: JSON.stringify({ code }) })).status, 401);
  assert.equal((await signed(app, "POST", "/internal/v1/owner-code/verify", { code })).status, 200);
  const wrong = await signed(app, "POST", "/internal/v1/owner-code/verify", { code: wrongFor(code) });
  assert.equal(wrong.status, 403);
  assert.match((await wrong.json()).error.message, /4 tries left/);
  assert.equal((await signed(app, "POST", "/internal/v1/owner-code/consume", { code })).status, 200);
  assert.equal((await signed(app, "POST", "/internal/v1/owner-code/consume", { code })).status, 403);
});

test("the local app issues codes only to signed requests and serves nothing else", async () => {
  const ownerCodes = createOwnerCodes();
  const local = createLocalApp({ secret, ownerCodes });
  assert.equal((await local.request("/local/v1/owner-code", { method: "POST" })).status, 401);
  const response = await signed(local, "POST", "/local/v1/owner-code", {});
  assert.equal(response.status, 200);
  const { code } = await response.json();
  assert.equal(ownerCodes.verify(code).ok, true);
  assert.equal((await signed(local, "POST", "/internal/v1/owner-code/consume", { code })).status, 404);
});

test("owner commands travel over a private Unix socket", async (t) => {
  const socketPath = join(tmpdir(), `yolo-node-test-${process.pid}-${Date.now()}.sock`);
  const ownerCodes = createOwnerCodes();
  const server = await listenLocal(createLocalApp({ secret, ownerCodes }), socketPath);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  const { status, body } = await requestLocal("/local/v1/owner-code", { socketPath, secret });
  assert.equal(status, 200);
  assert.equal(ownerCodes.verify(body.code).ok, true);
  assert.equal((await requestLocal("/local/v1/owner-code", { socketPath, secret: "wrong" })).status, 401);
  await assert.rejects(listenLocal(createLocalApp({ secret, ownerCodes }), socketPath), /already listens/);
  await assert.rejects(
    requestLocal("/local/v1/owner-code", { socketPath: `${socketPath}.missing`, secret }),
    { code: "ENOENT" },
  );
  await assert.rejects(listenLocal(createLocalApp({ secret, ownerCodes }), `/tmp/${"x".repeat(120)}.sock`), /NODE_LOCAL_SOCKET/);
});
