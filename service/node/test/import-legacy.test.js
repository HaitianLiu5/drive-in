import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { buildImportSql, migratePreference, migrateThumbnail } from "../src/import-legacy.js";

const migration = readFileSync(new URL("../../control/migrations/0001_init.sql", import.meta.url), "utf8");

test("the generated SQL loads into the D1 schema", () => {
  const sql = buildImportSql({
    userId: "usr_owner",
    now: 1_000,
    queue: [
      { id: "q_1", source_type: "url", url: "https://youtu.be/abc", title: "It's a video", thumbnail: "/api/thumb?url=https%3A%2F%2Fi.ytimg.com%2Fx.jpg", duration: 60, metadata: "{}", position: 3, added_at: 5 },
      { id: "q_2", source_type: "plex", rating_key: "42", title: "Movie", thumbnail: "/api/plex/thumb?path=x", position: 4, added_at: 6 },
    ],
    playlists: [{ id: "pl_1", name: "Trip", description: null, created_at: 1, updated_at: 2 }],
    playlistItems: [{ id: "pi_1", playlist_id: "pl_1", source_type: "url", url: "https://example.com/a", title: "A", metadata: "{}", added_at: 7 }],
    history: [
      { title: "Movie", plex: { ratingKey: "42" }, progress: 120, duration: 6000, playedAt: 9 },
      { title: "Dup", plex: { ratingKey: "42" }, playedAt: 8 },
      { title: "Zoo", url: "https://www.youtube.com/watch?v=abc&t=3", viewCount: 2, playedAt: 7 },
      { title: "Broken", url: null },
    ],
    preferences: [
      { source: "default", selection: JSON.stringify([{ id: "en", language: "en", title: "English", delivery: "external" }]) },
      { source: "plex:42", selection: JSON.stringify([]) },
      { source: "not a url", selection: "[]" },
    ],
  });
  const db = new Database(":memory:");
  db.exec(migration);
  db.exec(sql);
  const queue = db.prepare("SELECT * FROM queue_items ORDER BY position").all();
  assert.deepEqual(queue.map((row) => [row.title, JSON.parse(row.source).kind, row.thumbnail]), [
    ["It's a video", "url", "https://i.ytimg.com/x.jpg"],
    ["Movie", "plex", "/v1/library/items/plex%3A42/artwork?variant=landscape"],
  ]);
  const history = db.prepare("SELECT * FROM history ORDER BY updated_at DESC").all();
  assert.deepEqual(history.map((row) => [row.source_key, row.position, row.play_count]), [
    ["plex:42", 120, 1],
    ["url:https://youtube.com/watch?v=abc", 0, 2],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = 'pl_1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM track_preferences").get().n, 2);
});

test("helpers map thumbnails and preferences", () => {
  assert.equal(migrateThumbnail("https://x.test/a.jpg", { kind: "url" }), "https://x.test/a.jpg");
  assert.equal(migrateThumbnail("/weird", { kind: "url" }), null);
  assert.deepEqual(migratePreference([{ id: "123", language: "zh", title: "简体", delivery: "burn-in" }], "plex:1").subtitles[0], {
    id: "plex:123", language: "zh", name: "简体", format: "image",
  });
  assert.throws(() => buildImportSql({ userId: "root'; DROP TABLE users" }), /user id/);
});
