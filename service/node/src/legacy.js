import { YoloError } from "@useyolo/core";

// Bridge to the existing Drive-In server (server/, default :9090). Until the
// media pipeline moves into this node, playback still happens there: the node
// exposes that server's single player as the renderer "legacy", and the
// control plane drives it with the same session calls it will use later.
// Track preferences on this path are applied by the Drive-In server itself.

const RENDERER_ID = "legacy";

export function sourceFromLegacyUrl(url) {
  if (!url) return null;
  if (url.startsWith("plex://")) return { kind: "plex", ratingKey: url.slice("plex://".length) };
  return { kind: "url", url };
}

const sameSource = (a, b) => Boolean(a && b) && a.kind === b.kind
  && (a.kind === "plex" ? a.ratingKey === b.ratingKey : a.url === b.url);

const STATUS = { idle: "idle", resolving: "loading", playing: "playing", paused: "paused" };

export function createLegacyBridge({ baseUrl, fetchImpl = fetch, timeoutMs = 45_000 }) {
  // sessionId → source, for sessions this node started on the legacy player.
  const sessions = new Map();

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new YoloError("device_offline", "The Drive-In server is not running on the node", { cause: error });
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const message = typeof data.error === "string" ? data.error : `Drive-In answered ${response.status}`;
    if (response.status === 503 && /player/i.test(message)) throw new YoloError("device_offline", message);
    if (response.status === 400) throw new YoloError("invalid_request", message);
    if (response.status === 409) throw new YoloError("superseded", message);
    throw new YoloError("resolve_failed", message);
  }

  async function status() {
    return call("GET", "/api/status");
  }

  function startPlayback(source, { startTime = 0, reason = "play", subtitleStreamID, audioStreamID } = {}) {
    if (source.kind === "plex") {
      return call("POST", "/api/plex/play", {
        ratingKey: source.ratingKey,
        offset: Math.round(Math.max(0, startTime) * 1000),
        reason,
        ...(subtitleStreamID !== undefined ? { subtitleStreamID } : {}),
        ...(audioStreamID !== undefined ? { audioStreamID } : {}),
      });
    }
    return call("POST", "/api/play", { url: source.url, startTime: Math.max(0, startTime), reason });
  }

  function requireSession(sessionId) {
    const source = sessions.get(sessionId);
    if (!source) throw new YoloError("not_found", `Session ${sessionId} is not active on this node`);
    return source;
  }

  async function position() {
    const current = await status();
    return Number(current.player?.currentTime) || 0;
  }

  return {
    rendererId: RENDERER_ID,

    async health() {
      try {
        const current = await status();
        return { online: true, playerConnected: Boolean(current.playerConnected), status: current.status };
      } catch {
        return { online: false, playerConnected: false };
      }
    },

    async renderers() {
      let current;
      try {
        current = await status();
      } catch {
        return [];
      }
      const source = sourceFromLegacyUrl(current.url);
      const sessionId = [...sessions.entries()].reverse().find(([, value]) => sameSource(value, source))?.[0] ?? null;
      return [{
        id: RENDERER_ID,
        name: "Drive-In",
        kind: "car",
        online: Boolean(current.playerConnected),
        capabilities: { renderer: "external" },
        playback: {
          sessionId,
          status: STATUS[current.status] || "idle",
          title: current.title || null,
          position: Number(current.player?.currentTime) || 0,
          duration: Number(current.player?.duration) || null,
        },
      }];
    },

    async prepare({ sessionId, source, startTime, reason }) {
      const result = await startPlayback(source, { startTime, reason: reason === "transfer" ? "play" : reason });
      sessions.set(sessionId, source);
      // Keep the map small; only the latest few sessions matter.
      while (sessions.size > 16) sessions.delete(sessions.keys().next().value);
      return {
        sessionId,
        delivery: { type: "external", renderer: RENDERER_ID },
        profile: null,
        title: result.title || null,
        duration: null,
        isLive: Boolean(result.isLive),
        thumbnail: null,
        startTime,
        tracks: { subtitles: [], audio: [], selected: { subtitles: [], audio: null } },
      };
    },

    async control(sessionId, { action, position: target }) {
      const source = requireSession(sessionId);
      if (action === "seek") {
        await startPlayback(source, { startTime: Number(target) || 0, reason: "seek" });
        return { ok: true };
      }
      if (!["pause", "resume", "stop"].includes(action)) throw new YoloError("invalid_request", `Unknown action ${action}`);
      await call("POST", "/api/control", { action });
      if (action === "stop") sessions.delete(sessionId);
      return { ok: true };
    },

    async stop(sessionId) {
      if (!sessions.has(sessionId)) return { ok: true };
      const source = sessions.get(sessionId);
      sessions.delete(sessionId);
      // Only stop the player if it is still showing this session's source.
      const current = sourceFromLegacyUrl((await status().catch(() => ({}))).url);
      if (sameSource(current, source)) await call("POST", "/api/control", { action: "stop" });
      return { ok: true };
    },

    // Track ids: URL subtitles are `s_<lang>`, library tracks are `plex:<streamId>`.
    async setTracks(sessionId, { subtitles, audio }) {
      const source = requireSession(sessionId);
      if (source.kind === "url") {
        if (audio) throw new YoloError("invalid_request", "This video has no selectable audio tracks");
        const langs = (subtitles || []).map((id) => String(id).replace(/^s_/, ""));
        await call("POST", "/api/subtitles/select", { langs, sourceUrl: source.url });
        return { reload: null };
      }
      const streamId = (id) => (id ? String(id).replace(/^plex:/, "") : null);
      // Plex burns image subtitles into the transcode, so restart at the
      // current position with the new streams.
      await startPlayback(source, {
        startTime: await position(),
        reason: "seek",
        subtitleStreamID: subtitles === undefined ? undefined : streamId(subtitles[0]),
        audioStreamID: audio === undefined ? undefined : streamId(audio),
      });
      return { reload: null };
    },
  };
}
