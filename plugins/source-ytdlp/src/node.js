import { isHttpUrl } from "@useyolo/plugin-api";
import { canonicalUrl } from "./canonical.js";
import { cookieArgs, createYtdlp, describeInfo, playlistFromInfo, subtitleTracks } from "./ytdlp.js";

// Official source plugin: video pages and playlists from the sites yt-dlp
// supports (decision 21: yt-dlp is a plugin, so it can be updated or turned
// off on its own). It claims every http(s) URL, so list it after any plugin
// that should get the first look at a URL.
//
// Options (yolo.config.json), each falling back to the environment:
//   binary              yt-dlp executable, default "yt-dlp" on PATH
//   cookiesFile         YTDLP_COOKIES_FILE
//   cookiesFromBrowser  YTDLP_COOKIES_FROM_BROWSER
//
// Sources: { plugin: "ytdlp", id: <canonical URL>, url: <URL as given> }.
// Playback uses the URL as given; history and preferences use the id.

export const SOURCE_ID = "ytdlp";

const sourceFor = (url) => ({ id: canonicalUrl(url), url: url.trim() });

export function createYtdlpSource(ytdlp) {
  const pageUrl = (source) => String(source.url || source.id);
  return {
    async health() {
      const version = await ytdlp.version();
      return { available: Boolean(version), version };
    },
    claim: (url) => (isHttpUrl(url) ? sourceFor(url) : undefined),
    async expand(url) {
      const { title, entries } = playlistFromInfo(await ytdlp.flatPlaylist(url));
      return {
        title,
        items: entries.map((entry) => ({
          source: sourceFor(entry.url),
          title: entry.title,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
        })),
      };
    },
    describe: async (source) => describeInfo(await ytdlp.info(pageUrl(source))),
    tracks: async (source) => ({ subtitles: subtitleTracks(await ytdlp.info(pageUrl(source))), audio: [] }),
  };
}

// Cookie options replace both environment variables rather than mix with them.
export function cookiesFor(options, env) {
  const { cookiesFile, cookiesFromBrowser } = options;
  return cookiesFile || cookiesFromBrowser
    ? cookieArgs({ cookiesFile, cookiesFromBrowser })
    : cookieArgs({ cookiesFile: env.YTDLP_COOKIES_FILE, cookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER });
}

/** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
export default function ytdlpPlugin(yolo) {
  // Each call runs its own short-lived yt-dlp process, so nothing needs to
  // start or stop with the node.
  const ytdlp = createYtdlp({ binary: String(yolo.options.binary || "yt-dlp"), cookies: cookiesFor(yolo.options, yolo.env) });
  yolo.registerSource(SOURCE_ID, createYtdlpSource(ytdlp));
}
