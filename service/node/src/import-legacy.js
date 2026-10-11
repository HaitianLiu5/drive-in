import { HISTORY_LIMIT, isClaimed, sourceKey } from "@useyolo/core";
import { preferenceFromDriveIn, sourceFromDriveInHistory, sourceFromDriveInRow, thumbnailFromDriveIn } from "./legacy.js";

// One-time import of Drive-In's local data into D1 (yolo-v1.md §9):
// .drive-in.sqlite (queue, playlists, subtitle preferences) and
// .play-history.json. Produces SQL for `wrangler d1 execute --file`.
//
// Queue and playlist URLs are written unclaimed ({ url }) and get claimed when
// they play. History and track preferences are stored under source keys, so
// their URLs are claimed now through `claim(url)`, the node's source registry;
// an entry no plugin claims is skipped.

const quote = (value) => (value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

export async function buildImportSql({
  userId,
  queue = [],
  playlists = [],
  playlistItems = [],
  history = [],
  preferences = [],
  claim,
  now = Date.now(),
}) {
  if (!/^usr_[a-z0-9]+$/.test(userId || "")) throw new Error("A user id like usr_… is required (see the users table)");
  const lines = ["-- Drive-In → Yolo D1 import", `-- user ${userId}, generated ${new Date(now).toISOString()}`];
  const skipped = [];

  async function claimed(ref) {
    if (!ref || isClaimed(ref)) return ref;
    try {
      return await claim(ref.url);
    } catch (error) {
      skipped.push(`${ref.url}: ${error.message}`);
      return null;
    }
  }

  const item = (table, extraColumns, extraValues, row, position) => {
    const source = sourceFromDriveInRow(row);
    if (!source) return;
    const title = row.title || source.url || sourceKey(source);
    lines.push(`INSERT OR REPLACE INTO ${table} (id, user_id, ${extraColumns}source, title, thumbnail, duration, metadata, position, added_at) VALUES (${[
      quote(row.id), quote(userId), ...extraValues, quote(JSON.stringify(source)), quote(title),
      quote(thumbnailFromDriveIn(row.thumbnail, source)), row.duration ?? "NULL", quote(row.metadata || "{}"), position, row.added_at ?? now,
    ].join(", ")});`);
  };

  queue.forEach((row, index) => item("queue_items", "", [], row, index + 1));
  for (const playlist of playlists) {
    lines.push(`INSERT OR REPLACE INTO playlists (id, user_id, name, description, created_at, updated_at) VALUES (${[
      quote(playlist.id), quote(userId), quote(playlist.name), quote(playlist.description), playlist.created_at ?? now, playlist.updated_at ?? now,
    ].join(", ")});`);
  }
  playlistItems.forEach((row, index) => item("playlist_items", "playlist_id, ", [quote(row.playlist_id)], row, index + 1));

  const seen = new Set();
  for (const entry of history.slice(0, HISTORY_LIMIT)) {
    const source = await claimed(sourceFromDriveInHistory(entry));
    if (!source) continue;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`INSERT OR REPLACE INTO history (user_id, source_key, source, title, thumbnail, position, duration, play_count, updated_at) VALUES (${[
      quote(userId), quote(key), quote(JSON.stringify(source)), quote(entry.title || key), quote(thumbnailFromDriveIn(entry.thumbnail, source)),
      Number(entry.progress) || 0, Number(entry.duration) || "NULL", Math.max(1, Number(entry.viewCount) || 1), Number(entry.playedAt) || now,
    ].join(", ")});`);
  }

  for (const row of preferences) {
    const preference = preferenceFromDriveIn(row);
    if (!preference) continue;
    const source = preference.ref === "default" ? null : await claimed(preference.ref);
    if (preference.ref !== "default" && !source) continue;
    lines.push(`INSERT OR REPLACE INTO track_preferences (user_id, source_key, selection, updated_at) VALUES (${[
      quote(userId), quote(source ? sourceKey(source) : "default"), quote(JSON.stringify(preference.selection)), now,
    ].join(", ")});`);
  }
  return { sql: `${lines.join("\n")}\n`, skipped };
}
