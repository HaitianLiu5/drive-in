import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTracks, preferenceFromTrack, trackLanguage } from "../src/index.js";

const available = [
  { id: "plex:1", language: "eng", name: "English (SDH)", format: "text" },
  { id: "plex:2", language: "chi", name: "简体", format: "text" },
  { id: "plex:3", language: "zh-Hant", name: "繁體", format: "image" },
];

test("trackLanguage folds common spellings", () => {
  assert.equal(trackLanguage("eng"), "en");
  assert.equal(trackLanguage("zh-Hans"), "zh");
  assert.equal(trackLanguage("fr-CA"), "fr");
});

test("no preference returns null; explicit off returns []", () => {
  assert.equal(selectTracks({ available }), null);
  assert.deepEqual(selectTracks({ saved: [], available }), []);
});

test("default preference matches by language and format on another source", () => {
  const fallback = [preferenceFromTrack({ id: "s_zh", language: "zh", name: "Chinese", format: "text" })];
  assert.deepEqual(selectTracks({ fallback, available }).map((track) => track.id), ["plex:2"]);
});

test("saved preference for the same source matches the exact id first", () => {
  const saved = [preferenceFromTrack(available[2])];
  assert.deepEqual(selectTracks({ saved, available }).map((track) => track.id), ["plex:3"]);
});
