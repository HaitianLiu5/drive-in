import { findActiveCues } from "./subtitle-cues.js";

// Track IDs (e.g. plex:80803) are identities, never valid language tags.
// Inspect each displayed line because a single ASS/VTT track can be bilingual.
export function subtitleLineLanguage(text, language = "") {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/\p{Script=Han}/u.test(text)) {
    if (/^(ja|jpn)$/i.test(language)) return "ja";
    if (/^(zh-(Hant|TW|HK)|yue)$/i.test(language)) return "zh-Hant";
    return "zh-Hans";
  }
  if (/\p{Script=Latin}/u.test(text)) return "en";
  return /^(en|zh(?:-(?:Hans|Hant|CN|TW|HK))?|ja|ko)$/i.test(language) ? language : "und";
}

export function subtitleDisplayLines(text) {
  // Keep language boundaries for classification, not authored visual wraps.
  return text.split("\n").map((line) => line.replace(/[\u200b\uFEFF]/gu, "").trim()).filter(Boolean);
}

const languagePriority = (lang) => lang === "en" ? 0 : lang.startsWith("zh") ? 1 : 2;

// Inspect once when a track loads: one Plex file can contain both languages.
export function subtitleTrackLanguages(track) {
  const languages = new Set();
  for (const cue of track.cues) {
    for (const line of subtitleDisplayLines(cue.text)) {
      languages.add(subtitleLineLanguage(line, track.lang));
    }
  }
  return [...languages].sort((a, b) => languagePriority(a) - languagePriority(b));
}

export function subtitleLanguageSlots(groups, languages) {
  if (!groups.length) return []; // Hide the backing during complete silence.
  const active = new Map(groups.map((group) => [group.lang, group]));
  return [...new Set([...languages, ...active.keys()])]
    .sort((a, b) => languagePriority(a) - languagePriority(b))
    .map((lang) => active.get(lang) || { lang, lines: [""], start: 0, end: 0 });
}

export function subtitlePictureBounds(width, height, videoWidth, videoHeight) {
  const scale = videoWidth > 0 && videoHeight > 0
    ? Math.min(width / videoWidth, height / videoHeight) : 1;
  const pictureWidth = videoWidth > 0 && videoHeight > 0 ? videoWidth * scale : width;
  const pictureHeight = videoWidth > 0 && videoHeight > 0 ? videoHeight * scale : height;
  return { width: pictureWidth, height: pictureHeight,
    bottom: (height - pictureHeight) / 2,
  };
}

export function activeSubtitleGroups(tracks, time) {
  const groups = new Map();
  for (const track of tracks) {
    const activeCues = findActiveCues(track, time);
    for (const cue of activeCues) {
      for (const line of subtitleDisplayLines(cue.text)) {
        const lang = subtitleLineLanguage(line, track.lang);
        let group = groups.get(lang);
        if (!group) {
          group = { lang, lines: [], start: cue.start, end: cue.end };
          groups.set(lang, group);
        }
        group.lines.push(line);
        group.start = Math.max(group.start, cue.start);
        group.end = Math.min(group.end, cue.end);
      }
    }
  }
  // Stable visual order, independent of asynchronous track download order.
  return [...groups.values()].sort((a, b) => languagePriority(a.lang) - languagePriority(b.lang))
    .map((group) => ({ ...group, lines: [group.lines.join(" ")] }));
}

// Fit common cues on one row. Exceptionally long cues are presented as pages
// within their original active window, rather than clipped or made illegible.
export function fitSubtitleRow(text, width, baseSize, minSize, measure) {
  const measured = measure(text, baseSize);
  const fontSize = Math.max(minSize, Math.min(baseSize, measured > 0 ? baseSize * width / measured : baseSize));
  if (measure(text, fontSize) <= width) return { fontSize, pages: [text] };
  const pages = [];
  const characters = Array.from(text);
  let start = 0;
  while (start < characters.length) {
    let end = start + 1;
    while (end < characters.length && measure(characters.slice(start, end + 1).join(""), fontSize) <= width) end++;
    if (end < characters.length) {
      for (let index = end - 1; index >= start + Math.floor((end - start) / 2); index--) {
        if (/[\s,.!?，。！？、;；]/u.test(characters[index])) { end = index + 1; break; }
      }
    }
    const page = characters.slice(start, end).join("").trim();
    if (page) pages.push(page);
    start = end;
  }
  return { fontSize, pages };
}

export function subtitleRowPage(pages, time, start, end) {
  const progress = end > start ? (time - start) / (end - start) : 0;
  return pages[Math.max(0, Math.min(pages.length - 1, Math.floor(progress * pages.length)))];
}
