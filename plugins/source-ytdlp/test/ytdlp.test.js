import assert from "node:assert/strict";
import { test } from "node:test";
import ytdlpPlugin, { cookiesFor, createYtdlpSource, SOURCE_ID } from "../src/node.js";
import { canonicalUrl } from "../src/canonical.js";
import { cookieArgs, createYtdlp, describeInfo, entryUrl, playlistFromInfo, subtitleTracks } from "../src/ytdlp.js";

// A yt-dlp stand-in: answers by the flags it is called with.
function fakeExec(answers, calls = []) {
  return (binary, args, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    calls.push({ binary, args });
    if (args.includes("--version")) return done(null, "2026.09.01\n", "");
    const answer = args.includes("--flat-playlist") ? answers.playlist : answers.info;
    if (answer instanceof Error) return done(answer, "", "ERROR: Unsupported URL");
    return done(null, JSON.stringify(answer), "");
  };
}

const INFO = { title: "Info", duration: 61.5, subtitles: { en: [{ name: "English" }] }, automatic_captions: { "zh-Hans": [{}], fr: [{}] } };

test("canonicalUrl folds YouTube spellings and drops tracking parameters", () => {
  const expected = "https://youtube.com/watch?v=abc";
  assert.equal(canonicalUrl("https://youtu.be/abc?si=xyz"), expected);
  assert.equal(canonicalUrl("https://www.youtube.com/watch?v=abc&t=42&utm_source=x"), expected);
  assert.equal(canonicalUrl("https://m.youtube.com/shorts/abc"), expected);
  assert.equal(canonicalUrl("http://Example.com/a?b=2&a=1#frag"), "https://example.com/a?a=1&b=2");
});

test("claim makes the canonical URL the id and keeps the URL as given", () => {
  const source = createYtdlpSource(createYtdlp({ exec: fakeExec({}) }));
  assert.deepEqual(source.claim("https://youtu.be/abc?si=xyz"), { id: "https://youtube.com/watch?v=abc", url: "https://youtu.be/abc?si=xyz" });
  assert.equal(source.claim("ftp://example.com/a"), undefined);
  // History saved before plugins used the key "url:<canonical URL>"; D1
  // migration 0003 renames it to "ytdlp:<same URL>", which is this source key.
  assert.equal(`${SOURCE_ID}:${source.claim("https://www.youtube.com/watch?v=abc&t=3").id}`, "ytdlp:https://youtube.com/watch?v=abc");
});

test("describe, tracks and expand use yt-dlp output", async () => {
  const calls = [];
  const source = createYtdlpSource(createYtdlp({
    cookies: ["--cookies", "/c.txt"],
    exec: fakeExec({
      info: INFO,
      playlist: { title: "Mix", entries: [{ id: "a1", ie_key: "Youtube", title: "One", duration: 30 }, { title: "No url" }] },
    }, calls),
  }));
  const video = { plugin: SOURCE_ID, id: "https://example.com/v", url: "https://example.com/v?ref=1" };
  assert.deepEqual(await source.describe(video), { title: "Info", thumbnail: null, duration: 61, isLive: false });
  assert.deepEqual(calls.at(-1).args.slice(0, 2), ["--cookies", "/c.txt"]);
  assert.equal(calls.at(-1).args.at(-1), "https://example.com/v?ref=1");
  assert.deepEqual((await source.tracks(video)).subtitles.map((track) => track.id), ["s_en", "s_zh-Hans"]);
  const playlist = await source.expand("https://example.com/list");
  assert.equal(playlist.title, "Mix");
  assert.deepEqual(playlist.items, [{
    source: { id: "https://youtube.com/watch?v=a1", url: "https://www.youtube.com/watch?v=a1" }, title: "One", thumbnail: null, duration: 30,
  }]);
  assert.deepEqual(await source.health(), { available: true, version: "2026.09.01" });
});

test("yt-dlp failures surface as resolve_failed", async () => {
  const ytdlp = createYtdlp({ exec: fakeExec({ info: new Error("exit 1") }) });
  await assert.rejects(ytdlp.info("https://example.com/v"), { code: "resolve_failed", message: "ERROR: Unsupported URL" });
  assert.throws(() => ytdlp.info("not a url"), { code: "invalid_request" });
});

test("helpers", () => {
  assert.deepEqual(describeInfo({ fulltitle: "T", thumbnails: [{ url: "a" }, { url: "b" }], is_live: true }), {
    title: "T", thumbnail: "b", duration: null, isLive: true,
  });
  assert.deepEqual(subtitleTracks({ subtitles: { live_chat: [{}], ja: [{ name: "Japanese" }] } }).map((track) => track.id), ["s_ja"]);
  assert.deepEqual(playlistFromInfo({}), { title: null, entries: [] });
  assert.equal(entryUrl({ url: "https://x.test/1" }), "https://x.test/1");
  assert.equal(entryUrl({ id: "z", ie_key: "Generic" }), null);
});

test("cookie options replace the environment; a file wins over a browser", () => {
  assert.deepEqual(cookieArgs({ cookiesFile: " /c.txt ", cookiesFromBrowser: "chrome" }), ["--cookies", "/c.txt"]);
  assert.deepEqual(cookieArgs({}), []);
  const env = { YTDLP_COOKIES_FILE: "/env.txt", YTDLP_COOKIES_FROM_BROWSER: "safari" };
  assert.deepEqual(cookiesFor({ cookiesFromBrowser: "firefox" }, env), ["--cookies-from-browser", "firefox"]);
  assert.deepEqual(cookiesFor({}, env), ["--cookies", "/env.txt"]);
  assert.deepEqual(cookiesFor({}, { YTDLP_COOKIES_FROM_BROWSER: "safari" }), ["--cookies-from-browser", "safari"]);
});

test("the plugin registers one source that claims web URLs", () => {
  const registered = new Map();
  ytdlpPlugin({ options: {}, env: {}, registerSource: (id, impl) => registered.set(id, impl) });
  assert.deepEqual([...registered.keys()], [SOURCE_ID]);
  assert.equal(registered.get(SOURCE_ID).claim("https://example.com/v").url, "https://example.com/v");
});
