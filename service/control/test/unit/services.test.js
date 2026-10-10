import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestControlPlane } from "../helpers/setup.js";

test("queue edits keep working while the node is offline", async () => {
  const plane = createTestControlPlane();
  plane.node.offline = true;
  const { item, queue } = await plane.services.addToQueue({ url: "https://example.com/video" });
  assert.equal(item.title, "https://example.com/video");
  assert.equal(item.metadata.pendingMetadata, true);
  assert.equal(queue.length, 1);
  const playlist = await plane.services.createPlaylist({ name: "Later" });
  await plane.services.addToPlaylist(playlist.id, { itemId: "plex:5" });
  assert.equal((await plane.services.getPlaylist(playlist.id)).items.length, 1);
  assert.equal((await plane.services.status()).node.online, false);
  await assert.rejects(plane.services.search({ query: "Alien" }), { code: "node_offline" });
});

test("queue_add fills in metadata from the node", async () => {
  const plane = createTestControlPlane();
  const { item } = await plane.services.addToQueue({ itemId: "plex:9", position: "next" });
  assert.equal(item.title, "Movie 9");
  assert.equal(item.duration, 600);
  assert.equal(plane.transport.broadcasts.some((message) => message.type === "queue"), true);
});

test("play by queue item removes it from the queue", async () => {
  const plane = createTestControlPlane();
  const { item } = await plane.services.addToQueue({ itemId: "plex:9" });
  const { state } = await plane.services.play({ queueItemId: item.id });
  assert.equal(state.item.source.ratingKey, "9");
  assert.equal((await plane.services.listQueue()).length, 0);
});

test("play resumes from history unless start_at is given", async () => {
  const plane = createTestControlPlane();
  await plane.services.play({ itemId: "plex:9" });
  plane.db.raw.prepare("UPDATE history SET position = 120").run();
  await plane.services.play({ itemId: "plex:9" });
  let prepare = plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").at(-1);
  assert.equal(prepare.body.startTime, 120);
  await plane.services.play({ itemId: "plex:9", startAt: 0 });
  prepare = plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").at(-1);
  assert.equal(prepare.body.startTime, 0);
});

test("play requires exactly one reference and rejects guessed ids", async () => {
  const plane = createTestControlPlane();
  await assert.rejects(plane.services.play({}), { code: "invalid_request" });
  await assert.rejects(plane.services.play({ url: "https://a.test", itemId: "plex:1" }), { code: "invalid_request" });
  await assert.rejects(plane.services.play({ itemId: "The Matrix" }), /search or browse/);
});

test("search resolves URLs through node metadata", async () => {
  const plane = createTestControlPlane();
  const { results } = await plane.services.search({ query: "https://youtu.be/abc" });
  assert.equal(results[0].kind, "url");
  assert.equal(results[0].title, "A video");
  const library = await plane.services.search({ query: "Alien", type: "movie" });
  assert.equal(library.results[0].id, "plex:42");
  assert.deepEqual(plane.node.calls.at(-1).query, { q: "Alien", type: "movie", limit: 20 });
});

test("playlist import creates a playlist and can enqueue it", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["POST /internal/v1/playlists/expand"] = () => ({
    title: "Mix",
    items: [
      { source: { kind: "url", url: "https://example.com/1" }, title: "One", duration: 60 },
      { source: { kind: "url", url: "https://example.com/2" }, title: "Two", duration: 60 },
    ],
  });
  const result = await plane.services.importPlaylist({ url: "https://example.com/list", enqueue: true });
  assert.equal(result.playlist.name, "Mix");
  assert.equal(result.imported, 2);
  assert.equal(result.queued, 2);
  const enqueued = await plane.services.enqueuePlaylist(result.playlist.id, { position: "next" });
  assert.equal(enqueued.added, 2);
  assert.deepEqual(enqueued.queue.map((item) => item.title), ["One", "Two", "One", "Two"]);
});
