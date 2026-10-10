import { newId, YoloError } from "@useyolo/core";
import { itemColumns, itemFromRow } from "./rows.js";

// Spotify-style queue: one per user (decision 6). Positions are REAL so
// "play next" can go before the head without renumbering.

export async function listQueue(db, userId) {
  const { results } = await db.prepare(
    "SELECT * FROM queue_items WHERE user_id = ? ORDER BY position ASC, added_at ASC",
  ).bind(userId).all();
  return results.map(itemFromRow);
}

export async function getQueueItem(db, userId, id) {
  return itemFromRow(await db.prepare("SELECT * FROM queue_items WHERE user_id = ? AND id = ?").bind(userId, id).first());
}

async function edgePosition(db, userId, where) {
  const row = await db.prepare(
    `SELECT MIN(position) AS head, MAX(position) AS tail FROM queue_items WHERE user_id = ?`,
  ).bind(userId).first();
  if (where === "next") return Number.isFinite(row?.head) ? row.head - 1 : 1;
  return Number.isFinite(row?.tail) ? row.tail + 1 : 1;
}

export async function addQueueItems(db, userId, inputs, { position = "end" } = {}) {
  if (!["next", "end"].includes(position)) throw new YoloError("invalid_request", "position must be next or end");
  const now = Date.now();
  let base = await edgePosition(db, userId, position);
  // "next" inserts the batch before the head in its original order.
  const step = position === "next" ? -1 : 1;
  const ordered = position === "next" ? [...inputs].reverse() : inputs;
  const items = [];
  const statements = ordered.map((input) => {
    const id = newId("itm");
    const columns = itemColumns(input);
    items.push({ id, ...columns, added_at: now });
    const statement = db.prepare(`
      INSERT INTO queue_items (id, user_id, source, title, thumbnail, duration, metadata, position, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, userId, columns.source, columns.title, columns.thumbnail, columns.duration, columns.metadata, base, now);
    base += step;
    return statement;
  });
  if (statements.length) await db.batch(statements);
  const added = items.map(itemFromRow);
  return position === "next" ? added.reverse() : added;
}

export async function removeQueueItem(db, userId, id) {
  const item = await getQueueItem(db, userId, id);
  if (!item) throw new YoloError("not_found", `Queue item ${id} not found`);
  await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND id = ?").bind(userId, id).run();
  return item;
}

export async function clearQueue(db, userId) {
  const result = await db.prepare("DELETE FROM queue_items WHERE user_id = ?").bind(userId).run();
  return result.meta?.changes ?? 0;
}

export async function reorderQueue(db, userId, ids) {
  const current = await listQueue(db, userId);
  const known = new Set(current.map((item) => item.id));
  if (!Array.isArray(ids) || ids.some((id) => !known.has(id))) {
    throw new YoloError("invalid_request", "ids must be existing queue item ids");
  }
  // Items not mentioned keep their relative order after the listed ones.
  const order = [...new Set(ids), ...current.map((item) => item.id).filter((id) => !ids.includes(id))];
  await db.batch(order.map((id, index) => (
    db.prepare("UPDATE queue_items SET position = ? WHERE user_id = ? AND id = ?").bind(index + 1, userId, id)
  )));
  return listQueue(db, userId);
}

// Remove and return the head, or a specific item.
export async function shiftQueue(db, userId, id = null) {
  const item = id ? await getQueueItem(db, userId, id) : (await listQueue(db, userId))[0];
  if (!item) return null;
  await db.prepare("DELETE FROM queue_items WHERE user_id = ? AND id = ?").bind(userId, item.id).run();
  return item;
}
