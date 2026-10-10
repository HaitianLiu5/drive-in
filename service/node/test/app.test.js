import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { createLegacyBridge } from "../src/legacy.js";
import { createPlex, itemFromMetadata, tracksFromPart } from "../src/plex.js";
import { describeInfo, playlistFromInfo, subtitleTracks } from "../src/ytdlp.js";

const secret = "node-test-secret";

// A fake Drive-In server (server/) answering the legacy API.
function fakeLegacy() {
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

function createApp(overrides = {}) {
  const legacy = fakeLegacy();
  const app = createNodeApp({
    secret,
    legacy: legacy.bridge,
    plex: createPlex({ url: null, token: null }),
    ytdlp: {
      info: async (url) => ({ title: `Info ${url}`, duration: 61.5, subtitles: { en: [{ name: "English" }] }, automatic_captions: { "zh-Hans": [{}], fr: [{}] } }),
      flatPlaylist: async () => ({ title: "Mix", entries: [{ id: "a1", ie_key: "Youtube", title: "One" }, { title: "No url" }] }),
      version: async () => "2026.09.01",
    },
    ...overrides,
  });
  return { app, legacy };
}

async function call(app, method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signNodeRequest(secret, { method, path, body: payload });
  return app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
}

test("unsigned and mis-signed requests are rejected", async () => {
  const { app } = createApp();
  assert.equal((await app.request("/internal/v1/health")).status, 401);
  const headers = await signNodeRequest("wrong", { method: "GET", path: "/internal/v1/health" });
  assert.equal((await app.request("/internal/v1/health", { headers })).status, 401);
  assert.equal((await call(app, "GET", "/internal/v1/health")).status, 200);
});

test("health reports the legacy player, library, and yt-dlp", async () => {
  const { app } = createApp();
  const health = await (await call(app, "GET", "/internal/v1/health")).json();
  assert.equal(health.legacy.playerConnected, true);
  assert.equal(health.library.configured, false);
  assert.equal(health.ytdlp.version, "2026.09.01");
});

test("prepare on the legacy renderer starts playback and tracks the session", async () => {
  const { app, legacy } = createApp();
  const response = await call(app, "POST", "/internal/v1/prepare", {
    sessionId: "ses_1", source: { kind: "plex", ratingKey: "42" }, startTime: 90, reason: "play", renderer: "legacy",
  });
  const descriptor = await response.json();
  assert.equal(descriptor.delivery.type, "external");
  assert.deepEqual(legacy.calls.at(-1).body, { ratingKey: "42", offset: 90_000, reason: "play" });

  const { renderers } = await (await call(app, "GET", "/internal/v1/renderers")).json();
  assert.equal(renderers[0].playback.sessionId, "ses_1");
  assert.equal(renderers[0].playback.status, "playing");

  await call(app, "POST", "/internal/v1/sessions/ses_1/control", { action: "seek", position: 120 });
  assert.equal(legacy.calls.at(-1).body.offset, 120_000);
  await call(app, "POST", "/internal/v1/sessions/ses_1/stop", {});
  assert.deepEqual(legacy.calls.at(-1).body, { action: "stop" });
});

test("prepare refuses realtime renderers until the pipeline moves here", async () => {
  const { app } = createApp();
  const response = await call(app, "POST", "/internal/v1/prepare", {
    sessionId: "ses_2", source: { kind: "url", url: "https://example.com/v" }, renderer: null,
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "resolve_failed");
});

test("URL subtitle selection maps track ids to languages", async () => {
  const { app, legacy } = createApp();
  await call(app, "POST", "/internal/v1/prepare", {
    sessionId: "ses_3", source: { kind: "url", url: "https://example.com/v" }, renderer: "legacy",
  });
  const response = await call(app, "POST", "/internal/v1/sessions/ses_3/tracks", {
    source: { kind: "url", url: "https://example.com/v" }, subtitles: ["s_en"],
  });
  const result = await response.json();
  assert.deepEqual(legacy.calls.find((entry) => entry.path === "/api/subtitles/select").body, { langs: ["en"], sourceUrl: "https://example.com/v" });
  assert.deepEqual(result.tracks.subtitles.map((track) => track.id), ["s_en", "s_zh-Hans"]);
});

test("metadata and playlist expansion use yt-dlp output", async () => {
  const { app } = createApp();
  const metadata = await (await call(app, "POST", "/internal/v1/metadata", { source: { kind: "url", url: "https://example.com/v" } })).json();
  assert.deepEqual(metadata, { title: "Info https://example.com/v", thumbnail: null, duration: 61, isLive: false });
  const playlist = await (await call(app, "POST", "/internal/v1/playlists/expand", { url: "https://example.com/list" })).json();
  assert.equal(playlist.items.length, 1);
  assert.equal(playlist.items[0].source.url, "https://www.youtube.com/watch?v=a1");
});

test("library calls fail clearly when Plex is not configured", async () => {
  const { app } = createApp();
  const response = await call(app, "GET", "/internal/v1/library");
  assert.equal(response.status, 404);
  assert.match((await response.json()).error.message, /PLEX_URL/);
});

test("Plex metadata maps to provider-neutral items and tracks", () => {
  const episode = itemFromMetadata({ ratingKey: "7", type: "episode", grandparentTitle: "Show", parentIndex: 1, index: 2, title: "Pilot", duration: 1_800_000, viewOffset: 60_000 });
  assert.equal(episode.id, "plex:7");
  assert.equal(episode.title, "Show S1E2 — Pilot");
  assert.equal(episode.duration, 1800);
  assert.equal(episode.resumeAt, 60);
  assert.match(episode.thumbnail, /^\/v1\/library\/items\/plex%3A7\/artwork\?variant=landscape$/);
  const tracks = tracksFromPart({ Stream: [
    { id: 1, streamType: 2, language: "English", languageCode: "eng", displayTitle: "English (AAC)", selected: true },
    { id: 2, streamType: 3, codec: "srt", languageCode: "chi", displayTitle: "Chinese" },
    { id: 3, streamType: 3, codec: "pgs", languageCode: "eng", displayTitle: "English (PGS)" },
  ] });
  assert.deepEqual(tracks.audio.map((track) => [track.id, track.default]), [["plex:1", true]]);
  assert.deepEqual(tracks.subtitles.map((track) => [track.id, track.format]), [["plex:2", "text"], ["plex:3", "image"]]);
});

test("yt-dlp helpers", () => {
  assert.deepEqual(describeInfo({ fulltitle: "T", thumbnails: [{ url: "a" }, { url: "b" }], is_live: true }), {
    title: "T", thumbnail: "b", duration: null, isLive: true,
  });
  assert.deepEqual(subtitleTracks({ subtitles: { live_chat: [{}], ja: [{ name: "Japanese" }] } }).map((track) => track.id), ["s_ja"]);
  assert.equal(playlistFromInfo({}, "u").items.length, 0);
});
