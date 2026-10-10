import { newId, YoloError } from "@useyolo/core";
import { itemColumns, itemFromRow } from "./rows.js";

function playlistFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    itemCount: row.item_count ?? 0,
    duration: row.total_duration ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SUMMARY = `
  SELECT p.*, COUNT(i.id) AS item_count, SUM(i.duration) AS total_duration
  FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id
`;

export async function listPlaylists(db, userId) {
  const { results } = await db.prepare(`${SUMMARY} WHERE p.user_id = ? GROUP BY p.id ORDER BY p.updated_at DESC`)
    .bind(userId).all();
  return results.map(playlistFromRow);
}

export async function getPlaylist(db, userId, id) {
  const row = await db.prepare(`${SUMMARY} WHERE p.user_id = ? AND p.id = ? GROUP BY p.id`).bind(userId, id).first();
  if (!row) throw new YoloError("not_found", `Playlist ${id} not found`);
  const { results } = await db.prepare(
    "SELECT * FROM playlist_items WHERE user_id = ? AND playlist_id = ? ORDER BY position ASC, added_at ASC",
  ).bind(userId, id).all();
  return { ...playlistFromRow(row), items: results.map(itemFromRow) };
}

export async function createPlaylist(db, userId, { name, description = null }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new YoloError("invalid_request", "Playlist name is required");
  const id = newId("pl");
  const now = Date.now();
  await db.prepare("INSERT INTO playlists (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, trimmed.slice(0, 200), description ? String(description).slice(0, 2000) : null, now, now).run();
  return getPlaylist(db, userId, id);
}

export async function updatePlaylist(db, userId, id, { name, description }) {
  await getPlaylist(db, userId, id);
  const sets = [];
  const values = [];
  if (name !== undefined) {
    if (!String(name).trim()) throw new YoloError("invalid_request", "Playlist name cannot be empty");
    sets.push("name = ?");
    values.push(String(name).trim().slice(0, 200));
  }
  if (description !== undefined) {
    sets.push("description = ?");
    values.push(description ? String(description).slice(0, 2000) : null);
  }
  sets.push("updated_at = ?");
  values.push(Date.now());
  await db.prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).bind(...values, userId, id).run();
  return getPlaylist(db, userId, id);
}

export async function deletePlaylist(db, userId, id) {
  const playlist = await getPlaylist(db, userId, id);
  // D1 enforces foreign keys, but delete items explicitly so the cascade does
  // not depend on the PRAGMA in local tooling.
  await db.batch([
    db.prepare("DELETE FROM playlist_items WHERE user_id = ? AND playlist_id = ?").bind(userId, id),
    db.prepare("DELETE FROM playlists WHERE user_id = ? AND id = ?").bind(userId, id),
  ]);
  return playlist;
}

export async function addPlaylistItems(db, userId, id, inputs) {
  await getPlaylist(db, userId, id);
  const tail = await db.prepare("SELECT MAX(position) AS tail FROM playlist_items WHERE user_id = ? AND playlist_id = ?")
    .bind(userId, id).first();
  let position = Number.isFinite(tail?.tail) ? tail.tail + 1 : 1;
  const now = Date.now();
  const ids = [];
  const statements = inputs.map((input) => {
    const itemId = newId("itm");
    ids.push(itemId);
    const columns = itemColumns(input);
    return db.prepare(`
      INSERT INTO playlist_items (id, user_id, playlist_id, source, title, thumbnail, duration, metadata, position, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(itemId, userId, id, columns.source, columns.title, columns.thumbnail, columns.duration, columns.metadata, position++, now);
  });
  statements.push(db.prepare("UPDATE playlists SET updated_at = ? WHERE user_id = ? AND id = ?").bind(now, userId, id));
  await db.batch(statements);
  const playlist = await getPlaylist(db, userId, id);
  return { playlist, added: playlist.items.filter((item) => ids.includes(item.id)) };
}

export async function removePlaylistItem(db, userId, id, itemId) {
  const playlist = await getPlaylist(db, userId, id);
  const item = playlist.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new YoloError("not_found", `Item ${itemId} is not in playlist ${id}`);
  await db.batch([
    db.prepare("DELETE FROM playlist_items WHERE user_id = ? AND id = ?").bind(userId, itemId),
    db.prepare("UPDATE playlists SET updated_at = ? WHERE user_id = ? AND id = ?").bind(Date.now(), userId, id),
  ]);
  return item;
}

export async function reorderPlaylist(db, userId, id, ids) {
  const playlist = await getPlaylist(db, userId, id);
  const known = new Set(playlist.items.map((item) => item.id));
  if (!Array.isArray(ids) || ids.some((itemId) => !known.has(itemId))) {
    throw new YoloError("invalid_request", "ids must be items of this playlist");
  }
  const order = [...new Set(ids), ...playlist.items.map((item) => item.id).filter((itemId) => !ids.includes(itemId))];
  await db.batch(order.map((itemId, index) => (
    db.prepare("UPDATE playlist_items SET position = ? WHERE user_id = ? AND id = ?").bind(index + 1, userId, itemId)
  )));
  return getPlaylist(db, userId, id);
}
