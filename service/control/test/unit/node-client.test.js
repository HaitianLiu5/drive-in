import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { isNodeRequest, nodeFetch } from "../../src/node-client.js";

const env = {
  NODE_TRANSPORT: "tunnel",
  NODE_SECRET: "test-secret-with-enough-entropy",
  PUBLIC_ORIGIN: "https://yolo.haitian.site",
};

test("tunnel transport refuses to call the Worker's own host", async () => {
  await assert.rejects(
    nodeFetch({ ...env, NODE_PUBLIC_ORIGIN: "https://yolo.haitian.site" }, "/internal/v1/health"),
    { code: "node_offline", message: /points at this Worker/ },
  );
});

test("tunnel transport calls a separate node host", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(String(url));
    return Response.json({ ok: true });
  });
  await nodeFetch({ ...env, NODE_PUBLIC_ORIGIN: "https://node.example.com" }, "/internal/v1/health");
  assert.deepEqual(seen, ["https://node.example.com/internal/v1/health"]);
});

test("signed node requests are recognised so the Worker can reject them", async () => {
  const headers = await signNodeRequest(env.NODE_SECRET, { method: "GET", path: "/internal/v1/health" });
  assert.equal(isNodeRequest(new Request("https://yolo.haitian.site/internal/v1/health", { headers })), true);
  assert.equal(isNodeRequest(new Request("https://yolo.haitian.site/mcp")), false);
});
