import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadPluginConfig } from "@useyolo/plugin-api/host";
import { createLocalApp, createNodeApp, NODE_VERSION } from "./app.js";
import { createLegacyBridge } from "./legacy.js";
import { listenLocal, localSocketPath } from "./local.js";
import { createOwnerCodes } from "./owner-code.js";
import { loadPlugins } from "./plugins.js";

// Yolo media node. Listens on loopback only; cloudflared + Workers VPC carry
// control plane requests to it (yolo-v1.md §8). Shares the repository .env
// with the Drive-In server; the source plugins read their settings from it.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

try {
  loadEnvFile(process.env.DRIVEIN_ENV_FILE ?? `${ROOT}.env`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const host = process.env.NODE_HOST || "127.0.0.1";
const port = Number(process.env.NODE_PORT || 9191);
const SHUTDOWN_TIMEOUT_MS = 5_000;

// yolo.config.json if it exists, else the official plugins (plugins/official.json).
const config = loadPluginConfig({ root: ROOT, env: process.env });
console.log(`Plugins from ${config.path}`);
const plugins = await loadPlugins(config.plugins, { env: process.env });
await plugins.start();
for (const plugin of plugins.status()) {
  const detail = plugin.error ? `: ${plugin.error}` : plugin.sources.length ? ` (sources: ${plugin.sources.join(", ")})` : "";
  console.log(`  ${plugin.name} ${plugin.status}${detail}`);
}

const ownerCodes = createOwnerCodes();
const app = createNodeApp({
  secret: process.env.NODE_SECRET,
  plugins,
  legacy: createLegacyBridge({ baseUrl: process.env.DRIVEIN_LEGACY_URL || "http://127.0.0.1:9090" }),
  ownerCodes,
});

serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`Yolo node ${NODE_VERSION} listening on http://${host}:${port}`);
});

// Owner pairing codes are issued only on this socket (see local.js).
const socketPath = localSocketPath();
listenLocal(createLocalApp({ secret: process.env.NODE_SECRET, ownerCodes }), socketPath).then(
  () => console.log(`Owner commands (npm run owner-code) on ${socketPath}`),
  (error) => console.error(`Owner commands are unavailable: ${error.message}`),
);

// Give plugins a bounded chance to release what they started (launchd sends
// SIGTERM on stop and restart), then exit.
let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping plugins`);
  const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
  await Promise.race([plugins.shutdown(), timeout]);
  process.exit(0);
}
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
