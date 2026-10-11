import assert from "node:assert/strict";
import { test } from "node:test";
import { listHistory } from "../../src/store/history.js";
import { listQueue } from "../../src/store/queue.js";
import { getPlaylist } from "../../src/store/playlists.js";
import { applyMigration, createTestD1 } from "../helpers/d1.js";
import { createDefaultNode } from "../helpers/fakes.js";
import { createTestControlPlane, USER } from "../helpers/setup.js";

// D1 migration 0003 rewrites rows saved before source plugins. Those rows
// name the two kinds that became the official Plex and yt-dlp plugins, so
// this test does too.

const MIGRATION = "0003_plugin_sources.sql";
const PLEX = JSON.stringify({ kind: "plex", ratingKey: "9896" });
const VIDEO_URL = "https://youtu.be/abc?si=share";
const VIDEO = JSON.stringify({ kind: "url", url: VIDEO_URL });
const CANONICAL = "https://youtube.com/watch?v=abc";

function legacyDatabase() {
  const db = createTestD1({ before: MIGRATION });
  const run = (sql, ...params) => db.raw.prepare(sql).run(...params);
  run("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, 'Owner', 0)", USER, USER);
  const item = "INSERT INTO queue_items (id, user_id, source, title, metadata, position, added_at) VALUES (?, ?, ?, ?, '{}', ?, 0)";
  run(item, "itm_plex", USER, PLEX, "Movie", 1);
  run(item, "itm_video", USER, VIDEO, "Video", 2);
  run("INSERT INTO playlists (id, user_id, name, created_at, updated_at) VALUES ('pl_1', ?, 'Trip', 0, 0)", USER);
  const listed = "INSERT INTO playlist_items (id, user_id, playlist_id, source, title, metadata, position, added_at) VALUES (?, ?, 'pl_1', ?, ?, '{}', ?, 0)";
  run(listed, "pli_plex", USER, PLEX, "Movie", 1);
  run(listed, "pli_video", USER, VIDEO, "Video", 2);
  const history = "INSERT INTO history (user_id, source_key, source, title, position, duration, updated_at) VALUES (?, ?, ?, ?, ?, 7200, ?)";
  run(history, USER, "plex:9896", PLEX, "Movie", 120, 2);
  run(history, USER, `url:${CANONICAL}`, VIDEO, "Video", 300, 1);
  const preference = "INSERT INTO track_preferences (user_id, source_key, selection, updated_at) VALUES (?, ?, ?, 0)";
  const zh = JSON.stringify({ subtitles: [{ id: "plex:7", language: "zh", name: "简体", format: "text" }], audio: null });
  run(preference, USER, "plex:9896", zh);
  run(preference, USER, `url:${CANONICAL}`, JSON.stringify({ subtitles: [{ id: "s_en", language: "en", name: "", format: "text" }], audio: null }));
  run(preference, USER, "default", zh);
  return db;
}

// A node with the official plugins' answers: the yt-dlp source claims URLs
// with the canonical URL as the id.
function officialNode() {
  const node = createDefaultNode();
  const canonical = (url) => (url.includes("abc") ? CANONICAL : url);
  node.routes["POST /internal/v1/claim"] = ({ url }) => ({ source: { plugin: "ytdlp", id: canonical(url), url } });
  return node;
}

test("migration 0003 turns pre-plugin rows into plugin sources and keeps their keys", async () => {
  const db = legacyDatabase();
  applyMigration(db.raw, MIGRATION);

  assert.deepEqual((await listQueue(db, USER)).map((item) => item.source), [{ plugin: "plex", id: "9896" }, { url: VIDEO_URL }]);
  assert.deepEqual((await getPlaylist(db, USER, "pl_1")).items.map((item) => item.source), [{ plugin: "plex", id: "9896" }, { url: VIDEO_URL }]);
  assert.deepEqual((await listHistory(db, USER)).map((entry) => [entry.sourceKey, entry.source, entry.position]), [
    ["plex:9896", { plugin: "plex", id: "9896" }, 120],
    [`ytdlp:${CANONICAL}`, { plugin: "ytdlp", id: CANONICAL, url: VIDEO_URL }, 300],
  ]);
  assert.deepEqual(db.raw.prepare("SELECT source_key FROM track_preferences ORDER BY source_key").all().map((row) => row.source_key), [
    "default", "plex:9896", `ytdlp:${CANONICAL}`,
  ]);
});

test("after the migration, resume, preferences, queue and history all work", async () => {
  const db = legacyDatabase();
  applyMigration(db.raw, MIGRATION);
  const plane = createTestControlPlane({ db, node: officialNode() });
  const prepares = () => plane.node.calls.filter((call) => call.path === "/internal/v1/prepare");

  // Library item ids are unchanged, and resume from the migrated history.
  await plane.services.play({ itemId: "plex:9896" });
  assert.equal(prepares().at(-1).body.startTime, 120);
  assert.equal(prepares().at(-1).body.tracks.preferences.saved.subtitles[0].id, "plex:7");

  // A URL that the plugin canonicalises to the migrated id resumes as well.
  await plane.services.play({ url: "https://www.youtube.com/watch?v=abc&t=5" });
  assert.equal(prepares().at(-1).body.startTime, 300);
  assert.equal(prepares().at(-1).body.tracks.preferences.saved.subtitles[0].id, "s_en");

  // Queue items: the Plex row plays as is, the URL row is claimed first.
  await plane.services.control("next");
  assert.deepEqual(prepares().at(-1).body.source, { plugin: "plex", id: "9896" });
  await plane.services.control("next");
  assert.deepEqual(prepares().at(-1).body.source, { plugin: "ytdlp", id: CANONICAL, url: VIDEO_URL });

  const history = await listHistory(plane.db, USER);
  assert.deepEqual(Object.fromEntries(history.map((entry) => [entry.sourceKey, entry.playCount])), { [`ytdlp:${CANONICAL}`]: 3, "plex:9896": 3 });
  await plane.services.control("previous");
  assert.deepEqual(prepares().at(-1).body.source, { plugin: "plex", id: "9896" });
});

test("without the migration, an old row fails with a pointer to it", async () => {
  const plane = createTestControlPlane({ db: legacyDatabase(), node: officialNode() });
  await assert.rejects(plane.services.control("next"), /migration 0003/);
});
