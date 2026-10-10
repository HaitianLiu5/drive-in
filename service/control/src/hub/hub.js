import { DurableObject } from "cloudflare:workers";
import { errorBody, fromErrorBody, MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { HubCore } from "./hub-core.js";

// One Hub Durable Object per user (yolo-v1.md §2, §7). It keeps PlaybackState
// in its own storage and holds the realtime WebSockets with the hibernation API.

const PING_INTERVAL_MS = 25_000; // Cloudflare drops idle sockets after 100s.

// Methods the Worker may call over RPC; see hubClient() below.
const RPC_METHODS = new Set([
  "getState", "listDevices", "play", "control", "seek", "transfer",
  "listTracks", "setTracks", "broadcastQueue", "broadcastPlaylists", "broadcastDevices",
]);

export class Hub extends DurableObject {
  async core(userId) {
    if (userId) {
      if (!this.userId) this.userId = (await this.ctx.storage.get("userId")) || null;
      if (this.userId !== userId) {
        this.userId = userId;
        await this.ctx.storage.put("userId", userId);
      }
    } else if (!this.userId) {
      this.userId = await this.ctx.storage.get("userId");
    }
    if (!this.hubCore || this.hubCore.userId !== this.userId) {
      const secret = this.env.NODE_SECRET;
      this.hubCore = new HubCore({
        userId: this.userId,
        storage: this.ctx.storage,
        db: this.env.DB,
        node: createNodeClient(this.env),
        transport: this.transport(),
        signMediaToken: secret
          ? (sessionId) => signMediaToken(secret, {
            sessionId,
            userId: this.userId,
            exp: Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_SECONDS,
          })
          : null,
      });
    }
    return this.hubCore;
  }

  transport() {
    const sockets = () => this.ctx.getWebSockets()
      .map((ws) => ({ ws, deviceId: ws.deserializeAttachment()?.deviceId || null }))
      .filter((entry) => entry.deviceId);
    const sendTo = (ws, message) => {
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    };
    return {
      connectedDeviceIds: () => new Set(sockets().map((entry) => entry.deviceId)),
      send: (deviceId, message) => sockets()
        .filter((entry) => entry.deviceId === deviceId)
        .map((entry) => sendTo(entry.ws, message))
        .some(Boolean),
      broadcast: (message) => {
        for (const entry of sockets()) sendTo(entry.ws, message);
      },
    };
  }

  // Errors cross RPC as plain objects so codes like node_offline survive.
  async call(userId, method, args = []) {
    if (!RPC_METHODS.has(method)) return errorBody(new Error(`Unknown hub method ${method}`));
    try {
      const core = await this.core(userId);
      return { ok: true, value: await core[method](...args) };
    } catch (error) {
      return errorBody(error);
    }
  }

  async fetch(request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    await this.core(request.headers.get("x-yolo-user"));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ deviceId: null });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    if (!message || message.v !== 1 || typeof message.type !== "string") return;
    const core = await this.core();
    try {
      if (message.type === "hello") {
        const { device, welcome } = await core.hello(message);
        ws.serializeAttachment({ deviceId: device.id });
        ws.send(JSON.stringify(welcome));
        void core.broadcastDevices();
        return;
      }
      const deviceId = ws.deserializeAttachment()?.deviceId;
      if (!deviceId) return;
      await core.deviceMessage(deviceId, message);
    } catch (error) {
      console.warn("Hub message failed", message.type, error?.message);
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    const core = await this.core();
    void core.broadcastDevices();
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const ping = JSON.stringify({ v: 1, type: "ping", ts: Date.now() });
    for (const ws of sockets) {
      try {
        ws.send(ping);
      } catch {
        // Closed sockets are cleaned up by webSocketClose.
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }
}

// Worker-side proxy with the same async methods as HubCore.
export function hubClient(env, userId) {
  const stub = env.HUB.get(env.HUB.idFromName(userId));
  return new Proxy({}, {
    get(_target, method) {
      if (!RPC_METHODS.has(method)) return undefined;
      return async (...args) => {
        const result = await stub.call(userId, method, args);
        if (result?.ok) return result.value;
        throw fromErrorBody(result, 500);
      };
    },
  });
}
