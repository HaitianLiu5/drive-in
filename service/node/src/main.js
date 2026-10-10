import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createNodeApp, NODE_VERSION } from "./app.js";
import { createLegacyBridge } from "./legacy.js";
import { createPlex } from "./plex.js";
import { createYtdlp } from "./ytdlp.js";

// Yolo media node. Listens on loopback only; cloudflared + Workers VPC carry
// control plane requests to it (yolo-v1.md §8). Shares the repository .env
// with the Drive-In server (PLEX_URL, PLEX_TOKEN, YTDLP_COOKIES_*).

try {
  loadEnvFile(process.env.DRIVEIN_ENV_FILE ?? fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const host = process.env.NODE_HOST || "127.0.0.1";
const port = Number(process.env.NODE_PORT || 9191);

const app = createNodeApp({
  secret: process.env.NODE_SECRET,
  plex: createPlex({ url: process.env.PLEX_URL, token: process.env.PLEX_TOKEN }),
  ytdlp: createYtdlp(),
  legacy: createLegacyBridge({ baseUrl: process.env.DRIVEIN_LEGACY_URL || "http://127.0.0.1:9090" }),
});

serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`Yolo node ${NODE_VERSION} listening on http://${host}:${port}`);
});
