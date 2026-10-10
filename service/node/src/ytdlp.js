import { execFile } from "node:child_process";
import { isHttpUrl, YoloError } from "@useyolo/core";

// yt-dlp for URL metadata, subtitle lists, and playlist expansion. Mirrors
// the flags server/index.js uses today.

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const AUTO_CAPTION_LANGUAGES = /^(en|zh)/i;

export function cookieArgs(env = process.env) {
  const file = env.YTDLP_COOKIES_FILE?.trim();
  const browser = env.YTDLP_COOKIES_FROM_BROWSER?.trim();
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

export function playlistFromInfo(info, url) {
  const items = (Array.isArray(info?.entries) ? info.entries : []).map((entry) => {
    const link = entryUrl(entry);
    if (!link) return null;
    return {
      source: { kind: "url", url: link },
      title: entry.title || entry.fulltitle || link,
      thumbnail: lastThumbnail(entry),
      duration: wholeSeconds(entry.duration),
    };
  }).filter(Boolean);
  return { title: info?.title || info?.playlist_title || null, url, items };
}

export function createYtdlp({ binary = "yt-dlp", env = process.env, exec = execFile } = {}) {
  const common = cookieArgs(env);

  function run(args) {
    return new Promise((resolve, reject) => {
      exec(binary, [...common, "--no-warnings", ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
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
