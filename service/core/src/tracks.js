// Track preference matching, ported from server/subtitle-preferences.js.
// The control plane stores preferences per sourceKey plus a `default` row with
// the most recent choice; the node knows which tracks a source actually has.

export function trackLanguage(value = "") {
  const lang = String(value).toLowerCase();
  if (/^(zh|zho|chi|中文)/.test(lang)) return "zh";
  if (/^(en|eng|english)/.test(lang)) return "en";
  if (/^(ja|jpn|日本)/.test(lang)) return "ja";
  if (/^(ko|kor|한국)/.test(lang)) return "ko";
  return lang.split("-")[0];
}

// A stored preference keeps enough to match the same track on another video.
export function preferenceFromTrack(track) {
  return {
    id: String(track.id),
    language: trackLanguage(track.language),
    name: track.name || "",
    format: track.format || "text",
  };
}

// Pick tracks for `available` from `saved` (this source) or `fallback` (the
// `default` row). Returns null when there is no preference at all, and [] for
// an explicit "off". Exact ids only count for the same source.
export function selectTracks({ saved = null, fallback = null, available = [] }) {
  const preferences = saved ?? fallback;
  if (preferences === null || preferences === undefined) return null;
  const chosen = [];
  for (const preference of preferences) {
    const exact = saved && available.find((track) => String(track.id) === preference.id);
    const matching = available.filter((track) => trackLanguage(track.language) === preference.language);
    const match = exact
      || matching.find((track) => track.name === preference.name && (track.format || "text") === preference.format)
      || matching.find((track) => (track.format || "text") === preference.format)
      || matching[0];
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}
