import { DurableObject } from "cloudflare:workers";
import {
  createRateLimit,
  errorBody,
  fromErrorBody,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  MEDIA_TOKEN_TTL_SECONDS,
  newId,
  signMediaToken,
  YoloError,
} from "@useyolo/core";
import { createNodeClient } from "../node-client.js";
import { HubCore } from "./hub-core.js";

// One Hub Durable Object per user (yolo-v1.md §2, §7). It keeps PlaybackState
// in its own storage and holds the realtime WebSockets with the hibernation API.
//
// Nothing here wakes the Hub on a timer: devices send the heartbeat and the
// runtime answers it while the Hub sleeps. The limits below stop a buggy
// client (a reconnect loop, or a reply to every broadcast) from keeping the
// Hub awake and billing requests without end.

const MAX_SOCKETS = 16;
const CONNECT_LIMIT = { max: 20, windowMs: 60_000 };
// A playing device reports every 5 seconds plus state changes and acks.
const MESSAGE_LIMIT = { max: 30, windowMs: 10_000 };
const RATE_LIMITED_CLOSE = 1008;

// Methods the Worker may call over RPC; see hubClient() below.
const RPC_METHODS = new Set([
  "getState", "listDevices", "play", "control", "seek", "transfer",
  "listTracks", "setTracks", "broadcastQueue", "broadcastPlaylists", "broadcastDevices",
]);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
    this.allowConnect = createRateLimit(CONNECT_LIMIT);
    // socketId -> rate limit. Lost on hibernation, which needs a quiet Hub.
    this.messageLimits = new Map();
  }

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
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS || !this.allowConnect()) {
      return Response.json(errorBody(new YoloError("rate_limited", "Too many realtime connections; retry later")), { status: 429 });
    }
    await this.core(request.headers.get("x-yolo-user"));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ socketId: newId("sock", 8), deviceId: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  allowMessage(socketId) {
    if (!this.messageLimits.has(socketId)) this.messageLimits.set(socketId, createRateLimit(MESSAGE_LIMIT));
    return this.messageLimits.get(socketId)();
  }

  async webSocketMessage(ws, data) {
    const attachment = ws.deserializeAttachment() || {};
    if (!this.allowMessage(attachment.socketId)) {
      // Closing, not dropping: every message that reaches the Hub is billed.
      try {
        ws.close(RATE_LIMITED_CLOSE, "rate_limited");
      } catch {
        // Already closed.
      }
      return;
    }
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
        ws.serializeAttachment({ ...attachment, deviceId: device.id });
        ws.send(JSON.stringify(welcome));
        void core.broadcastDevices();
        return;
      }
      const { deviceId } = attachment;
      if (!deviceId) return;
      await core.deviceMessage(deviceId, message);
    } catch (error) {
      console.warn("Hub message failed", message.type, error?.message);
    }
  }

  async webSocketClose(ws, code, reason) {
    this.messageLimits.delete(ws.deserializeAttachment()?.socketId);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    const core = await this.core();
    void core.broadcastDevices();
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
