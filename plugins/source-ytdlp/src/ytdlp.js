import { execFile } from "node:child_process";
import { isHttpUrl, YoloError } from "@useyolo/plugin-api";

// yt-dlp for URL metadata, subtitle lists, and playlist expansion. Mirrors
// the flags server/index.js uses today.

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const AUTO_CAPTION_LANGUAGES = /^(en|zh)/i;

// A cookies file wins over a browser profile; neither means anonymous.
export function cookieArgs({ cookiesFile, cookiesFromBrowser } = {}) {
  const file = String(cookiesFile ?? "").trim();
  const browser = String(cookiesFromBrowser ?? "").trim();
  if (file) return ["--cookies", file];
  if (browser) return ["--cookies-from-browser", browser];
  return [];
}

export function entryUrl(entry) {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  const extractor = String(entry.ie_key || entry.extractor_key || "").toLowerCase();
  if (extractor.includes("youtube") && entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return null;
}

const lastThumbnail = (info) => (Array.isArray(info.thumbnails) && info.thumbnails.length
  ? info.thumbnails[info.thumbnails.length - 1]?.url
  : info.thumbnail) || null;

const wholeSeconds = (value) => (Number(value) > 0 ? Math.floor(Number(value)) : null);

export function describeInfo(info) {
  return {
    title: info.title || info.fulltitle || info.webpage_url || null,
    thumbnail: lastThumbnail(info),
    duration: wholeSeconds(info.duration),
    isLive: Boolean(info.is_live),
  };
}

export function subtitleTracks(info) {
  const tracks = [];
  const add = (lang, entries, auto) => {
    if (tracks.some((track) => track.language === lang)) return;
    tracks.push({
      id: `s_${lang}`,
      kind: "subtitle",
      language: lang,
      name: entries?.[0]?.name || lang,
      auto,
      format: "text",
      default: false,
    });
  };
  for (const [lang, entries] of Object.entries(info.subtitles || {})) {
    if (lang !== "live_chat") add(lang, entries, false);
  }
  for (const [lang, entries] of Object.entries(info.automatic_captions || {})) {
    if (AUTO_CAPTION_LANGUAGES.test(lang) && !lang.includes("-orig")) add(lang, entries, true);
  }
  return tracks;
}

// Playlist entries as { url, title, thumbnail, duration }; entries without a
// playable link are dropped.
export function playlistFromInfo(info) {
  const entries = (Array.isArray(info?.entries) ? info.entries : []).map((entry) => {
    const link = entryUrl(entry);
    if (!link) return null;
    return {
      url: link,
      title: entry.title || entry.fulltitle || link,
      thumbnail: lastThumbnail(entry),
      duration: wholeSeconds(entry.duration),
    };
  }).filter(Boolean);
  return { title: info?.title || info?.playlist_title || null, entries };
}

export function createYtdlp({ binary = "yt-dlp", cookies = [], exec = execFile } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      exec(binary, [...cookies, "--no-warnings", ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message).trim().split("\n").pop();
          return reject(new YoloError("resolve_failed", message || "yt-dlp failed", { cause: error }));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (cause) {
          reject(new YoloError("resolve_failed", "yt-dlp returned invalid JSON", { cause }));
        }
      });
    });
  }

  const checkUrl = (url) => {
    if (!isHttpUrl(url)) throw new YoloError("invalid_request", "A valid http(s) URL is required");
    return url.trim();
  };

  return {
    info: (url) => run(["-j", "--no-playlist", "--skip-download", "--", checkUrl(url)]),
    flatPlaylist: (url) => run(["--flat-playlist", "--dump-single-json", "--", checkUrl(url)]),
    version: () => new Promise((resolve) => {
      exec(binary, ["--version"], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
    }),
  };
}
