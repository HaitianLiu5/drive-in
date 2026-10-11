#!/usr/bin/env node
// Export Drive-In's local queue, playlists, history and subtitle preferences
// as SQL for the Yolo D1 database. Run once, after registering the owner
// passkey (which creates the user row):
//
//   npx wrangler d1 execute yolo --remote --command "SELECT id FROM users"
//   node service/node/scripts/export-legacy-to-d1.js --user usr_… > yolo-import.sql
//   npx wrangler d1 execute yolo --remote --file yolo-import.sql   (in service/control)
//
// Reads DRIVEIN_DB / DRIVEIN_RUNTIME_DIR like server/ does; --db and
// --history override the paths. Nothing is written to the local files.
// History and track preferences are keyed by source, so URLs are claimed by
// the node's source plugins (the same config the node loads).
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadPluginConfig } from "@useyolo/plugin-api/host";
import { buildImportSql } from "../src/import-legacy.js";
import { loadPlugins } from "../src/plugins.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const root = process.env.DRIVEIN_RUNTIME_DIR || repository;
const { values } = parseArgs({
  options: {
    user: { type: "string" },
    db: { type: "string", default: process.env.DRIVEIN_DB || resolve(root, ".drive-in.sqlite") },
    history: { type: "string", default: resolve(root, ".play-history.json") },
  },
});

const tables = { queue: [], playlists: [], playlistItems: [], preferences: [] };
if (existsSync(values.db)) {
  const db = new Database(values.db, { readonly: true, fileMustExist: true });
  const has = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (has("queue_items")) tables.queue = db.prepare("SELECT * FROM queue_items ORDER BY position, added_at").all();
  if (has("playlists")) tables.playlists = db.prepare("SELECT * FROM playlists").all();
  if (has("playlist_items")) tables.playlistItems = db.prepare("SELECT * FROM playlist_items ORDER BY playlist_id, position, added_at").all();
  if (has("subtitle_preferences")) tables.preferences = db.prepare("SELECT * FROM subtitle_preferences").all();
  db.close();
} else {
  console.error(`No database at ${values.db}; exporting history only`);
}
const history = existsSync(values.history) ? JSON.parse(readFileSync(values.history, "utf8")) : [];

// Plugin messages go to stderr so stdout stays pure SQL.
const plugins = await loadPlugins(loadPluginConfig({ root: repository }).plugins, { logger: { ...console, info: console.error, debug: () => {} } });
await plugins.start();
try {
  const { sql, skipped } = await buildImportSql({
    userId: values.user,
    history: Array.isArray(history) ? history : [],
    ...tables,
    claim: (url) => plugins.sources.claim(url),
  });
  process.stdout.write(sql);
  for (const line of skipped) console.error(`Skipped ${line}`);
} finally {
  await plugins.shutdown();
}
console.error(`Exported ${tables.queue.length} queue items, ${tables.playlists.length} playlists, ${tables.playlistItems.length} playlist items, ${history.length} history entries, ${tables.preferences.length} preferences`);
