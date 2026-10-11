// --- VTT subtitle renderer -------------------------------------------

import { buildCueEndPrefix, parseVTT } from "./subtitle-cues.js";
import { activeSubtitleGroups, fitSubtitleRow, subtitleRowPage, subtitlePictureBounds, subtitleTrackLanguages, subtitleLanguageSlots } from "./subtitle-layout.js";
import { requestText } from "./network.js";

export { parseVTT } from "./subtitle-cues.js";

const subtitleOverlay = document.getElementById("subtitle-overlay");
const playerContainer = document.getElementById("player-container");
let subtitleTracks = []; // [{ lang, cues }]
let lastRenderedSubtitle = "";
let lastSubtitleTime = 0;
let subtitleRows = [];
let layoutKey = "";
const textMeasure = document.createElement("canvas").getContext("2d");
const pendingTracks = new Map();

function updateSubtitlePictureBounds() {
  const canvas = playerContainer.querySelector('canvas[data-engine="mediabunny"]');
  const bounds = subtitlePictureBounds(playerContainer.clientWidth, playerContainer.clientHeight,
    canvas?.width || 0, canvas?.height || 0);
  subtitleOverlay.style.setProperty("--subtitle-picture-width", `${bounds.width}px`);
  const containerBox = playerContainer.getBoundingClientRect();
  const controlsTop = Math.min(...["progress-wrap", "controls-row"].map((id) => document.getElementById(id).getBoundingClientRect().top));
  subtitleOverlay.style.setProperty("--subtitle-controls-inset", `${Math.max(8, containerBox.bottom - controlsTop + 8)}px`);
  const nextKey = `${bounds.width}:${bounds.height}:${getComputedStyle(subtitleOverlay).fontSize}`;
  if (nextKey !== layoutKey) {
    layoutKey = nextKey;
    lastRenderedSubtitle = "";
    renderSubtitle(lastSubtitleTime);
  }
}

// Geometry follows the actual contained image, including resize while paused.
// Observers avoid layout reads in the per-frame subtitle rendering path.
new ResizeObserver(updateSubtitlePictureBounds).observe(playerContainer);
new ResizeObserver(updateSubtitlePictureBounds).observe(document.getElementById("controls-bottom"));
new MutationObserver(updateSubtitlePictureBounds).observe(playerContainer, {
  childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"],
});
updateSubtitlePictureBounds();
document.fonts.ready.then(() => {
  lastRenderedSubtitle = "";
  renderSubtitle(lastSubtitleTime);
});
document.fonts.addEventListener("loadingdone", () => {
  lastRenderedSubtitle = "";
  renderSubtitle(lastSubtitleTime);
});

function cancelPendingTrack(lang) {
  pendingTracks.get(lang)?.abort();
  pendingTracks.delete(lang);
}

function clearSubtitleOverlay() {
  subtitleRows = [];
  if (!lastRenderedSubtitle && !subtitleOverlay.hasChildNodes()) return;
  subtitleOverlay.replaceChildren();
  lastRenderedSubtitle = "";
}

function renderSubtitleGroups(groups, time) {
  const nextRenderedSubtitle = JSON.stringify(groups);
  if (nextRenderedSubtitle !== lastRenderedSubtitle) {
    lastRenderedSubtitle = nextRenderedSubtitle;
    if (!groups.length) {
      clearSubtitleOverlay();
      return;
    }
    const fragment = document.createDocumentFragment();
    subtitleRows = [];
    for (const group of groups) {
      const track = document.createElement("div");
      track.className = "subtitle-track";
      track.lang = group.lang;
      track.dataset.lang = group.lang;
      const lineElement = document.createElement("span");
      lineElement.className = "subtitle-line";
      lineElement.lang = group.lang;
      lineElement.textContent = group.lines[0];
      track.append(lineElement);
      fragment.append(track);
      subtitleRows.push({ ...group, element: lineElement });
    }
    subtitleOverlay.replaceChildren(fragment);
    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const baseSize = parseFloat(getComputedStyle(subtitleOverlay).fontSize);
    // A fitted font or an empty cue must not change either language's row box.
    subtitleOverlay.style.setProperty("--subtitle-row-height", `${baseSize * 1.25}px`);
    for (const row of subtitleRows) {
      const style = getComputedStyle(row.element);
      const fit = fitSubtitleRow(row.lines[0], Math.max(1, row.element.clientWidth - 2), baseSize, rootSize, (text, size) => {
        textMeasure.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
        return textMeasure.measureText(text).width;
      });
      row.pages = fit.pages;
      row.element.style.fontSize = `${fit.fontSize / rootSize}rem`;
    }
  }
  for (const row of subtitleRows) {
    const text = subtitleRowPage(row.pages, time, row.start, row.end);
    if (row.element.textContent !== text) row.element.textContent = text;
  }
}

export function renderSubtitle(time) {
  lastSubtitleTime = time;
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }

  renderSubtitleGroups(subtitleLanguageSlots(activeSubtitleGroups(subtitleTracks, time),
    subtitleTracks.flatMap((track) => track.languages)), time);
}

export async function loadSubtitleTrack(lang, url) {
  cancelPendingTrack(lang);
  const controller = new AbortController();
  pendingTracks.set(lang, controller);
  try {
    const absUrl = url.startsWith("/") ? `${location.origin}${url}` : url;
    const existingTrack = subtitleTracks.find((track) => track.lang === lang && track.url === absUrl);
    if (existingTrack) return true;
    const resp = await requestText(absUrl, { signal: controller.signal }, {
      label: "Subtitle",
      timeoutMs: 20_000,
      maxBytes: 20 * 1024 * 1024,
    });
    if (pendingTracks.get(lang) !== controller) return null;
    if (!resp.ok) throw new Error(`Subtitle fetch failed with ${resp.status}`);
    const cues = parseVTT(resp.text);
    subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
    // Prefix maxima let lookup stop as soon as no earlier overlapping cue can still be active.
    subtitleTracks.push({ lang, url: absUrl, cues, languages: subtitleTrackLanguages({ lang, cues }),
      cueEndPrefix: buildCueEndPrefix(cues) });
    clearSubtitleOverlay();
    console.log(`[subs] Loaded ${cues.length} cues for ${lang}`);
    return true;
  } catch (e) {
    if (controller.signal.aborted) return null;
    console.error("[subs] Failed to load subtitle:", e);
    return false;
  } finally {
    if (pendingTracks.get(lang) === controller) pendingTracks.delete(lang);
  }
}

export function disableExternalSubtitle() {
  for (const lang of pendingTracks.keys()) cancelPendingTrack(lang);
  subtitleTracks = [];
  clearSubtitleOverlay();
}

export function removeSubtitleTrack(lang) {
  cancelPendingTrack(lang);
  subtitleTracks = subtitleTracks.filter((t) => t.lang !== lang);
  if (!subtitleTracks.length) {
    clearSubtitleOverlay();
    return;
  }
  lastRenderedSubtitle = "";
}
