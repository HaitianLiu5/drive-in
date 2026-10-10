import { Hono } from "hono";
import { errorBody, normalizeSource, toYoloError, verifyNodeRequest, YoloError } from "@useyolo/core";
import { describeInfo, playlistFromInfo, subtitleTracks } from "./ytdlp.js";

// The node's internal API (yolo-v1.md §8). Only the control plane calls it,
// through Workers VPC; every request must also carry a valid NODE_SECRET
// signature (defense in depth).

export const NODE_VERSION = "0.1.0";

export function createNodeApp({ secret, plex, ytdlp, legacy, startedAt = Date.now() }) {
  if (!secret) throw new Error("NODE_SECRET is required");
  const app = new Hono();

  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("node request failed", error);
    return c.json(errorBody(yolo), yolo.status);
  });
  app.notFound((c) => c.json(errorBody(new YoloError("not_found", "No such endpoint")), 404));

  app.use("/internal/*", async (c, next) => {
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
  });

  const json = async (c) => {
    try {
      return await c.req.json();
    } catch {
      throw new YoloError("invalid_request", "Request body must be JSON");
    }
  };

  const v1 = new Hono();

  v1.get("/health", async (c) => {
    const [legacyHealth, library, ytdlpVersion] = await Promise.all([legacy.health(), plex.health(), ytdlp.version()]);
    return c.json({
      version: NODE_VERSION,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      legacy: legacyHealth,
      library,
      ytdlp: { available: Boolean(ytdlpVersion), version: ytdlpVersion },
    });
  });

  v1.get("/renderers", async (c) => c.json({ renderers: await legacy.renderers() }));

  v1.post("/metadata", async (c) => {
    const source = normalizeSource((await json(c)).source);
    if (source.kind === "plex") return c.json(await plex.describe(source.ratingKey));
    return c.json(describeInfo(await ytdlp.info(source.url)));
  });

  v1.get("/tracks", async (c) => {
    let source;
    try {
      source = normalizeSource(JSON.parse(c.req.query("source") || "null"));
    } catch (error) {
      throw error instanceof YoloError ? error : new YoloError("invalid_request", "source must be a Source JSON object");
    }
    if (source.kind === "plex") return c.json(await plex.tracks(source.ratingKey));
    return c.json({ subtitles: subtitleTracks(await ytdlp.info(source.url)), audio: [] });
  });

  v1.post("/playlists/expand", async (c) => {
    const { url } = await json(c);
    return c.json(playlistFromInfo(await ytdlp.flatPlaylist(url), url));
  });

  // --- Library -------------------------------------------------------------
  v1.get("/library", async (c) => c.json({ libraries: await plex.libraries() }));
  v1.get("/library/search", async (c) => {
    const query = String(c.req.query("q") || "").trim();
    if (!query) throw new YoloError("invalid_request", "q is required");
    return c.json(await plex.search(query, { type: c.req.query("type") || null, limit: c.req.query("limit") }));
  });
  v1.get("/library/items/:id/children", async (c) => c.json(await plex.children(c.req.param("id"))));
  v1.get("/library/items/:id/artwork", async (c) => {
    const upstream = await plex.artwork(c.req.param("id"), c.req.query("variant"));
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") || "image/jpeg" },
    });
  });
  v1.get("/library/:libraryId/items", async (c) => c.json(await plex.libraryItems(c.req.param("libraryId"), {
    offset: c.req.query("offset"),
    limit: c.req.query("limit"),
  })));

  // --- Sessions ------------------------------------------------------------
  // Re-preparing an existing sessionId rebuilds that session (node restarts,
  // seeks). v1 can only render on the legacy Drive-In player; realtime devices
  // need the media pipeline that still lives in server/.
  v1.post("/prepare", async (c) => {
    const input = await json(c);
    const source = normalizeSource(input.source);
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
    const source = normalizeSource(input.source);
    const result = await legacy.setTracks(c.req.param("id"), { subtitles: input.subtitles, audio: input.audio });
    const tracks = source.kind === "plex" ? await plex.tracks(source.ratingKey) : { subtitles: subtitleTracks(await ytdlp.info(source.url)), audio: [] };
    return c.json({ tracks, reload: result.reload });
  });
  // The Drive-In server writes Plex progress itself today.
  v1.post("/sessions/:id/progress", (c) => c.json({ ok: true }));

  app.route("/internal/v1", v1);

  // Media (/m/{token}/…) still comes from the Drive-In server on this path.
  app.all("/m/*", (c) => c.json(errorBody(new YoloError("not_found", "Media streaming has not moved to the node yet")), 404));

  return app;
}
