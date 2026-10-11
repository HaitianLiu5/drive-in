#!/usr/bin/env node
// Print a 6-digit owner pairing code (decision 16) for the control plane's
// /login page: the first passkey, or a reset after losing every passkey.
//
//   npm run owner-code                              (repository root)
//   npm run owner-code -- --origin https://yolo.example.com
//
// Asks the running node over its local socket, the only place a code can be
// issued (see src/local.js). Reads NODE_SECRET, NODE_LOCAL_SOCKET and
// PUBLIC_ORIGIN from the repository .env like the node does.
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { localSocketPath, requestLocal } from "../src/local.js";
import { OWNER_CODE_MAX_ATTEMPTS } from "../src/owner-code.js";

try {
  loadEnvFile(process.env.DRIVEIN_ENV_FILE ?? fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { origin: { type: "string" } } });
const secret = process.env.NODE_SECRET;
if (!secret) fail("NODE_SECRET is not set. Put it in the repository .env, as for the node.");

const socketPath = localSocketPath();
let response;
try {
  response = await requestLocal("/local/v1/owner-code", { socketPath, secret });
} catch (error) {
  if (["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
    fail([
      `The Yolo media node is not running: nothing answers on ${socketPath}.`,
      "Start it with `npm run dev:node` (restart it if it started before owner codes existed), then run this again.",
    ].join("\n"));
  }
  throw error;
}
if (response.status !== 200) fail(`The node refused: ${response.body?.error?.message || `HTTP ${response.status}`}`);

const { code, expiresAt } = response.body;
const origin = values.origin || process.env.PUBLIC_ORIGIN;
const signIn = origin ? new URL("/login", origin).href : "/login (on the control plane's address)";
const minutes = Math.round((expiresAt - Date.now()) / 60_000);
console.log(`
  Owner code: ${code}

  Enter it at ${signIn}
  Expires at ${new Date(expiresAt).toLocaleTimeString()} (in ${minutes} minutes), after ${OWNER_CODE_MAX_ATTEMPTS} wrong tries, or once used.
  If passkeys already exist, the new one replaces all of them and signs out every session.
  Running this again replaces the code.
`);
