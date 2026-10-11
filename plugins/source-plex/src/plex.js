import { YoloError } from "@useyolo/plugin-api";

// A small Plex Media Server client for the source's library calls. Ids are
// Plex's own (ratingKey, section key); Yolo adds the "plex:" prefix.

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip", "vtt", "webvtt"]);
const ARTWORK = { poster: { width: 390, height: 585, field: "thumb" }, landscape: { width: 600, height: 338, field: "art" } };
const PLEX_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function plexKey(id) {
  const key = String(id ?? "");
  if (!PLEX_KEY.test(key)) throw new YoloError("invalid_request", `Not a Plex library id: ${id}`);
  return key;
}

const seconds = (ms) => (Number(ms) > 0 ? Math.round(Number(ms) / 1000) : null);

export function itemFromMetadata(m) {
  const item = {
    id: String(m.ratingKey),
    kind: m.type,
    title: m.type === "episode" && m.grandparentTitle
      ? `${m.grandparentTitle} S${m.parentIndex}E${m.index} — ${m.title}`
      : m.title,
    year: m.year ?? null,
    duration: seconds(m.duration),
    artwork: m.type === "episode" ? "landscape" : "poster",
    resumeAt: seconds(m.viewOffset),
    watched: Number(m.viewCount) > 0,
  };
  if (m.type === "show" || m.type === "season") {
    item.episodes = m.leafCount ?? null;
    item.watchedEpisodes = m.viewedLeafCount ?? 0;
  }
  if (m.type === "episode") Object.assign(item, { season: m.parentIndex ?? null, episode: m.index ?? null });
  return item;
}

// Track ids stay `plex:<streamId>`, as saved track choices refer to them.
export function tracksFromPart(part) {
  const streams = part?.Stream || [];
  const track = (stream, kind, format) => ({
    id: `plex:${stream.id}`,
    kind,
    language: stream.languageCode || stream.language || "",
    name: stream.displayTitle || stream.title || stream.language || "Unknown",
    auto: false,
    format,
    default: Boolean(stream.selected || stream.default),
  });
  return {
    subtitles: streams.filter((stream) => stream.streamType === 3).map((stream) => track(
      stream,
      "subtitle",
      TEXT_SUBTITLE_CODECS.has(String(stream.codec || stream.format || "").toLowerCase()) ? "text" : "image",
    )),
    audio: streams.filter((stream) => stream.streamType === 2).map((stream) => track(stream, "audio", "text")),
  };
}

export function createPlex({ url, token, fetchImpl = (...args) => fetch(...args), timeoutMs = 10_000 }) {
  const configured = Boolean(url && token);

  async function request(path, { accept = "application/json" } = {}) {
    if (!configured) throw new YoloError("not_found", "The Plex library is not configured on this node (PLEX_URL, PLEX_TOKEN)");
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        headers: { accept, "x-plex-token": token },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new YoloError("resolve_failed", "The Plex library did not respond", { cause: error });
    }
    if (response.status === 404) throw new YoloError("not_found", "Library item not found");
    if (!response.ok) throw new YoloError("resolve_failed", `The Plex library answered ${response.status}`);
    return response;
  }

  const json = async (path) => (await request(path)).json();

  async function metadata(ratingKey) {
    const data = await json(`/library/metadata/${encodeURIComponent(plexKey(ratingKey))}`);
    const item = data?.MediaContainer?.Metadata?.[0];
    if (!item) throw new YoloError("not_found", "Library item not found");
    return item;
  }

  return {
    configured,

    async health() {
      if (!configured) return { configured: false };
      try {
        await json("/identity");
        return { configured: true, online: true };
      } catch {
        return { configured: true, online: false };
      }
    },

    async libraries() {
      const data = await json("/library/sections");
      return (data.MediaContainer?.Directory || []).map((d) => ({ id: String(d.key), title: d.title, type: d.type }));
    },

    async libraryItems(sectionKey, { offset = 0, limit = 50 } = {}) {
      const params = new URLSearchParams({
        sort: "addedAt:desc",
        "X-Plex-Container-Start": String(offset),
        "X-Plex-Container-Size": String(limit),
      });
      const data = await json(`/library/sections/${encodeURIComponent(plexKey(sectionKey))}/all?${params}`);
      return {
        total: data.MediaContainer?.totalSize ?? null,
        offset,
        items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata),
      };
    },

    // A show lists all its episodes (what agents want); anything else lists
    // its direct children.
    async children(ratingKey) {
      const parent = await metadata(ratingKey);
      const path = parent.type === "show" ? "allLeaves" : "children";
      const data = await json(`/library/metadata/${encodeURIComponent(plexKey(ratingKey))}/${path}`);
      return { parent: itemFromMetadata(parent), items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata) };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      const params = new URLSearchParams({ query, limit: String(limit) });
      const data = await json(`/hubs/search?${params}`);
      const results = [];
      for (const hub of data.MediaContainer?.Hub || []) {
        for (const m of hub.Metadata || []) {
          if (["movie", "show", "season", "episode"].includes(m.type) && (!type || m.type === type)) {
            results.push(itemFromMetadata(m));
          }
        }
      }
      return results;
    },

    async describe(ratingKey) {
      const { title, artwork, duration } = itemFromMetadata(await metadata(ratingKey));
      return { title, artwork, duration, isLive: false };
    },

    async tracks(ratingKey) {
      const item = await metadata(ratingKey);
      return tracksFromPart(item.Media?.[0]?.Part?.[0]);
    },

    async artwork(ratingKey, variant = "poster") {
      const preset = ARTWORK[variant] || ARTWORK.poster;
      const params = new URLSearchParams({
        width: String(preset.width),
        height: String(preset.height),
        minSize: "1",
        upscale: "0",
        url: `/library/metadata/${plexKey(ratingKey)}/${preset.field}`,
      });
      return request(`/photo/:/transcode?${params}`, { accept: "image/*" });
    },
  };
}
