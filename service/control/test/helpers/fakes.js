import { YoloError } from "@useyolo/core";

// In-memory stand-ins for the Hub's storage and WebSocket transport, and for
// the media node behind nodeFetch().

export function createMemoryStorage() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

export function createFakeTransport(connected = []) {
  const sent = [];
  const broadcasts = [];
  const online = new Set(connected);
  return {
    sent,
    broadcasts,
    online,
    connectedDeviceIds: () => new Set(online),
    send(deviceId, message) {
      if (!online.has(deviceId)) return false;
      sent.push({ deviceId, message });
      return true;
    },
    broadcast(message) {
      broadcasts.push(message);
    },
  };
}

// Routes are keyed "METHOD /path", where `*` matches one path segment;
// handlers get (body or query, path).
export function createFakeNode(routes = {}) {
  const calls = [];
  const node = {
    calls,
    offline: false,
    routes: { ...routes },
    async request(path, { method = "GET", body, query } = {}) {
      calls.push({ method, path, body, query });
      if (node.offline) throw new YoloError("node_offline", "Media node is offline");
      const handler = node.routes[`${method} ${path}`] ?? Object.entries(node.routes).find(([key]) => (
        key.includes("*") && new RegExp(`^${key.replace(/[.?]/g, "\\$&").replace(/\*/g, "[^/]+")}$`).test(`${method} ${path}`)
      ))?.[1];
      if (!handler) throw new YoloError("not_found", `No fake route for ${method} ${path}`);
      return structuredClone(await handler(method === "GET" ? query : body, path));
    },
    get(path, query, options = {}) {
      return node.request(path, { ...options, query });
    },
    post(path, body = {}, options = {}) {
      return node.request(path, { ...options, method: "POST", body });
    },
  };
  return node;
}

// A node with one legacy renderer (today's Drive-In player) and a library.
export function createDefaultNode() {
  return createFakeNode({
    "GET /internal/v1/health": () => ({ version: "0.1.0", legacy: { online: true } }),
    "GET /internal/v1/renderers": () => ({
      renderers: [{ id: "legacy", name: "Drive-In", kind: "car", online: true, capabilities: { renderer: "external" } }],
    }),
    "POST /internal/v1/prepare": (body) => ({
      sessionId: body.sessionId,
      delivery: { type: "external", renderer: body.renderer },
      title: body.source.kind === "plex" ? `Movie ${body.source.ratingKey}` : "A video",
      duration: 600,
      isLive: false,
      startTime: body.startTime,
      tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
    }),
    "POST /internal/v1/metadata": (body) => ({
      title: body.source.kind === "plex" ? `Movie ${body.source.ratingKey}` : "A video",
      thumbnail: null,
      duration: 600,
      isLive: false,
    }),
    "POST /internal/v1/sessions/*/control": () => ({ ok: true }),
    "POST /internal/v1/sessions/*/stop": () => ({ ok: true }),
    "GET /internal/v1/library": () => ({ libraries: [{ id: "plex:1", title: "Movies", type: "movie" }] }),
    "GET /internal/v1/library/search": (query) => ({
      results: [{ id: "plex:42", kind: "movie", title: `Result for ${query.q}` }],
    }),
  });
}
