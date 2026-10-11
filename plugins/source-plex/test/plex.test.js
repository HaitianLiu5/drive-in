import assert from "node:assert/strict";
import { test } from "node:test";
import { YoloError } from "@useyolo/plugin-api";
import plexPlugin, { SOURCE_ID } from "../src/node.js";
import { createPlex, itemFromMetadata, tracksFromPart } from "../src/plex.js";

// Just enough of the node's plugin API to run the factory and its handlers.
function fakeYolo({ options = {}, env = {} } = {}) {
  const sources = new Map();
  const handlers = { start: [], shutdown: [] };
  const warnings = [];
  const yolo = {
    plugin: { name: "@useyolo/source-plex", version: "0.2.0" },
    options,
    env,
    log: { debug() {}, info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} },
    registerSource: (id, impl) => sources.set(id, impl),
    on: (event, handler) => handlers[event].push(handler),
  };
  return {
    yolo,
    sources,
    warnings,
    start: async () => {
      for (const handler of handlers.start) await handler();
    },
  };
}

function fakePlex(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    seen.push({ path: pathname + search, token: init.headers["x-plex-token"] });
    const route = routes[pathname];
    return route ? Response.json(route) : new Response("", { status: 404 });
  };
  return { seen, plex: createPlex({ url: "http://plex.test:32400", token: "t0k", fetchImpl }) };
}

test("Plex metadata maps to library items with local ids and artwork variants", () => {
  const episode = itemFromMetadata({ ratingKey: "7", type: "episode", grandparentTitle: "Show", parentIndex: 1, index: 2, title: "Pilot", duration: 1_800_000, viewOffset: 60_000 });
  assert.equal(episode.id, "7");
  assert.equal(episode.title, "Show S1E2 — Pilot");
  assert.equal(episode.duration, 1800);
  assert.equal(episode.resumeAt, 60);
  assert.equal(episode.artwork, "landscape");
  assert.deepEqual([episode.season, episode.episode], [1, 2]);
  const show = itemFromMetadata({ ratingKey: 8, type: "show", title: "Show", leafCount: 10, viewedLeafCount: 3 });
  assert.deepEqual([show.id, show.artwork, show.episodes, show.watchedEpisodes], ["8", "poster", 10, 3]);
});

test("Plex streams map to subtitle and audio tracks", () => {
  const tracks = tracksFromPart({ Stream: [
    { id: 1, streamType: 2, language: "English", languageCode: "eng", displayTitle: "English (AAC)", selected: true },
    { id: 2, streamType: 3, codec: "srt", languageCode: "chi", displayTitle: "Chinese" },
    { id: 3, streamType: 3, codec: "pgs", languageCode: "eng", displayTitle: "English (PGS)" },
  ] });
  assert.deepEqual(tracks.audio.map((track) => [track.id, track.default]), [["plex:1", true]]);
  assert.deepEqual(tracks.subtitles.map((track) => [track.id, track.format]), [["plex:2", "text"], ["plex:3", "image"]]);
});

test("the client searches, lists, and describes through the Plex API", async () => {
  const { plex, seen } = fakePlex({
    "/hubs/search": { MediaContainer: { Hub: [{ Metadata: [{ ratingKey: "42", type: "movie", title: "Alien", year: 1979 }, { ratingKey: "9", type: "artist", title: "Band" }] }] } },
    "/library/sections": { MediaContainer: { Directory: [{ key: 1, title: "Movies", type: "movie" }] } },
    "/library/metadata/42": { MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Alien", duration: 7_020_000 }] } },
  });
  assert.deepEqual((await plex.search("Alien", { limit: 5 })).map((item) => [item.id, item.title]), [["42", "Alien"]]);
  assert.deepEqual(await plex.libraries(), [{ id: "1", title: "Movies", type: "movie" }]);
  assert.deepEqual(await plex.describe("42"), { title: "Alien", artwork: "poster", duration: 7020, isLive: false });
  assert.ok(seen.every((call) => call.token === "t0k"));
  await assert.rejects(plex.describe("../etc"), { code: "invalid_request" });
});

test("the plugin registers the plex source and reads its settings on start", async () => {
  const host = fakeYolo({ env: { PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "from-env" } });
  plexPlugin(host.yolo, { readToken: () => assert.fail("PLEX_TOKEN is set") });
  const source = host.sources.get(SOURCE_ID);
  assert.ok(source, "registers a source");
  assert.equal(source.claim, undefined, "Plex does not claim URLs");
  await assert.rejects(source.libraries(), (error) => error instanceof YoloError && /not started/.test(error.message));
  await host.start();
  assert.deepEqual(host.warnings, []);
});

test("without a token the library fails clearly and health says why", async () => {
  const host = fakeYolo();
  plexPlugin(host.yolo, { readToken: () => "" });
  await host.start();
  const source = host.sources.get(SOURCE_ID);
  assert.deepEqual(await source.health(), { configured: false });
  await assert.rejects(source.libraries(), { code: "not_found", message: /PLEX_URL, PLEX_TOKEN/ });
  assert.match(host.warnings.join("\n"), /No Plex token/);
});

test("options win over the environment", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push([new URL(url).origin, init.headers["x-plex-token"]]);
    return Response.json({});
  });
  const host = fakeYolo({ options: { url: "http://other.test:32400", token: "opt" }, env: { PLEX_URL: "http://plex.test:32400", PLEX_TOKEN: "env" } });
  plexPlugin(host.yolo);
  await host.start();
  assert.deepEqual(await host.sources.get(SOURCE_ID).health(), { configured: true, online: true });
  assert.deepEqual(seen, [["http://other.test:32400", "opt"]]);
});
