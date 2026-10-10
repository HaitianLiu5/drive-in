import { HISTORY_LIMIT, sourceKey } from "@useyolo/core";
import { parseJson } from "./rows.js";

function entryFromRow(row) {
  return {
    sourceKey: row.source_key,
    source: parseJson(row.source, null),
    title: row.title,
    thumbnail: row.thumbnail ?? null,
    position: row.position,
    duration: row.duration ?? null,
    playCount: row.play_count,
    updatedAt: row.updated_at,
  };
}

export async function listHistory(db, userId, { limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(Number(limit) || 50)));
  const { results } = await db.prepare("SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(userId, capped).all();
  return results.map(entryFromRow);
}

export async function getHistoryEntry(db, userId, key) {
  const row = await db.prepare("SELECT * FROM history WHERE user_id = ? AND source_key = ?").bind(userId, key).first();
  return row ? entryFromRow(row) : null;
}

// Called when playback starts: bump play_count and keep the newest 500.
export async function recordPlay(db, userId, { source, title, thumbnail = null, duration = null, position = 0 }) {
  const key = sourceKey(source);
  const now = Date.now();
  await db.batch([
    db.prepare(`
      INSERT INTO history (user_id, source_key, source, title, thumbnail, position, duration, play_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id, source_key) DO UPDATE SET
        title = excluded.title,
        thumbnail = COALESCE(excluded.thumbnail, history.thumbnail),
        duration = COALESCE(excluded.duration, history.duration),
        position = excluded.position,
        play_count = history.play_count + 1,
        updated_at = excluded.updated_at
    `).bind(userId, key, JSON.stringify(source), String(title || key), thumbnail, position, duration, now),
    db.prepare(`
      DELETE FROM history WHERE user_id = ? AND source_key NOT IN (
        SELECT source_key FROM history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
      )
    `).bind(userId, userId, HISTORY_LIMIT),
  ]);
  return key;
}

export async function recordProgress(db, userId, key, { position, duration }) {
  await db.prepare(`
    UPDATE history SET position = ?, duration = COALESCE(?, duration), updated_at = ?
    WHERE user_id = ? AND source_key = ?
  `).bind(position, duration ?? null, Date.now(), userId, key).run();
}

export async function deleteHistory(db, userId, key = null) {
  const result = key
    ? await db.prepare("DELETE FROM history WHERE user_id = ? AND source_key = ?").bind(userId, key).run()
    : await db.prepare("DELETE FROM history WHERE user_id = ?").bind(userId).run();
  return result.meta?.changes ?? 0;
}
