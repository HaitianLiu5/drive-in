# AGENTS.md

## Project

Drive-In is a media player for Tesla browsers. It uses Mediabunny and WebCodecs to decode media, then renders frames to `<canvas>` because Tesla can freeze native `<video>` rendering while the vehicle is moving.

This is an npm workspaces repository:

- `server/` — Express, WebSocket control, yt-dlp, stream proxies, Plex, queues
- `player/` — Vite browser app and Mediabunny playback engine
- `cli/` — published `@drive-in/cli` HTTP client
- `skills/drive-in/` — agent instructions for operating a running server
- `service/core/` — shared Yolo logic: sources, track preferences, errors, HMAC signing
- `service/control/` — Yolo control plane, a Cloudflare Worker: `/mcp`, `/oauth/*`, `/v1/*`, D1, Hub Durable Object
- `service/node/` — Yolo media node on the home machine: `/internal/v1/*`, reached through Workers VPC

## Planned direction

Drive-In is being redesigned into Yolo: an agent-driven media service (Cloudflare control plane, home media node, MCP) with Drive-In as its Tesla client. Read `docs/yolo-decisions.md` for the decisions and open questions, and `docs/yolo-v1.md` for the protocol, before proposing architecture changes.

Implemented so far (`service/`): the remote MCP server with all v1 tools, OAuth with passkey owner sign-in, the `/v1` API, the Hub Durable Object with the realtime channel, D1 storage, `nodeFetch()`, and the media node's library and metadata API. Not yet moved: the media pipeline (`/m/*`, ffmpeg, HLS) still lives in `server/`, so the node drives today's Drive-In server as the renderer `node:legacy`. Keep `server/` and `cli/` until the MCP path is verified manually (decision 12); do not run the CLI removal checklist before then.

## Commands

```bash
npm install
npm run dev                    # server :9090 + Vite :5173
npm run check                  # all tests + production player build
npm run start                  # build and serve production app on :9090
SERVE_SOURCE=1 npm run dev:server
npm run dev:control            # Yolo control plane via wrangler dev (needs service/control/.dev.vars)
npm run dev:node               # Yolo media node on 127.0.0.1:9191 (needs NODE_SECRET)
```

Node.js 22.12 or newer is required. Playback also needs `yt-dlp`, `ffmpeg`, and Deno. Cloudflared is optional.

## Code map

- `server/index.js` owns routes, proxying, stream resolution, ffmpeg fallback, Plex playback, WebSocket state, and process lifecycle.
- `server/queue-store.js` owns SQLite queue and playlist persistence.
- `server/plex-subtitles.js` owns Plex subtitle classification, conversion, and caching.
- `server/plex-quality.js` owns the fixed Plex 720p playback profile.
- `server/stream-quality.js` owns viewport-based yt-dlp format selection.
- `server/security.js` owns safe cache-path resolution and external thumbnail fetching.
- `server/playback-coordinator.js` makes server playback transitions latest-wins.
- `server/history-store.js` owns atomic play-history persistence.
- `server/ws-protocol.js` validates player WebSocket messages.
- `player/src/main.js` owns routing and WebSocket connection lifecycle.
- `player/src/player.js` owns playback lifecycle, recovery, progress, and telemetry.
- `player/src/playback-generation.js` prevents stale play/stop transitions from mutating current playback.
- `player/src/engine/` owns decoding, audio buffering, presentation timing, and HLS prefetch.
- `cli/bin/drivein.js` is a standalone client and must not depend on server packages.
- `service/control/src/index.js` wires OAuthProvider, `/mcp`, `/v1`, `/v1/realtime`, and `/m/*`.
- `service/control/src/services.js` is the one service layer behind both MCP tools and `/v1` routes.
- `service/control/src/mcp/tools.js` defines the MCP tools, their scopes, and annotations.
- `service/control/src/hub/hub-core.js` owns playback state and device commands; `hub.js` wraps it in the Durable Object.
- `service/control/src/node-client.js` is the only way the control plane reaches the node (`nodeFetch()`).
- `service/control/migrations/` holds the D1 schema; every table has `user_id`.
- `service/node/src/app.js` serves `/internal/v1/*`; `legacy.js` bridges playback to `server/`.

## Implementation constraints

- Use plain JavaScript ES modules and 2-space indentation. Do not add TypeScript or a transpiler.
- Modules under `service/control/src` that tests import must not import `cloudflare:workers` (only `index.js` and `hub/hub.js` may), so they stay testable in plain Node.
- Keep `<canvas>` rendering. Replacing it with `<video>` breaks the core Tesla use case.
- COOP/COEP headers are required for the SharedArrayBuffer audio ring buffer.
- Production serves `player/dist/`; source mode serves `player/` and its Mediabunny import map.
- Audio starts muted until a user gesture unlocks the browser audio context.
- Keep decoded video queues memory-bounded. Network jitter belongs in encoded segment buffering, not a large canvas queue.
- HLS prefetch is single-flight so background buffering does not compete with foreground playback.
- Viewport quality changes must preserve playback position.
- Text subtitles are rendered in the browser; Plex image subtitles use burn-in.
- HTTP APIs, WebSocket control, and proxy routes have no built-in authentication. Do not describe a public tunnel as safe without an access layer.
- Runtime state belongs in ignored paths: `.drive-in.sqlite`, `.play-history.json`, `.hls-cache/`, `.media-cache/`, `.segment-cache/`, `.logs/`, and `.diag-reports/`.

Configuration belongs in environment variables documented by `.env.example`. Do not commit local tokens, databases, logs, caches, diagnostic reports, or built `player/dist/` files.

## Verification

Run `npm run check` for every code change. For route or playback changes, also verify the relevant stream type manually: `hls`, `direct`, `dash_split`, or `plex`.

When testing server startup, do not launch a second instance against the same repository while another instance is playing: startup clears stale `.hls-cache` sessions.
