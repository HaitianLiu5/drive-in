import { HISTORY_LIMIT, isHttpUrl, sourceKey } from "@useyolo/core";

// One-time import of Drive-In's local data into D1 (yolo-v1.md §9):
// .drive-in.sqlite (queue, playlists, subtitle preferences) and
// .play-history.json. Produces SQL for `wrangler d1 execute --file`.

const quote = (value) => (value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);

function legacySource(row) {
  if (row.source_type === "plex" || row.rating_key) return { kind: "plex", ratingKey: String(row.rating_key) };
  return isHttpUrl(row.url) ? { kind: "url", url: row.url } : null;
}

// Legacy thumbnails point at server/ proxy routes; map them to what the
// control plane serves, or to the original URL.
export function migrateThumbnail(thumbnail, source) {
  if (!thumbnail) return null;
  if (source?.kind === "plex") return `/v1/library/items/${encodeURIComponent(`plex:${source.ratingKey}`)}/artwork?variant=landscape`;
  if (thumbnail.startsWith("/api/thumb?")) return new URLSearchParams(thumbnail.split("?")[1]).get("url");
  return isHttpUrl(thumbnail) ? thumbnail : null;
}

function legacyPreferenceKey(source) {
  if (source === "default") return "default";
  if (source.startsWith("plex:")) return source;
  return isHttpUrl(source) ? sourceKey({ kind: "url", url: source }) : null;
}

export function migratePreference(selection, key) {
  const plex = key.startsWith("plex:");
  return {
    subtitles: selection.map((track) => ({
      id: plex ? `plex:${track.id}` : `s_${track.id}`,
      language: track.language || "",
      name: track.title || "",
      format: track.delivery === "external" ? "text" : "image",
    })),
    audio: null,
  };
}

export function buildImportSql({ userId, queue = [], playlists = [], playlistItems = [], history = [], preferences = [], now = Date.now() }) {
  if (!/^usr_[a-z0-9]+$/.test(userId || "")) throw new Error("A user id like usr_… is required (see the users table)");
  const lines = ["-- Drive-In → Yolo D1 import", `-- user ${userId}, generated ${new Date(now).toISOString()}`];
  const item = (table, extraColumns, extraValues, row, position) => {
    const source = legacySource(row);
    if (!source) return;
    lines.push(`INSERT OR REPLACE INTO ${table} (id, user_id, ${extraColumns}source, title, thumbnail, duration, metadata, position, added_at) VALUES (${[
      quote(row.id), quote(userId), ...extraValues, quote(JSON.stringify(source)), quote(row.title || source.url || row.rating_key),
      quote(migrateThumbnail(row.thumbnail, source)), row.duration ?? "NULL", quote(row.metadata || "{}"), position, row.added_at ?? now,
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
    const source = entry.plex?.ratingKey ? { kind: "plex", ratingKey: String(entry.plex.ratingKey) } : isHttpUrl(entry.url) ? { kind: "url", url: entry.url } : null;
    if (!source) continue;
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`INSERT OR REPLACE INTO history (user_id, source_key, source, title, thumbnail, position, duration, play_count, updated_at) VALUES (${[
      quote(userId), quote(key), quote(JSON.stringify(source)), quote(entry.title || key), quote(migrateThumbnail(entry.thumbnail, source)),
      Number(entry.progress) || 0, Number(entry.duration) || "NULL", Math.max(1, Number(entry.viewCount) || 1), Number(entry.playedAt) || now,
    ].join(", ")});`);
  }

  for (const row of preferences) {
    const key = legacyPreferenceKey(row.source);
    if (!key) continue;
    let selection;
    try {
      selection = JSON.parse(row.selection);
    } catch {
      continue;
    }
    if (!Array.isArray(selection)) continue;
    lines.push(`INSERT OR REPLACE INTO track_preferences (user_id, source_key, selection, updated_at) VALUES (${[
      quote(userId), quote(key), quote(JSON.stringify(migratePreference(selection, key))), now,
    ].join(", ")});`);
  }
  return `${lines.join("\n")}\n`;
}

