import { CONTROL_ACTIONS, isClaimed, isHttpUrl, isSourceKey, sourceFromRef, sourceKey, toYoloError, YoloError } from "@useyolo/core";
import * as queueStore from "./store/queue.js";
import * as playlistStore from "./store/playlists.js";
import * as historyStore from "./store/history.js";
import { deleteDevice, renameDevice } from "./store/devices.js";
import { recordNodeSeen } from "./store/users.js";
import { claimSource } from "./sources.js";

// One service layer behind both the MCP tools and the /v1 HTTP API, so the
// two surfaces cannot drift. `hub` is HubCore in tests and an RPC proxy to the
// Hub Durable Object in the Worker; `node` wraps nodeFetch().

const METADATA_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 3_000;

export function createServices({ db, userId, hub, node }) {
  // Claim a URL and fetch title, thumbnail and duration. Best effort: queue
  // and playlist edits must keep working while the node is offline (§8), so a
  // URL then stays unclaimed until it plays.
  async function describe(ref) {
    try {
      const metadata = await node.post("/internal/v1/metadata", isClaimed(ref) ? { source: ref } : { url: ref.url }, {
        timeoutMs: METADATA_TIMEOUT_MS,
      });
      return {
        source: metadata.source ?? ref, title: metadata.title, thumbnail: metadata.thumbnail, duration: metadata.duration, metadata: {},
      };
    } catch (error) {
      if (error?.code !== "node_offline" && error?.code !== "resolve_failed") throw error;
      return { source: ref, metadata: { pendingMetadata: true } };
    }
  }

  // Realtime broadcasts are best effort; a failed one must not fail the edit.
  const notifyQueue = () => Promise.resolve().then(() => hub.broadcastQueue()).catch(() => {});
  const notifyPlaylists = () => Promise.resolve().then(() => hub.broadcastPlaylists()).catch(() => {});

  function refToSource({ url, itemId }) {
    if (url && itemId) throw new YoloError("invalid_request", "Pass either url or item_id, not both");
    return sourceFromRef(url ?? itemId);
  }

  async function nodeHealth() {
    try {
      const health = await node.get("/internal/v1/health", undefined, { timeoutMs: HEALTH_TIMEOUT_MS });
      void recordNodeSeen(db, userId, { version: health?.version ?? null }).catch(() => {});
      return { online: true, ...health };
    } catch (error) {
      return { online: false, error: toYoloError(error).message };
    }
  }

  const services = {
    async status() {
      const [node, playback, queue] = await Promise.all([
        nodeHealth(),
        hub.getState(),
        queueStore.listQueue(db, userId),
      ]);
      return { playback, node, queue: { length: queue.length, upNext: queue.slice(0, 3) } };
    },

    async me() {
      return { userId, node: await nodeHealth() };
    },

    devices: () => hub.listDevices(),

    async renameDevice(id, name) {
      if (id.startsWith("node:")) throw new YoloError("invalid_request", "Node renderers are named on the node");
      const device = await renameDevice(db, userId, id, name);
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return device;
    },

    // Device tokens arrive with the device-code flow; until then removing a
    // device only forgets it (it reappears if it says hello again).
    async deleteDevice(id) {
      if (id.startsWith("node:")) throw new YoloError("invalid_request", "Node renderers are managed on the node");
      await deleteDevice(db, userId, id);
      void Promise.resolve().then(() => hub.broadcastDevices()).catch(() => {});
      return { deleted: id };
    },

    playbackState: () => hub.getState(),

    // --- Library ----------------------------------------------------------

    async search({ query, type = null, limit = 20 }) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "query is required");
      if (isHttpUrl(text)) {
        // `kind: "url"` says the result came from looking up a URL; the
        // claiming plugin is in `source.plugin`.
        const metadata = await node.post("/internal/v1/metadata", { url: text }, { timeoutMs: METADATA_TIMEOUT_MS });
        return { results: [{ id: text, kind: "url", ...metadata }] };
      }
      return node.get("/internal/v1/library/search", { q: text, type, limit });
    },

    async browse({ libraryId = null, itemId = null, offset = 0, limit = 50 } = {}) {
      if (itemId) return node.get(`/internal/v1/library/items/${encodeURIComponent(itemId)}/children`);
      if (libraryId) return node.get(`/internal/v1/library/${encodeURIComponent(libraryId)}/items`, { offset, limit });
      return node.get("/internal/v1/library");
    },

    artwork: (itemId, variant) => node.request(`/internal/v1/library/items/${encodeURIComponent(itemId)}/artwork`, {
      query: { variant }, raw: true,
    }),

    // --- Playback ---------------------------------------------------------

    async play({ url, itemId, queueItemId, source, device = null, startAt = null }) {
      const refs = [url, itemId, queueItemId, source].filter((value) => value != null && value !== "");
      if (refs.length !== 1) throw new YoloError("invalid_request", "Pass exactly one of url, item_id, or queue_item_id");
      if (queueItemId) {
        const item = await queueStore.shiftQueue(db, userId, queueItemId);
        if (!item) throw new YoloError("not_found", `Queue item ${queueItemId} not found`);
        notifyQueue();
        try {
          return await hub.play({ source: item.source, device, startTime: startAt ?? 0, item });
        } catch (error) {
          await queueStore.addQueueItems(db, userId, [item], { position: "next" });
          notifyQueue();
          throw error;
        }
      }
      const resolved = await claimSource(node, source ?? refToSource({ url, itemId }));
      // Resume where the user left off unless told otherwise.
      let startTime = startAt;
      if (startTime == null) {
        const entry = await historyStore.getHistoryEntry(db, userId, sourceKey(resolved));
        startTime = entry && !(entry.duration > 0 && entry.position >= entry.duration - 30) ? entry.position : 0;
      }
      return hub.play({ source: resolved, device, startTime });
    },

    async control(action) {
      if (!CONTROL_ACTIONS.includes(action)) {
        throw new YoloError("invalid_request", `action must be one of ${CONTROL_ACTIONS.join(", ")}`);
      }
      return hub.control(action);
    },

    seek: (position) => hub.seek(position),
    transfer: (device) => hub.transfer(device),
    async listTracks({ source, url, itemId } = {}) {
      const ref = source ?? (url || itemId ? refToSource({ url, itemId }) : null);
      return hub.listTracks(ref ? await claimSource(node, ref) : null);
    },
    setTracks: ({ subtitles, audio }) => hub.setTracks({ subtitles, audio }),

    // --- Queue ------------------------------------------------------------

    listQueue: () => queueStore.listQueue(db, userId),

    async addToQueue({ url, itemId, source, position = "end" }) {
      const input = await describe(source ?? refToSource({ url, itemId }));
      const [item] = await queueStore.addQueueItems(db, userId, [input], { position });
      notifyQueue();
      return { item, queue: await queueStore.listQueue(db, userId) };
    },

    async removeFromQueue(id) {
      const item = await queueStore.removeQueueItem(db, userId, id);
      notifyQueue();
      return { removed: item };
    },

    async clearQueue() {
      const cleared = await queueStore.clearQueue(db, userId);
      notifyQueue();
      return { cleared };
    },

    async reorderQueue(ids) {
      const queue = await queueStore.reorderQueue(db, userId, ids);
      notifyQueue();
      return queue;
    },

    // --- Playlists --------------------------------------------------------

    listPlaylists: () => playlistStore.listPlaylists(db, userId),
    getPlaylist: (id) => playlistStore.getPlaylist(db, userId, id),

    async createPlaylist({ name, description }) {
      const playlist = await playlistStore.createPlaylist(db, userId, { name, description });
      notifyPlaylists();
      return playlist;
    },

    async updatePlaylist(id, changes) {
      const playlist = await playlistStore.updatePlaylist(db, userId, id, changes);
      notifyPlaylists();
      return playlist;
    },

    async deletePlaylist(id) {
      const playlist = await playlistStore.deletePlaylist(db, userId, id);
      notifyPlaylists();
      return { deleted: { id: playlist.id, name: playlist.name, itemCount: playlist.itemCount } };
    },

    async addToPlaylist(id, { url, itemId, source }) {
      const input = await describe(source ?? refToSource({ url, itemId }));
      const result = await playlistStore.addPlaylistItems(db, userId, id, [input]);
      notifyPlaylists();
      return { item: result.added[0], playlist: { id: result.playlist.id, name: result.playlist.name, itemCount: result.playlist.itemCount } };
    },

    async removeFromPlaylist(id, itemId) {
      const item = await playlistStore.removePlaylistItem(db, userId, id, itemId);
      notifyPlaylists();
      return { removed: item };
    },

    async reorderPlaylist(id, ids) {
      const playlist = await playlistStore.reorderPlaylist(db, userId, id, ids);
      notifyPlaylists();
      return playlist;
    },

    async enqueuePlaylist(id, { position = "end" } = {}) {
      const playlist = await playlistStore.getPlaylist(db, userId, id);
      if (!playlist.items.length) throw new YoloError("invalid_request", `Playlist ${playlist.name} is empty`);
      const added = await queueStore.addQueueItems(db, userId, playlist.items, { position });
      notifyQueue();
      return { added: added.length, queue: await queueStore.listQueue(db, userId) };
    },

    // A source plugin on the node expands an external playlist URL.
    async importPlaylist({ url, name = null, enqueue = false }) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "url must be an http(s) playlist URL");
      const expanded = await node.post("/internal/v1/playlists/expand", { url }, { timeoutMs: 60_000 });
      const items = (expanded.items || []).map((entry) => ({
        source: entry.source,
        title: entry.title,
        thumbnail: entry.thumbnail,
        duration: entry.duration,
        metadata: { importedFrom: url },
      }));
      if (!items.length) throw new YoloError("resolve_failed", "The playlist has no playable entries");
      const created = await playlistStore.createPlaylist(db, userId, { name: name || expanded.title || "Imported playlist" });
      const { playlist } = await playlistStore.addPlaylistItems(db, userId, created.id, items);
      notifyPlaylists();
      let queued = 0;
      if (enqueue) {
        queued = (await queueStore.addQueueItems(db, userId, items, { position: "end" })).length;
        notifyQueue();
      }
      return { playlist: { id: playlist.id, name: playlist.name, itemCount: playlist.itemCount }, imported: items.length, queued };
    },

    // --- History ----------------------------------------------------------

    history: ({ limit } = {}) => historyStore.listHistory(db, userId, { limit }),

    async deleteHistory({ sourceKey: key = null } = {}) {
      if (key && !isSourceKey(key)) throw new YoloError("invalid_request", "sourceKey must look like <source>:<id>, as in history");
      return { deleted: await historyStore.deleteHistory(db, userId, key) };
    },
  };
  return services;
}
