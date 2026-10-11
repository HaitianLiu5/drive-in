import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import Database from "better-sqlite3";
import { buildImportSql } from "../src/import-legacy.js";
import { createLegacyBridge, preferenceFromDriveIn, thumbnailFromDriveIn } from "../src/legacy.js";

// The Drive-In bridge is temporary (0.3 deletes it with server/). It and this
// test are the only code in service/ that names the official source plugins:
// the Drive-In server plays Plex items through its Plex routes and anything
// else by URL.

const plexItem = (id) => ({ plugin: "plex", id });
const webVideo = (url) => ({ plugin: "ytdlp", id: url, url });

// A fake Drive-In server (server/) answering the legacy API.
function fakeDriveIn() {
  const calls = [];
  const state = { status: "idle", url: null, title: null, playerConnected: true, player: { currentTime: 0 } };
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: pathname, body });
    if (pathname === "/api/status") return Response.json(state);
    if (pathname === "/api/play") {
      Object.assign(state, { status: "playing", url: body.url, title: "A video" });
      return Response.json({ ok: true, title: "A video", isLive: false });
    }
    if (pathname === "/api/plex/play") {
      Object.assign(state, { status: "playing", url: `plex://${body.ratingKey}`, title: "Movie" });
      return Response.json({ ok: true, title: "Movie" });
    }
    if (pathname === "/api/control") {
      if (body.action === "stop") Object.assign(state, { status: "idle", url: null });
      return Response.json({ ok: true });
    }
    if (pathname === "/api/subtitles/select") return Response.json({ ok: true });
    return Response.json({ error: "nope" }, { status: 404 });
  };
  return { calls, state, bridge: createLegacyBridge({ baseUrl: "http://legacy.test", fetchImpl }) };
}

test("a Plex item plays through Drive-In's Plex route and is tracked as a session", async () => {
  const { bridge, calls } = fakeDriveIn();
  const descriptor = await bridge.prepare({ sessionId: "ses_1", source: plexItem("42"), startTime: 90, reason: "play" });
  assert.equal(descriptor.delivery.type, "external");
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/api/plex/play", body: { ratingKey: "42", offset: 90_000, reason: "play" } });

  const [renderer] = await bridge.renderers();
  assert.deepEqual([renderer.playback.sessionId, renderer.playback.status], ["ses_1", "playing"]);

  await bridge.control("ses_1", { action: "seek", position: 120 });
  assert.equal(calls.at(-1).body.offset, 120_000);
  await bridge.stop("ses_1");
  assert.deepEqual(calls.at(-1).body, { action: "stop" });
});

test("a web video plays by the URL as given, and its subtitles map to languages", async () => {
  const { bridge, calls } = fakeDriveIn();
  const source = webVideo("https://example.com/v?ref=1");
  await bridge.prepare({ sessionId: "ses_2", source, startTime: 0, reason: "transfer" });
  assert.deepEqual(calls.at(-1).body, { url: "https://example.com/v?ref=1", startTime: 0, reason: "play" });
  assert.equal((await bridge.renderers())[0].playback.sessionId, "ses_2");
  await bridge.setTracks("ses_2", { subtitles: ["s_en", "s_zh-Hans"] });
  assert.deepEqual(calls.at(-1).body, { langs: ["en", "zh-Hans"], sourceUrl: "https://example.com/v?ref=1" });
  await assert.rejects(bridge.setTracks("ses_2", { audio: "a1" }), { code: "invalid_request" });
});

test("Plex track changes restart the transcode at the current position", async () => {
  const { bridge, calls, state } = fakeDriveIn();
  await bridge.prepare({ sessionId: "ses_3", source: plexItem("42"), startTime: 0, reason: "play" });
  state.player.currentTime = 33;
  await bridge.setTracks("ses_3", { subtitles: ["plex:7"], audio: "plex:2" });
  assert.deepEqual(calls.at(-1).body, { ratingKey: "42", offset: 33_000, reason: "seek", subtitleStreamID: "7", audioStreamID: "2" });
});

test("a source Drive-In cannot play is refused", async () => {
  const { bridge } = fakeDriveIn();
  await assert.rejects(bridge.prepare({ sessionId: "ses_4", source: { plugin: "folder", id: "a.mkv" }, startTime: 0 }), {
    code: "resolve_failed", message: /cannot play folder items/,
  });
});

test("a disconnected player's stale status is reported as idle", async () => {
  const { bridge, state } = fakeDriveIn();
  // Drive-In keeps the last session's status after the car disconnects.
  Object.assign(state, {
    status: "playing", url: "plex://9", title: "Movie", playerConnected: false, player: { currentTime: 1789, duration: 3600 },
  });
  assert.deepEqual(await bridge.health(), { online: true, playerConnected: false, status: "idle" });
  const [renderer] = await bridge.renderers();
  assert.equal(renderer.online, false);
  assert.deepEqual(
    { status: renderer.playback.status, title: renderer.playback.title, position: renderer.playback.position },
    { status: "idle", title: "Movie", position: 1789 },
  );
});

// --- One-time export of Drive-In data -------------------------------------

const MIGRATIONS_DIR = new URL("../../control/migrations/", import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));

// What the official yt-dlp plugin answers: the canonical URL as the id.
const claim = async (url) => {
  if (url.includes("unclaimable")) throw new Error("No source plugin on the media node handles this URL");
  return webVideo(url.replace("www.", "").replace(/[?&]t=\d+/, ""));
};

test("the generated SQL loads into the D1 schema with plugin sources", async () => {
  const { sql, skipped } = await buildImportSql({
    userId: "usr_owner",
    now: 1_000,
    claim,
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
      { title: "Lost", url: "https://unclaimable.test/v", playedAt: 6 },
      { title: "Broken", url: null },
    ],
    preferences: [
      { source: "default", selection: JSON.stringify([{ id: "en", language: "en", title: "English", delivery: "external" }]) },
      { source: "plex:42", selection: JSON.stringify([]) },
      { source: "https://www.youtube.com/watch?v=abc", selection: JSON.stringify([{ id: "zh", language: "zh" }]) },
      { source: "not a url", selection: "[]" },
    ],
  });
  assert.deepEqual(skipped, ["https://unclaimable.test/v: No source plugin on the media node handles this URL"]);
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  db.exec(sql);
  const queue = db.prepare("SELECT * FROM queue_items ORDER BY position").all();
  assert.deepEqual(queue.map((row) => [row.title, JSON.parse(row.source), row.thumbnail]), [
    ["It's a video", { url: "https://youtu.be/abc" }, "https://i.ytimg.com/x.jpg"],
    ["Movie", plexItem("42"), "/v1/library/items/plex%3A42/artwork?variant=landscape"],
  ]);
  const history = db.prepare("SELECT * FROM history ORDER BY updated_at DESC").all();
  assert.deepEqual(history.map((row) => [row.source_key, row.position, row.play_count]), [
    ["plex:42", 120, 1],
    ["ytdlp:https://youtube.com/watch?v=abc", 0, 2],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = 'pl_1'").get().n, 1);
  assert.deepEqual(db.prepare("SELECT source_key FROM track_preferences ORDER BY source_key").all().map((row) => row.source_key), [
    "default", "plex:42", "ytdlp:https://youtube.com/watch?v=abc",
  ]);
});

test("Drive-In thumbnails and preferences map to Yolo's", async () => {
  assert.equal(thumbnailFromDriveIn("https://x.test/a.jpg", { url: "https://x.test/v" }), "https://x.test/a.jpg");
  assert.equal(thumbnailFromDriveIn("/weird", { url: "https://x.test/v" }), null);
  const preference = preferenceFromDriveIn({ source: "plex:1", selection: JSON.stringify([{ id: "123", language: "zh", title: "简体", delivery: "burn-in" }]) });
  assert.deepEqual(preference.ref, plexItem("1"));
  assert.deepEqual(preference.selection.subtitles[0], { id: "plex:123", language: "zh", name: "简体", format: "image" });
  assert.equal(preferenceFromDriveIn({ source: "default", selection: "{" }), null);
  await assert.rejects(buildImportSql({ userId: "root'; DROP TABLE users", claim }), /user id/);
});
