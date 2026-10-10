import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMIT } from "@useyolo/core";
import { createTestD1 } from "../helpers/d1.js";
import * as queue from "../../src/store/queue.js";
import * as playlists from "../../src/store/playlists.js";
import * as history from "../../src/store/history.js";
import { getTrackPreferences, saveTrackPreferences } from "../../src/store/preferences.js";

const user = "usr_a";
const other = "usr_b";
const video = (n) => ({ source: { kind: "url", url: `https://example.com/v/${n}` }, title: `Video ${n}` });

test("queue keeps order for next and end, scoped by user", async () => {
  const db = createTestD1();
  await queue.addQueueItems(db, user, [video(1), video(2)]);
  await queue.addQueueItems(db, user, [video(3), video(4)], { position: "next" });
  await queue.addQueueItems(db, other, [video(9)]);
  assert.deepEqual((await queue.listQueue(db, user)).map((item) => item.title), ["Video 3", "Video 4", "Video 1", "Video 2"]);
  assert.equal((await queue.listQueue(db, other)).length, 1);

  const head = await queue.shiftQueue(db, user);
  assert.equal(head.title, "Video 3");
  const [first] = await queue.listQueue(db, user);
  await queue.removeQueueItem(db, user, first.id);
  const remaining = await queue.listQueue(db, user);
  const reordered = await queue.reorderQueue(db, user, [remaining[1].id]);
  assert.deepEqual(reordered.map((item) => item.title), ["Video 2", "Video 1"]);
  assert.equal(await queue.clearQueue(db, user), 2);
  assert.equal((await queue.listQueue(db, other)).length, 1);
});

test("queue rejects bad positions and unknown ids", async () => {
  const db = createTestD1();
  await assert.rejects(queue.addQueueItems(db, user, [video(1)], { position: "middle" }), { code: "invalid_request" });
  await assert.rejects(queue.removeQueueItem(db, user, "itm_missing"), { code: "not_found" });
  await assert.rejects(queue.reorderQueue(db, user, ["itm_missing"]), { code: "invalid_request" });
});

test("playlists hold ordered items and delete cleanly", async () => {
  const db = createTestD1();
  const created = await playlists.createPlaylist(db, user, { name: " Road trip " });
  assert.equal(created.name, "Road trip");
  const { added } = await playlists.addPlaylistItems(db, user, created.id, [video(1), { ...video(2), duration: 90 }]);
  assert.equal(added.length, 2);
  const listed = await playlists.listPlaylists(db, user);
  assert.equal(listed[0].itemCount, 2);
  assert.equal(listed[0].duration, 90);
  const reordered = await playlists.reorderPlaylist(db, user, created.id, [added[1].id]);
  assert.deepEqual(reordered.items.map((item) => item.title), ["Video 2", "Video 1"]);
  await playlists.removePlaylistItem(db, user, created.id, added[0].id);
  await playlists.deletePlaylist(db, user, created.id);
  await assert.rejects(playlists.getPlaylist(db, user, created.id), { code: "not_found" });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM playlist_items").get().n, 0);
  await assert.rejects(playlists.getPlaylist(db, other, created.id), { code: "not_found" });
});

test("history upserts by source key and keeps the newest 500", async () => {
  const db = createTestD1();
  await history.recordPlay(db, user, { source: { kind: "url", url: "https://youtu.be/abc" }, title: "A" });
  await history.recordPlay(db, user, { source: { kind: "url", url: "https://www.youtube.com/watch?v=abc" }, title: "A again" });
  let entries = await history.listHistory(db, user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].playCount, 2);
  assert.equal(entries[0].title, "A again");

  const insert = db.raw.prepare("INSERT INTO history (user_id, source_key, source, title, updated_at) VALUES (?, ?, '{}', 't', ?)");
  db.raw.transaction(() => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) insert.run(user, `plex:${i}`, i);
  })();
  await history.recordPlay(db, user, { source: { kind: "plex", ratingKey: "new" }, title: "New" });
  entries = await history.listHistory(db, user, { limit: 1000 });
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries[0].sourceKey, "plex:new");
  assert.equal(await history.deleteHistory(db, user, "plex:new"), 1);
  assert.equal(await history.deleteHistory(db, user), HISTORY_LIMIT - 1);
});

test("track preferences store a default row alongside the source row", async () => {
  const db = createTestD1();
  await saveTrackPreferences(db, user, "plex:1", { subtitles: [{ id: "s1", language: "en", name: "", format: "text" }], audio: null });
  const same = await getTrackPreferences(db, user, "plex:1");
  const otherSource = await getTrackPreferences(db, user, "plex:2");
  assert.equal(same.saved.subtitles[0].id, "s1");
  assert.equal(otherSource.saved, null);
  assert.equal(otherSource.fallback.subtitles[0].language, "en");
});
