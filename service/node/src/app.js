import { Hono } from "hono";
import { errorBody, normalizeSource, toYoloError, verifyNodeRequest, YoloError } from "@useyolo/core";
import { createOwnerCodes } from "./owner-code.js";

// The node's internal API (yolo-v1.md §8). Only the control plane calls it,
// through Workers VPC; every request must also carry a valid NODE_SECRET
// signature (defense in depth).

export const NODE_VERSION = "0.2.0";

function baseApp(secret) {
  if (!secret) throw new Error("NODE_SECRET is required");
  const app = new Hono();
  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("node request failed", error);
    return c.json(errorBody(yolo), yolo.status);
  });
  app.notFound((c) => c.json(errorBody(new YoloError("not_found", "No such endpoint")), 404));
  return app;
}

const requireSignature = (secret) => async (c, next) => {
  const url = new URL(c.req.url);
  const body = ["GET", "HEAD"].includes(c.req.method) ? "" : await c.req.raw.clone().text();
  const ok = await verifyNodeRequest(secret, {
    method: c.req.method,
    path: url.pathname + url.search,
    body,
    headers: c.req.raw.headers,
  });
  if (!ok) return c.json(errorBody(new YoloError("unauthorized", "Bad or missing request signature")), 401);
  await next();
};

const json = async (c) => {
  try {
    return await c.req.json();
  } catch {
    throw new YoloError("invalid_request", "Request body must be JSON");
  }
};

// `plugins` is the plugin host from loadPlugins(): its source registry
// answers every source and library call, and its status goes into /health.
export function createNodeApp({ secret, plugins, legacy, ownerCodes = createOwnerCodes(), startedAt = Date.now() }) {
  const app = baseApp(secret);
  app.use("/internal/*", requireSignature(secret));
  const sources = plugins.sources;

  const v1 = new Hono();

  v1.get("/health", async (c) => {
    const [legacyHealth, sourceHealth] = await Promise.all([legacy.health(), sources.health()]);
    return c.json({
      version: NODE_VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      legacy: legacyHealth,
      sources: sourceHealth,
      plugins: plugins.status(),
    });
  });

  v1.get("/renderers", async (c) => c.json({ renderers: await legacy.renderers() }));

  // A URL becomes a Source when the first source plugin claims it.
  v1.post("/claim", async (c) => c.json({ source: await sources.claim((await json(c)).url) }));

  // { source } or { url }; returns the (claimed) source with its metadata.
  v1.post("/metadata", async (c) => {
    const input = await json(c);
    const source = input.source ? normalizeSource(input.source) : await sources.claim(input.url);
    return c.json({ source, ...(await sources.describe(source)) });
  });

  v1.get("/tracks", async (c) => {
    let source;
    try {
      source = normalizeSource(JSON.parse(c.req.query("source") || "null"));
    } catch (error) {
      throw error instanceof YoloError ? error : new YoloError("invalid_request", "source must be a Source JSON object");
    }
    return c.json(await sources.tracks(source));
  });

  v1.post("/playlists/expand", async (c) => c.json(await sources.expand((await json(c)).url)));

  // --- Library -------------------------------------------------------------
  v1.get("/library", async (c) => c.json(await sources.libraries()));
  v1.get("/library/search", async (c) => c.json(await sources.search(c.req.query("q"), {
    type: c.req.query("type") || null,
    limit: c.req.query("limit"),
  })));
  v1.get("/library/items/:id/children", async (c) => c.json(await sources.children(c.req.param("id"))));
  v1.get("/library/items/:id/artwork", async (c) => {
    const upstream = await sources.artwork(c.req.param("id"), c.req.query("variant"));
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") || "image/jpeg" },
    });
  });
  v1.get("/library/:libraryId/items", async (c) => c.json(await sources.items(c.req.param("libraryId"), {
    offset: c.req.query("offset"),
    limit: c.req.query("limit"),
  })));

  // --- Sessions ------------------------------------------------------------
  // Re-preparing an existing sessionId rebuilds that session (node restarts,
  // seeks). v1 can only render on the legacy Drive-In player; realtime devices
  // need the media pipeline that still lives in server/.
  v1.post("/prepare", async (c) => {
    const input = await json(c);
    const source = sources.require(input.source);
    if (input.renderer !== legacy.rendererId) {
      throw new YoloError("resolve_failed", "This node cannot stream to realtime devices yet; play on Drive-In instead");
    }
    return c.json(await legacy.prepare({
      sessionId: String(input.sessionId),
      source,
      startTime: Math.max(0, Number(input.startTime) || 0),
      reason: input.reason || "play",
    }));
  });
  v1.post("/sessions/:id/control", async (c) => c.json(await legacy.control(c.req.param("id"), await json(c))));
  v1.post("/sessions/:id/stop", async (c) => c.json(await legacy.stop(c.req.param("id"))));
  v1.post("/sessions/:id/tracks", async (c) => {
    const input = await json(c);
    const source = sources.require(input.source);
    const result = await legacy.setTracks(c.req.param("id"), { subtitles: input.subtitles, audio: input.audio });
    return c.json({ tracks: await sources.tracks(source), reload: result.reload });
  });
  // The Drive-In server writes library progress back itself today.
  v1.post("/sessions/:id/progress", (c) => c.json({ ok: true }));

  // --- Owner pairing code (decision 16) ------------------------------------
  // The control plane can check and use up a code, never issue one: issuing
  // is only on the local app below.
  v1.post("/owner-code/verify", async (c) => c.json(ownerCodes.verify((await json(c)).code)));
  v1.post("/owner-code/consume", async (c) => c.json(ownerCodes.consume((await json(c)).code)));

  app.route("/internal/v1", v1);

  // Media (/m/{token}/…) still comes from the Drive-In server on this path.
  app.all("/m/*", (c) => c.json(errorBody(new YoloError("not_found", "Media streaming has not moved to the node yet")), 404));

  return app;
}

// Owner commands run on the home machine (`npm run owner-code`). This app is
// served only on the local Unix socket (local.js), never on the TCP listener
// that the control plane reaches, so no request from Cloudflare can issue a
// code. Requests must still be signed with NODE_SECRET.
export function createLocalApp({ secret, ownerCodes }) {
  const app = baseApp(secret);
  app.use("*", requireSignature(secret));
  app.post("/local/v1/owner-code", (c) => c.json(ownerCodes.issue()));
  return app;
}
