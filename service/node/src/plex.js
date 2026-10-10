import { YoloError } from "@useyolo/core";

// Plex access for the node's library API. Item ids are `plex:<ratingKey>` so
// the control plane and agents never see provider-specific routes.

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "srt", "subrip", "vtt", "webvtt"]);
const ARTWORK = { poster: { width: 390, height: 585, field: "thumb" }, landscape: { width: 600, height: 338, field: "art" } };

export function plexRatingKey(id) {
  const match = /^plex:([A-Za-z0-9_-]{1,64})$/.exec(String(id || ""));
  if (!match) throw new YoloError("invalid_request", `Not a library id: ${id}`);
  return match[1];
}

const seconds = (ms) => (Number(ms) > 0 ? Math.round(Number(ms) / 1000) : null);

export function itemFromMetadata(m) {
  const id = `plex:${m.ratingKey}`;
  const item = {
    id,
    kind: m.type,
    title: m.type === "episode" && m.grandparentTitle
      ? `${m.grandparentTitle} S${m.parentIndex}E${m.index} — ${m.title}`
      : m.title,
    year: m.year ?? null,
    duration: seconds(m.duration),
    thumbnail: `/v1/library/items/${encodeURIComponent(id)}/artwork?variant=${m.type === "episode" ? "landscape" : "poster"}`,
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

export function tracksFromPart(part) {
  const streams = part?.Stream || [];
  return {
    subtitles: streams.filter((stream) => stream.streamType === 3).map((stream) => {
      const format = TEXT_SUBTITLE_CODECS.has(String(stream.codec || stream.format || "").toLowerCase()) ? "text" : "image";
      return {
        id: `plex:${stream.id}`,
        kind: "subtitle",
        language: stream.languageCode || stream.language || "",
        name: stream.displayTitle || stream.title || stream.language || "Unknown",
        auto: false,
        format,
        default: Boolean(stream.selected || stream.default),
      };
    }),
    audio: streams.filter((stream) => stream.streamType === 2).map((stream) => ({
      id: `plex:${stream.id}`,
      kind: "audio",
      language: stream.languageCode || stream.language || "",
      name: stream.displayTitle || stream.title || stream.language || "Unknown",
      auto: false,
      format: "text",
      default: Boolean(stream.selected || stream.default),
    })),
  };
}

export function createPlex({ url, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const configured = Boolean(url && token);

  async function request(path, { accept = "application/json" } = {}) {
    if (!configured) throw new YoloError("not_found", "The media library is not configured on this node (PLEX_URL, PLEX_TOKEN)");
    let response;
    try {
      response = await fetchImpl(new URL(path, url), {
        headers: { accept, "x-plex-token": token },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new YoloError("resolve_failed", "The media library did not respond", { cause: error });
    }
    if (response.status === 404) throw new YoloError("not_found", "Library item not found");
    if (!response.ok) throw new YoloError("resolve_failed", `The media library answered ${response.status}`);
    return response;
  }

  const json = async (path) => (await request(path)).json();

  async function metadata(ratingKey) {
    const data = await json(`/library/metadata/${encodeURIComponent(ratingKey)}`);
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
      return (data.MediaContainer?.Directory || []).map((d) => ({ id: `plex:${d.key}`, title: d.title, type: d.type }));
    },

    async libraryItems(libraryId, { offset = 0, limit = 50 } = {}) {
      const key = plexRatingKey(libraryId);
      const params = new URLSearchParams({
        sort: "addedAt:desc",
        "X-Plex-Container-Start": String(Math.max(0, Number(offset) || 0)),
        "X-Plex-Container-Size": String(Math.min(200, Math.max(1, Number(limit) || 50))),
      });
      const data = await json(`/library/sections/${encodeURIComponent(key)}/all?${params}`);
      return {
        total: data.MediaContainer?.totalSize ?? null,
        offset: Number(offset) || 0,
        items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata),
      };
    },

    // A show lists all its episodes (what agents want); anything else lists
    // its direct children.
    async children(itemId) {
      const ratingKey = plexRatingKey(itemId);
      const parent = await metadata(ratingKey);
      const path = parent.type === "show" ? "allLeaves" : "children";
      const data = await json(`/library/metadata/${encodeURIComponent(ratingKey)}/${path}`);
      return { parent: itemFromMetadata(parent), items: (data.MediaContainer?.Metadata || []).map(itemFromMetadata) };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      const params = new URLSearchParams({ query, limit: String(Math.min(50, Number(limit) || 20)) });
      const data = await json(`/hubs/search?${params}`);
      const results = [];
      for (const hub of data.MediaContainer?.Hub || []) {
        for (const m of hub.Metadata || []) {
          if (["movie", "show", "season", "episode"].includes(m.type) && (!type || m.type === type)) {
            results.push(itemFromMetadata(m));
          }
        }
      }
      return { results };
    },

    async describe(ratingKey) {
      const item = itemFromMetadata(await metadata(ratingKey));
      return { title: item.title, thumbnail: item.thumbnail, duration: item.duration, isLive: false };
    },

    async tracks(ratingKey) {
      const item = await metadata(ratingKey);
      return tracksFromPart(item.Media?.[0]?.Part?.[0]);
    },

    async artwork(itemId, variant = "poster") {
      const ratingKey = plexRatingKey(itemId);
      const preset = ARTWORK[variant] || ARTWORK.poster;
      const params = new URLSearchParams({
        width: String(preset.width),
        height: String(preset.height),
        minSize: "1",
        upscale: "0",
        url: `/library/metadata/${ratingKey}/${preset.field}`,
      });
      return request(`/photo/:/transcode?${params}`, { accept: "image/*" });
    },
  };
}
