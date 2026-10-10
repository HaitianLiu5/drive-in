import assert from "node:assert/strict";
import { test } from "node:test";
import { createV1App } from "../../src/api/v1.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

// The /v1 HTTP API over the real service layer, D1 schema, and HubCore, with
// a fake node. OAuthProvider is not in the loop; scopes are injected.
function createApi({ scopes = ["read", "control", "manage"], plane = createTestControlPlane() } = {}) {
  const app = createV1App({
    getContext: () => ({ services: plane.services, scopes, userId: USER }),
    issueRealtimeTicket: async (_env, userId) => ({ ticket: `t-${userId}`, expiresAt: 0 }),
  });
  const request = async (method, path, body) => {
    const response = await app.request(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { plane, request };
}

test("queue and playlist endpoints round-trip", async () => {
  const { request } = createApi();
  const added = await request("POST", "/v1/queue", { itemId: "plex:1" });
  assert.equal(added.status, 201);
  assert.equal(added.body.item.title, "Movie 1");
  await request("POST", "/v1/queue", { source: { kind: "url", url: "https://example.com/a" }, position: "next" });
  const queue = await request("GET", "/v1/queue");
  assert.deepEqual(queue.body.map((item) => item.title), ["A video", "Movie 1"]);
  const reordered = await request("POST", "/v1/queue/reorder", { ids: [queue.body[1].id] });
  assert.equal(reordered.body[0].title, "Movie 1");
  assert.equal((await request("DELETE", `/v1/queue/${queue.body[0].id}`)).status, 200);

  const playlist = await request("POST", "/v1/playlists", { name: "Trip" });
  assert.equal(playlist.status, 201);
  await request("POST", `/v1/playlists/${playlist.body.id}/items`, { itemId: "plex:2" });
  const renamed = await request("PATCH", `/v1/playlists/${playlist.body.id}`, { name: "Road trip" });
  assert.equal(renamed.body.name, "Road trip");
  const enqueued = await request("POST", `/v1/playlists/${playlist.body.id}/enqueue`, { position: "end" });
  assert.equal(enqueued.body.added, 1);
  assert.equal((await request("DELETE", `/v1/playlists/${playlist.body.id}`)).status, 200);
  assert.equal((await request("GET", `/v1/playlists/${playlist.body.id}`)).status, 404);
});

test("playback endpoints drive the hub", async () => {
  const { request } = createApi();
  const played = await request("POST", "/v1/playback/play", { itemId: "plex:5", startTime: 12 });
  assert.equal(played.status, 200);
  assert.equal(played.body.state.position, 12);
  assert.equal((await request("POST", "/v1/playback/pause")).body.state.status, "paused");
  assert.equal((await request("POST", "/v1/playback/seek", { position: 30 })).body.state.position, 30);
  const playback = await request("GET", "/v1/playback");
  assert.equal(playback.body.item.title, "Movie 5");
  assert.equal((await request("POST", "/v1/playback/stop")).body.state.status, "idle");
  const history = await request("GET", "/v1/history?limit=5");
  assert.equal(history.body[0].sourceKey, "plex:5");
  assert.equal((await request("DELETE", "/v1/history", { sourceKey: "plex:5" })).body.deleted, 1);
});

test("errors use the shared error body and status codes", async () => {
  const { request, plane } = createApi();
  const bad = await request("POST", "/v1/playback/seek", { position: -1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_request");
  plane.node.offline = true;
  const offline = await request("GET", "/v1/library");
  assert.equal(offline.status, 503);
  assert.deepEqual(offline.body.error, { code: "node_offline", message: "Media node is offline", retryable: true });
  assert.equal((await request("GET", "/v1/nope")).body.error.code, "not_found");
});

test("each route enforces its scope", async () => {
  const { request } = createApi({ scopes: ["read"] });
  assert.equal((await request("GET", "/v1/queue")).status, 200);
  const denied = await request("DELETE", "/v1/queue");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "forbidden");
  assert.equal((await request("POST", "/v1/playback/pause")).status, 403);
  assert.equal((await request("POST", "/v1/realtime/ticket")).body.ticket, `t-${USER}`);
});
