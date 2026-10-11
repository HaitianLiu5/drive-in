import assert from "node:assert/strict";
import { test } from "node:test";
import { listHistory } from "../../src/store/history.js";
import { webSource } from "../helpers/fakes.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

// Sources are plugin-owned (decision 21): the control plane never decides
// which source a URL belongs to; it asks the node to claim it.

const claims = (plane) => plane.node.calls.filter((call) => call.path === "/internal/v1/claim");

test("a URL added while the node is online is stored as the claiming plugin's source", async () => {
  const plane = createTestControlPlane();
  const { item } = await plane.services.addToQueue({ url: "https://Video.test/A" });
  assert.deepEqual(item.source, webSource("https://Video.test/A"));
  assert.equal(item.title, "A video");
});

test("a URL queued offline stays unclaimed and is claimed when it plays", async () => {
  const plane = createTestControlPlane();
  plane.node.offline = true;
  const { item } = await plane.services.addToQueue({ url: "https://video.test/a" });
  assert.deepEqual(item.source, { url: "https://video.test/a" });
  plane.node.offline = false;

  const { state } = await plane.services.play({ queueItemId: item.id });
  assert.deepEqual(state.item.source, webSource("https://video.test/a"));
  assert.equal(claims(plane).length, 1);
  const prepare = plane.node.calls.find((call) => call.path === "/internal/v1/prepare");
  assert.deepEqual(prepare.body.source, webSource("https://video.test/a"));
  assert.equal((await listHistory(plane.db, USER))[0].sourceKey, "web:https://video.test/a");
});

test("playing a URL claims it first, so history and resume use the plugin's key", async () => {
  const plane = createTestControlPlane();
  await plane.services.play({ url: "https://video.test/a" });
  plane.db.raw.prepare("UPDATE history SET position = 75").run();
  // Another spelling the plugin maps to the same id resumes the same entry.
  await plane.services.play({ url: "https://VIDEO.test/a" });
  const prepare = plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").at(-1);
  assert.equal(prepare.body.startTime, 75);
  assert.equal((await listHistory(plane.db, USER)).length, 1);
});

test("an unclaimable URL fails without touching the queue", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["POST /internal/v1/claim"] = () => {
    throw Object.assign(new Error("No source plugin on the media node handles this URL"), { code: "not_found" });
  };
  await assert.rejects(plane.services.play({ url: "https://video.test/a" }), { code: "not_found" });
  plane.node.routes["POST /internal/v1/metadata"] = plane.node.routes["POST /internal/v1/claim"];
  await assert.rejects(plane.services.addToQueue({ url: "https://video.test/a" }), { code: "not_found" });
  assert.deepEqual(await plane.services.listQueue(), []);
});

test("list_tracks by URL claims the URL", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/tracks"] = (query) => ({ subtitles: [{ id: "s_en", source: JSON.parse(query.source) }], audio: [] });
  const tracks = await plane.services.listTracks({ itemId: "https://video.test/a" });
  assert.deepEqual(tracks.source, webSource("https://video.test/a"));
  assert.deepEqual(tracks.subtitles[0].source, webSource("https://video.test/a"));
});

test("a playback state saved before source plugins reads as stopped", async () => {
  const plane = createTestControlPlane();
  await plane.storage.put("state", {
    status: "playing", deviceId: "node:legacy", item: { source: { kind: "old", ratingKey: "1" }, title: "Old" },
    position: 10, positionAt: 1, tracks: { subtitles: [], audio: null }, sessionId: "ses_old",
  });
  const state = await plane.hub.getState();
  assert.deepEqual([state.status, state.item, state.deviceId], ["idle", null, "node:legacy"]);
  await assert.rejects(plane.hub.control("pause"), /Nothing is playing/);
});

test("history deletion takes a source key", async () => {
  const plane = createTestControlPlane();
  await plane.services.play({ itemId: "library:9" });
  await assert.rejects(plane.services.deleteHistory({ sourceKey: "nine" }), { code: "invalid_request" });
  assert.deepEqual(await plane.services.deleteHistory({ sourceKey: "library:9" }), { deleted: 1 });
});
