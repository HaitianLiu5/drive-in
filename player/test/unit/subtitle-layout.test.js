import assert from "node:assert/strict";
import test from "node:test";

import { buildCueEndPrefix } from "../../src/subtitle-cues.js";
import { activeSubtitleGroups, fitSubtitleRow, subtitleRowPage, subtitleDisplayLines, subtitleLineLanguage, subtitlePictureBounds, subtitleTrackLanguages, subtitleLanguageSlots } from "../../src/subtitle-layout.js";

test("bilingual Plex IDs never become CSS language tags", () => {
  assert.equal(subtitleLineLanguage("他加了一条通风管", "plex:80803"), "zh-Hans");
  assert.equal(subtitleLineLanguage("He added an air-duct system.", "plex:80803"), "en");
  assert.equal(subtitleLineLanguage("日本語字幕", "ja"), "ja");
  assert.equal(subtitleLineLanguage("繁體字幕", "zh-Hant"), "zh-Hant");
});

test("bilingual dialogue does not expand two authored lines into four rows", () => {
  assert.deepEqual(subtitleDisplayLines("- He added an air-duct system... - Good.\n- 他加了通风管 - 好"), [
    "- He added an air-duct system... - Good.", "- 他加了通风管 - 好",
  ]);
  assert.deepEqual(subtitleDisplayLines("A well-known phrase - not another speaker."), ["A well-known phrase - not another speaker."]);
});

test("subtitle placement follows contained landscape and portrait pictures", () => {
  const wide = subtitlePictureBounds(773, 601, 1280, 536);
  assert.equal(wide.width, 773);
  assert.ok(Math.abs(wide.bottom - 138.65) < 1);
  const tall = subtitlePictureBounds(1000, 600, 600, 1000);
  assert.equal(tall.width, 360);
  assert.equal(tall.bottom, 0);
});

function track(lang, cues) {
  return { lang, cues, cueEndPrefix: buildCueEndPrefix(cues) };
}

test("groups every active line by subtitle language", () => {
  const groups = activeSubtitleGroups([
    track("zh-Hans", [
      { start: 0, end: 4, text: "第一行\n第二行" },
      { start: 1, end: 3, text: "重叠提示" },
    ]),
    track("en", [
      { start: 0, end: 4, text: "First line\nSecond line" },
    ]),
  ], 2);

  assert.deepEqual(groups, [
    { lang: "en", lines: ["First line Second line"], start: 0, end: 4 },
    { lang: "zh-Hans", lines: ["第一行 第二行 重叠提示"], start: 1, end: 3 },
  ]);
});

test("omits inactive tracks and blank subtitle lines", () => {
  const groups = activeSubtitleGroups([
    track("zh-Hans", [{ start: 0, end: 1, text: "已经结束" }]),
    track("en", [{ start: 1, end: 3, text: "  Active  \n  \n" }]),
  ], 2);

  assert.deepEqual(groups, [{ lang: "en", lines: ["Active"], start: 1, end: 3 }]);
});

test("one bilingual Plex track becomes one English row over one Chinese row", () => {
  const groups = activeSubtitleGroups([track("plex:80891", [{ start: 0, end: 4,
    text: "​​​中文第一句\n中文第二句\nEnglish first sentence\nEnglish second sentence" }])], 1);
  assert.deepEqual(groups, [
    { lang: "en", lines: ["English first sentence English second sentence"], start: 0, end: 4 },
    { lang: "zh-Hans", lines: ["中文第一句 中文第二句"], start: 0, end: 4 },
  ]);
});

test("bilingual slots reserve missing languages without stale text", () => {
  const tracks = [
    track("zh-Hans", [{ start: 0, end: 2, text: "中文" }]),
    track("en", [{ start: 1, end: 3, text: "English" }]),
  ];
  const languages = tracks.flatMap(subtitleTrackLanguages);
  const rowsAt = (time) => subtitleLanguageSlots(activeSubtitleGroups(tracks, time), languages)
    .map(({ lang, lines }) => ({ lang, text: lines[0] }));
  assert.deepEqual(rowsAt(0.5), [{ lang: "en", text: "" }, { lang: "zh-Hans", text: "中文" }]);
  assert.deepEqual(rowsAt(1.5), [{ lang: "en", text: "English" }, { lang: "zh-Hans", text: "中文" }]);
  assert.deepEqual(rowsAt(2.5), [{ lang: "en", text: "English" }, { lang: "zh-Hans", text: "" }]);
  assert.deepEqual(rowsAt(4), []);
  assert.deepEqual(rowsAt(0.5), [{ lang: "en", text: "" }, { lang: "zh-Hans", text: "中文" }]);
});

test("mixed Plex files discover both slots even when no cue has both languages", () => {
  const mixed = track("plex:80891", [
    { start: 0, end: 1, text: "中文" },
    { start: 1, end: 2, text: "English" },
  ]);
  assert.deepEqual(subtitleTrackLanguages(mixed), ["en", "zh-Hans"]);
  assert.deepEqual(subtitleLanguageSlots(activeSubtitleGroups([mixed], 1.5), subtitleTrackLanguages(mixed))
    .map(({ lines }) => lines[0]), ["English", ""]);
});

test("single-language selection keeps one slot", () => {
  const english = track("en", [{ start: 0, end: 2, text: "English" }]);
  const active = activeSubtitleGroups([english], 1);
  assert.deepEqual(subtitleLanguageSlots(active, subtitleTrackLanguages(english)), active);
});

test("fitting keeps full text readable and pages long cues without omission", () => {
  const measure = (text, size) => Array.from(text).length * size / 2;
  assert.deepEqual(fitSubtitleRow("Short line", 200, 20, 16, measure), { fontSize: 20, pages: ["Short line"] });
  const fitted = fitSubtitleRow("A slightly longer line", 180, 20, 16, measure);
  assert.ok(fitted.fontSize >= 16 && fitted.fontSize < 20);
  assert.equal(fitted.pages.length, 1);
  const text = "Keep every word. This exceptionally long subtitle must remain legible, even in a narrow window.";
  const paged = fitSubtitleRow(text, 160, 20, 16, measure);
  assert.equal(paged.fontSize, 16);
  assert.ok(paged.pages.length > 1);
  assert.equal(paged.pages.join(" ").replace(/\s/g, ""), text.replace(/\s/g, ""));
  assert.ok(paged.pages.every((page) => measure(page, paged.fontSize) <= 160));
  assert.equal(subtitleRowPage(paged.pages, 0, 0, 4), paged.pages[0]);
  assert.equal(subtitleRowPage(paged.pages, 3.999, 0, 4), paged.pages.at(-1));
});
