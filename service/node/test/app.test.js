import assert from "node:assert/strict";
import { test } from "node:test";
import { signNodeRequest } from "@useyolo/core";
import { createNodeApp } from "../src/app.js";
import { loadPlugins } from "../src/plugins.js";

const secret = "node-test-secret";

// Two fixture sources: a library with ids, and a URL source.
function fixturePlugin(yolo) {
  yolo.registerSource("library", {
    health: async () => ({ online: true }),
    libraries: async () => [{ id: "1", title: "Movies", type: "movie" }],
    items: async (libraryId, page) => ({ total: 1, items: [{ id: "42", kind: "movie", title: `In ${libraryId} from ${page.offset}`, artwork: "poster" }] }),
    children: async (itemId) => ({
      parent: { id: itemId, kind: "show", title: "Show", artwork: "poster" },
      items: [{ id: "7", kind: "episode", title: "Pilot", artwork: "landscape" }],
    }),
    search: async (query, options) => [{ id: "42", kind: "movie", title: `${query} (${options.type ?? "any"}, ${options.limit})`, artwork: "poster" }],
    describe: async (source) => ({ title: `Movie ${source.id}`, artwork: "poster", duration: 600 }),
    tracks: async () => ({ subtitles: [{ id: "lib:2", kind: "subtitle", language: "en", name: "English", format: "text" }], audio: [] }),
    artwork: async (itemId, variant) => new Response(`${itemId}/${variant}`, { headers: { "content-type": "image/png" } }),
  });
  yolo.registerSource("web", {
    claim: (url) => ({ id: url.toLowerCase(), url }),
    expand: async () => ({ title: "Mix", items: [{ source: { id: "https://x.test/1", url: "https://x.test/1" }, title: "One", duration: 30 }] }),
    describe: async (source) => ({ title: `Info ${source.url}`, thumbnail: "https://img.test/1.jpg", duration: 61, isLive: false }),
  });
}

// The legacy renderer (Drive-In server) is covered in legacy.test.js.
function stubLegacy() {
  const calls = [];
  return {
    calls,
    rendererId: "legacy",
    health: async () => ({ online: true, playerConnected: true, status: "idle" }),
    renderers: async () => [],
    prepare: async (input) => {
      calls.push(["prepare", input]);
      return { sessionId: input.sessionId, delivery: { type: "external", renderer: "legacy" }, title: "Playing" };
    },
    setTracks: async (sessionId, tracks) => {
      calls.push(["tracks", sessionId, tracks]);
      return { reload: null };
    },
    control: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
  };
}

async function createApp({ factories = [fixturePlugin] } = {}) {
  const plugins = await loadPlugins(factories.map((factory, index) => ({ name: `fixture-${index}`, enabled: true, options: {}, factory })));
  await plugins.start();
  const legacy = stubLegacy();
  return { app: createNodeApp({ secret, plugins, legacy }), legacy };
}

async function call(app, method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signNodeRequest(secret, { method, path, body: payload });
  const response = await app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: payload || undefined });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
}

test("unsigned and mis-signed requests are rejected", async () => {
  const { app } = await createApp();
  assert.equal((await app.request("/internal/v1/health")).status, 401);
  const headers = await signNodeRequest("wrong", { method: "GET", path: "/internal/v1/health" });
  assert.equal((await app.request("/internal/v1/health", { headers })).status, 401);
  assert.equal((await call(app, "GET", "/internal/v1/health")).status, 200);
});

test("health reports the legacy player, each source, and each plugin", async () => {
  const { app } = await createApp();
  const { body } = await call(app, "GET", "/internal/v1/health");
  assert.equal(body.version, "0.2.0");
  assert.equal(body.legacy.playerConnected, true);
  assert.deepEqual(body.sources, [{ id: "library", plugin: "fixture-0", online: true }, { id: "web", plugin: "fixture-0" }]);
  assert.deepEqual(body.plugins, [{ name: "fixture-0", version: null, source: "fixture-0", status: "started", sources: ["library", "web"] }]);
});

test("claim and metadata turn a URL into a plugin source", async () => {
  const { app } = await createApp();
  const claimed = await call(app, "POST", "/internal/v1/claim", { url: "https://X.test/V" });
  assert.deepEqual(claimed.body, { source: { plugin: "web", id: "https://x.test/v", url: "https://X.test/V" } });
  const byUrl = await call(app, "POST", "/internal/v1/metadata", { url: "https://x.test/v" });
  assert.deepEqual(byUrl.body, {
    source: { plugin: "web", id: "https://x.test/v", url: "https://x.test/v" },
    title: "Info https://x.test/v", thumbnail: "https://img.test/1.jpg", duration: 61, isLive: false,
  });
  const bySource = await call(app, "POST", "/internal/v1/metadata", { source: { plugin: "library", id: "42" } });
  assert.deepEqual(bySource.body, {
    source: { plugin: "library", id: "42" },
    title: "Movie 42", thumbnail: "/v1/library/items/library%3A42/artwork?variant=poster", duration: 600, isLive: false,
  });
});

test("unknown plugins and unsupported calls fail clearly", async () => {
  const { app } = await createApp();
  const unknown = await call(app, "POST", "/internal/v1/metadata", { source: { plugin: "gone", id: "1" } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error.message, /No source plugin "gone"/);
  const old = await call(app, "POST", "/internal/v1/metadata", { source: { kind: "old", ratingKey: "1" } });
  assert.equal(old.status, 400);
  const notSupported = await call(app, "GET", "/internal/v1/library/web:1/items");
  assert.equal(notSupported.status, 404);
  assert.match(notSupported.body.error.message, /does not support items/);
});

test("tracks come from the source; a source without tracks has none", async () => {
  const { app } = await createApp();
  const library = await call(app, "GET", `/internal/v1/tracks?source=${encodeURIComponent(JSON.stringify({ plugin: "library", id: "42" }))}`);
  assert.deepEqual(library.body.subtitles.map((track) => track.id), ["lib:2"]);
  const web = await call(app, "GET", `/internal/v1/tracks?source=${encodeURIComponent(JSON.stringify({ plugin: "web", id: "https://x.test/v" }))}`);
  assert.deepEqual(web.body, { subtitles: [], audio: [] });
});

test("playlist expansion returns plugin sources", async () => {
  const { app } = await createApp();
  const { body } = await call(app, "POST", "/internal/v1/playlists/expand", { url: "https://x.test/list" });
  assert.deepEqual(body, {
    title: "Mix",
    url: "https://x.test/list",
    items: [{ source: { plugin: "web", id: "https://x.test/1", url: "https://x.test/1" }, title: "One", thumbnail: null, duration: 30 }],
  });
});

test("library ids are namespaced by source and route back to it", async () => {
  const { app } = await createApp();
  assert.deepEqual((await call(app, "GET", "/internal/v1/library")).body, {
    libraries: [{ id: "library:1", title: "Movies", type: "movie", source: "library" }],
  });
  const items = await call(app, "GET", "/internal/v1/library/library:1/items?offset=5&limit=10");
  assert.deepEqual(items.body.items, [{ id: "library:42", kind: "movie", title: "In 1 from 5", thumbnail: "/v1/library/items/library%3A42/artwork?variant=poster" }]);
  const children = await call(app, "GET", "/internal/v1/library/items/library:9/children");
  assert.equal(children.body.parent.id, "library:9");
  assert.deepEqual(children.body.items.map((item) => [item.id, item.thumbnail]), [["library:7", "/v1/library/items/library%3A7/artwork?variant=landscape"]]);
  const search = await call(app, "GET", "/internal/v1/library/search?q=Alien&type=movie&limit=3");
  assert.deepEqual(search.body.results.map((item) => [item.id, item.title]), [["library:42", "Alien (movie, 3)"]]);
  const artwork = await call(app, "GET", "/internal/v1/library/items/library:42/artwork?variant=landscape");
  assert.deepEqual(artwork, { status: 200, body: "42/landscape" });
  assert.equal((await call(app, "GET", "/internal/v1/library/items/plain/children")).status, 400);
});

test("a failing source is reported next to the others' results", async () => {
  const { app } = await createApp({
    factories: [fixturePlugin, (yolo) => yolo.registerSource("remote", {
      search: async () => {
        throw new Error("timed out");
      },
    })],
  });
  const search = await call(app, "GET", "/internal/v1/library/search?q=Alien");
  assert.equal(search.body.results.length, 1);
  assert.deepEqual(search.body.unavailable, [{ source: "remote", error: "timed out" }]);
});

test("library calls fail clearly when no source serves a library", async () => {
  const { app } = await createApp({ factories: [(yolo) => yolo.registerSource("web", { claim: (url) => ({ id: url }) })] });
  const response = await call(app, "GET", "/internal/v1/library");
  assert.equal(response.status, 404);
  assert.match(response.body.error.message, /No library source/);
});

test("prepare plays a loaded plugin's source on the legacy renderer only", async () => {
  const { app, legacy } = await createApp();
  const source = { plugin: "web", id: "https://x.test/v", url: "https://x.test/v" };
  const played = await call(app, "POST", "/internal/v1/prepare", { sessionId: "ses_1", source, startTime: 90, reason: "play", renderer: "legacy" });
  assert.equal(played.status, 200);
  assert.deepEqual(legacy.calls.at(-1), ["prepare", { sessionId: "ses_1", source, startTime: 90, reason: "play" }]);
  const realtime = await call(app, "POST", "/internal/v1/prepare", { sessionId: "ses_2", source, renderer: null });
  assert.equal(realtime.status, 502);
  assert.equal(realtime.body.error.code, "resolve_failed");
  const unknown = await call(app, "POST", "/internal/v1/prepare", { sessionId: "ses_3", source: { plugin: "gone", id: "1" }, renderer: "legacy" });
  assert.equal(unknown.status, 404);
});

test("changing tracks returns the source's tracks", async () => {
  const { app, legacy } = await createApp();
  const { body } = await call(app, "POST", "/internal/v1/sessions/ses_1/tracks", { source: { plugin: "library", id: "42" }, subtitles: ["lib:2"] });
  assert.deepEqual(legacy.calls.at(-1), ["tracks", "ses_1", { subtitles: ["lib:2"], audio: undefined }]);
  assert.deepEqual(body, { tracks: { subtitles: [{ id: "lib:2", kind: "subtitle", language: "en", name: "English", format: "text" }], audio: [] }, reload: null });
});
