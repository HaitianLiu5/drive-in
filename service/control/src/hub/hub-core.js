import {
  currentPosition,
  emptyPlaybackState,
  newId,
  preferenceFromTrack,
  sourceKey,
  YoloError,
} from "@useyolo/core";
import { getDevice, listDevices, touchDevice, upsertDevice } from "../store/devices.js";
import { getTrackPreferences, saveTrackPreferences } from "../store/preferences.js";
import { listHistory, recordPlay, recordProgress } from "../store/history.js";
import { listQueue, shiftQueue, addQueueItems } from "../store/queue.js";
import { listPlaylists } from "../store/playlists.js";

// The Hub owns "what is playing now" for one user (yolo-v1.md §2): the
// PlaybackState, which device is active, and the commands sent to devices.
// The node owns media sessions. This class has no Workers imports so it can be
// unit tested; hub.js wraps it in a Durable Object.
//
// Two kinds of devices exist:
// - realtime devices connect to /v1/realtime and receive `load`, `pause`, ….
// - node renderers (`node:<id>`) are players the node drives itself. v1 uses
//   this for the existing Drive-In server, so agents can control today's Tesla
//   player before it speaks the v1 realtime protocol.

const STATE_KEY = "state";
const NODE_DEVICE_PREFIX = "node:";
const PROGRESS_WRITE_INTERVAL_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;

export function isNodeDevice(deviceId) {
  return typeof deviceId === "string" && deviceId.startsWith(NODE_DEVICE_PREFIX);
}

export class HubCore {
  constructor({ userId, storage, db, node, transport, signMediaToken = null, now = () => Date.now() }) {
    this.userId = userId;
    this.storage = storage;
    this.db = db;
    this.node = node;
    this.transport = transport;
    this.signMediaToken = signMediaToken;
    this.now = now;
    this.generation = 0;
    this.lastProgressWrite = 0;
  }

  async state() {
    return (await this.storage.get(STATE_KEY)) || emptyPlaybackState();
  }

  async setState(next) {
    await this.storage.put(STATE_KEY, next);
    this.transport.broadcast({ v: 1, type: "state", state: next });
    return next;
  }

  async getState() {
    const state = await this.state();
    if (isNodeDevice(state.deviceId) && state.sessionId) await this.refreshNodeRendererState(state);
    const latest = await this.state();
    return { ...latest, position: currentPosition(latest, this.now()), positionAt: this.now() };
  }

  // Node renderers report their own progress; fold it in when asked.
  async refreshNodeRendererState(state) {
    try {
      const renderers = await this.nodeRenderers({ timeoutMs: 3_000 });
      const renderer = renderers.find((candidate) => candidate.id === state.deviceId);
      const playback = renderer?.playback;
      if (!playback || playback.sessionId !== state.sessionId) return;
      await this.storage.put(STATE_KEY, {
        ...state,
        status: playback.status || state.status,
        position: Number.isFinite(playback.position) ? playback.position : state.position,
        positionAt: this.now(),
        item: state.item && Number(playback.duration) > 0 ? { ...state.item, duration: playback.duration } : state.item,
      });
    } catch {
      // Node offline: keep the last known state.
    }
  }

  async nodeRenderers({ timeoutMs = 5_000 } = {}) {
    const result = await this.node.get("/internal/v1/renderers", undefined, { timeoutMs });
    return (result?.renderers || []).map((renderer) => ({
      ...renderer,
      id: `${NODE_DEVICE_PREFIX}${renderer.id}`,
      rendererId: renderer.id,
    }));
  }

  // --- Devices ---------------------------------------------------------

  async listDevices() {
    const state = await this.state();
    const connected = this.transport.connectedDeviceIds();
    const devices = (await listDevices(this.db, this.userId)).map((device) => ({
      ...device,
      online: connected.has(device.id),
      active: state.deviceId === device.id,
      via: "realtime",
    }));
    let nodeOnline = true;
    try {
      for (const renderer of await this.nodeRenderers()) {
        devices.push({
          id: renderer.id,
          name: renderer.name,
          kind: renderer.kind || "car",
          capabilities: renderer.capabilities || { renderer: "external" },
          online: Boolean(renderer.online),
          active: state.deviceId === renderer.id,
          lastSeenAt: renderer.lastSeenAt ?? null,
          via: "node",
        });
      }
    } catch {
      nodeOnline = false;
    }
    return { devices, nodeOnline };
  }

  // `ref` is a device id or a name. Without one, use the active device, or the
  // only online device.
  async resolveDevice(ref) {
    const { devices, nodeOnline } = await this.listDevices();
    if (ref) {
      const needle = String(ref).trim().toLowerCase();
      const device = devices.find((candidate) => candidate.id.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase() === needle)
        || devices.find((candidate) => candidate.name.toLowerCase().includes(needle));
      if (!device) throw new YoloError("not_found", `No device matches "${ref}". Use list_devices to see device names.`);
      if (!device.online) throw new YoloError("device_offline", `${device.name} is offline`);
      return device;
    }
    const online = devices.filter((device) => device.online);
    const active = online.find((device) => device.active);
    if (active) return active;
    if (online.length === 1) return online[0];
    if (!online.length && !nodeOnline) {
      throw new YoloError("node_offline", "The home media node is offline, so nothing can play right now.");
    }
    if (!online.length) {
      throw new YoloError("device_offline", "No playback device is online. Open the Drive-In player on a screen first.");
    }
    throw new YoloError(
      "invalid_request",
      `Several devices are online (${online.map((device) => device.name).join(", ")}); say which one to use.`,
    );
  }

  // --- Playback --------------------------------------------------------

  async play({ source, device: deviceRef = null, startTime = 0, reason = "play", sessionId = null, item = null }) {
    const generation = ++this.generation;
    const device = await this.resolveDevice(deviceRef);
    const previous = await this.state();
    const key = sourceKey(source);
    const preferences = await getTrackPreferences(this.db, this.userId, key);
    const nextSessionId = sessionId || newId("ses");
    const mediaToken = this.signMediaToken ? await this.signMediaToken(nextSessionId) : null;

    const descriptor = await this.node.post("/internal/v1/prepare", {
      sessionId: nextSessionId,
      source,
      capabilities: device.capabilities,
      viewport: null,
      startTime: Math.max(0, Number(startTime) || 0),
      reason,
      tracks: { preferences },
      renderer: device.via === "node" ? device.rendererId || device.id.slice(NODE_DEVICE_PREFIX.length) : null,
      mediaToken,
    }, { timeoutMs: PREPARE_TIMEOUT_MS });

    if (generation !== this.generation) {
      void this.stopNodeSession(nextSessionId);
      throw new YoloError("superseded", "A newer play request replaced this one");
    }

    if (previous.sessionId && previous.sessionId !== nextSessionId) void this.stopNodeSession(previous.sessionId);
    if (previous.deviceId && previous.deviceId !== device.id && !isNodeDevice(previous.deviceId)) {
      this.transport.send(previous.deviceId, { v: 1, type: "deactivate", deviceId: device.id });
    }

    const playbackItem = {
      source,
      title: descriptor.title || item?.title || key,
      thumbnail: descriptor.thumbnail ?? item?.thumbnail ?? null,
      duration: descriptor.duration ?? item?.duration ?? null,
      isLive: Boolean(descriptor.isLive),
    };
    const state = {
      status: device.via === "node" ? "playing" : "loading",
      deviceId: device.id,
      item: playbackItem,
      position: Number(descriptor.startTime ?? startTime) || 0,
      positionAt: this.now(),
      tracks: {
        subtitles: (descriptor.tracks?.selected?.subtitles || []).map(String),
        audio: descriptor.tracks?.selected?.audio ?? null,
      },
      sessionId: nextSessionId,
    };

    if (device.via !== "node") {
      this.transport.send(device.id, {
        v: 1, type: "load", id: newId("cmd", 8), stream: descriptor, startTime: state.position, autoplay: true, reason,
      });
    }
    if (reason === "play" || reason === "transfer") {
      await recordPlay(this.db, this.userId, { ...playbackItem, position: state.position });
    }
    await this.setState(state);
    return { state, device: { id: device.id, name: device.name } };
  }

  async requireSession() {
    const state = await this.state();
    if (!state.sessionId || !state.deviceId) throw new YoloError("invalid_request", "Nothing is playing");
    return state;
  }

  async sendCommand(state, command) {
    if (isNodeDevice(state.deviceId)) {
      await this.node.post(`/internal/v1/sessions/${encodeURIComponent(state.sessionId)}/control`, command);
      return;
    }
    const sent = this.transport.send(state.deviceId, { v: 1, id: newId("cmd", 8), ...command, type: command.action });
    if (!sent) throw new YoloError("device_offline", "The active device is offline");
  }

  async stopNodeSession(sessionId) {
    try {
      await this.node.post(`/internal/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {}, { timeoutMs: 5_000 });
    } catch {
      // Best effort: the node reaps idle sessions on its own.
    }
  }

  async control(action) {
    if (action === "next") return this.next();
    if (action === "previous") return this.previous();
    const state = await this.requireSession();
    const position = currentPosition(state, this.now());
    if (action === "stop") {
      if (isNodeDevice(state.deviceId)) await this.sendCommand(state, { action: "stop" });
      else this.transport.send(state.deviceId, { v: 1, type: "stop" });
      void this.stopNodeSession(state.sessionId);
      if (state.item) await recordProgress(this.db, this.userId, sourceKey(state.item.source), { position, duration: state.item.duration });
      return { state: await this.setState({ ...emptyPlaybackState(), deviceId: state.deviceId }) };
    }
    if (action !== "pause" && action !== "resume") throw new YoloError("invalid_request", `Unknown action ${action}`);
    await this.sendCommand(state, { action });
    return {
      state: await this.setState({
        ...state,
        status: action === "pause" ? "paused" : "playing",
        position,
        positionAt: this.now(),
      }),
    };
  }

  async next() {
    const item = await shiftQueue(this.db, this.userId);
    if (!item) throw new YoloError("not_found", "The queue is empty");
    void this.broadcastQueue();
    try {
      return await this.play({ source: item.source, item });
    } catch (error) {
      // Put it back at the head so a failed advance does not lose the item.
      await addQueueItems(this.db, this.userId, [item], { position: "next" });
      void this.broadcastQueue();
      throw error;
    }
  }

  async previous() {
    const state = await this.state();
    const currentKey = state.item ? sourceKey(state.item.source) : null;
    const entry = (await listHistory(this.db, this.userId, { limit: 20 })).find((candidate) => candidate.sourceKey !== currentKey);
    if (!entry) throw new YoloError("not_found", "There is nothing earlier in history");
    return this.play({ source: entry.source, item: entry });
  }

  async seek(positionSeconds) {
    const position = Number(positionSeconds);
    if (!Number.isFinite(position) || position < 0) throw new YoloError("invalid_request", "position must be a non-negative number of seconds");
    const state = await this.requireSession();
    await this.sendCommand(state, { action: "seek", position });
    return { state: await this.setState({ ...state, position, positionAt: this.now() }) };
  }

  async transfer(deviceRef) {
    if (!deviceRef) throw new YoloError("invalid_request", "device is required");
    const target = await this.resolveDevice(deviceRef);
    const state = await this.state();
    if (state.deviceId === target.id) return { state, device: { id: target.id, name: target.name } };
    if (!state.item) {
      if (state.deviceId && !isNodeDevice(state.deviceId)) {
        this.transport.send(state.deviceId, { v: 1, type: "deactivate", deviceId: target.id });
      }
      return { state: await this.setState({ ...state, deviceId: target.id }), device: { id: target.id, name: target.name } };
    }
    const position = currentPosition(state, this.now());
    if (isNodeDevice(state.deviceId) && state.sessionId) {
      await this.sendCommand(state, { action: "stop" }).catch(() => {});
    }
    return this.play({ source: state.item.source, device: target.id, startTime: position, reason: "transfer", item: state.item });
  }

  // --- Tracks ----------------------------------------------------------

  async listTracks(source = null) {
    const state = await this.state();
    const target = source || state.item?.source;
    if (!target) throw new YoloError("invalid_request", "Nothing is playing; pass an item to list its tracks");
    const tracks = await this.node.get("/internal/v1/tracks", { source: JSON.stringify(target) });
    const current = !source || (state.item && sourceKey(state.item.source) === sourceKey(target));
    return { source: target, ...tracks, selected: current ? state.tracks : tracks.selected ?? null };
  }

  async setTracks({ subtitles, audio }) {
    if (subtitles !== undefined && !Array.isArray(subtitles)) throw new YoloError("invalid_request", "subtitles must be an array of track ids");
    const state = await this.requireSession();
    const result = await this.node.post(`/internal/v1/sessions/${encodeURIComponent(state.sessionId)}/tracks`, {
      source: state.item.source,
      subtitles,
      audio,
      position: currentPosition(state, this.now()),
    });
    const available = [...(result.tracks?.subtitles || []), ...(result.tracks?.audio || [])];
    const byId = (id) => available.find((track) => String(track.id) === String(id));
    const selected = {
      subtitles: subtitles ?? state.tracks.subtitles,
      audio: audio ?? state.tracks.audio,
    };
    await saveTrackPreferences(this.db, this.userId, sourceKey(state.item.source), {
      subtitles: selected.subtitles.map(byId).filter(Boolean).map(preferenceFromTrack),
      audio: selected.audio && byId(selected.audio) ? preferenceFromTrack(byId(selected.audio)) : null,
    });
    if (!isNodeDevice(state.deviceId)) {
      this.transport.send(state.deviceId, result.reload
        ? { v: 1, type: "load", id: newId("cmd", 8), stream: result.reload, startTime: currentPosition(state, this.now()), autoplay: true, reason: "tracks" }
        : { v: 1, type: "tracks", tracks: result.tracks, selected });
    }
    return { state: await this.setState({ ...state, tracks: selected }), tracks: result.tracks };
  }

  // --- Realtime devices ------------------------------------------------

  async hello(message) {
    const device = await upsertDevice(this.db, this.userId, {
      id: typeof message.deviceId === "string" ? message.deviceId : null,
      name: message.name,
      kind: message.kind,
      capabilities: message.capabilities,
    });
    const [state, queue, playlists] = await Promise.all([this.getState(), listQueue(this.db, this.userId), listPlaylists(this.db, this.userId)]);
    return { device, welcome: { v: 1, type: "welcome", deviceId: device.id, state, queue, playlists } };
  }

  async deviceMessage(deviceId, message) {
    const state = await this.state();
    switch (message.type) {
      case "report": {
        if (state.deviceId !== deviceId) return;
        const status = ["idle", "loading", "playing", "paused", "buffering"].includes(message.status) ? message.status : state.status;
        const position = Number(message.position);
        const next = {
          ...state,
          status,
          position: Number.isFinite(position) ? position : state.position,
          positionAt: this.now(),
          item: state.item && Number(message.duration) > 0 ? { ...state.item, duration: Number(message.duration) } : state.item,
        };
        await this.setState(next);
        if (next.item && this.now() - this.lastProgressWrite > PROGRESS_WRITE_INTERVAL_MS) {
          this.lastProgressWrite = this.now();
          await recordProgress(this.db, this.userId, sourceKey(next.item.source), { position: next.position, duration: next.item.duration });
          void this.node.post(`/internal/v1/sessions/${encodeURIComponent(next.sessionId)}/progress`, {
            position: next.position, duration: next.item.duration, status,
          }).catch(() => {});
        }
        return;
      }
      case "ended":
        if (state.deviceId !== deviceId || message.sessionId !== state.sessionId) return;
        try {
          await this.next();
        } catch (error) {
          if (error.code !== "not_found") throw error;
          await this.setState({ ...emptyPlaybackState(), deviceId });
        }
        return;
      case "error":
        if (state.deviceId !== deviceId || message.sessionId !== state.sessionId) return;
        await this.setState({ ...state, status: "idle" });
        return;
      case "pong":
      case "ack":
        await touchDevice(this.db, this.userId, deviceId);
        return;
      default:
        throw new YoloError("invalid_request", `Unknown message type ${message.type}`);
    }
  }

  // Broadcasts are best effort and never fail the command that caused them.
  broadcastQueue() {
    return listQueue(this.db, this.userId)
      .then((queue) => this.transport.broadcast({ v: 1, type: "queue", queue }))
      .catch(() => {});
  }

  broadcastPlaylists() {
    return listPlaylists(this.db, this.userId)
      .then((playlists) => this.transport.broadcast({ v: 1, type: "playlists", playlists }))
      .catch(() => {});
  }

  broadcastDevices() {
    return this.listDevices()
      .then(({ devices }) => this.transport.broadcast({ v: 1, type: "devices", devices }))
      .catch(() => {});
  }

  async getDevice(id) {
    return getDevice(this.db, this.userId, id);
  }
}
