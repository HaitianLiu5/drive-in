import { normalizeSourceRef, sourceKey } from "@useyolo/core";

export function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Queue items and playlist items share one Item shape (yolo-v1.md §4). Their
// source is a plugin Source, or an unclaimed { url } added while the node was
// offline, which is claimed when it plays.
export function itemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: parseJson(row.source, null),
    title: row.title,
    thumbnail: row.thumbnail ?? null,
    duration: row.duration ?? null,
    metadata: parseJson(row.metadata, {}),
    addedAt: row.added_at,
  };
}

export function itemColumns(input) {
  const source = normalizeSourceRef(input.source);
  const duration = Number(input.duration);
  return {
    source: JSON.stringify(source),
    title: String(input.title || source.url || `Library item ${sourceKey(source)}`).slice(0, 500),
    thumbnail: input.thumbnail ? String(input.thumbnail).slice(0, 2000) : null,
    duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
    metadata: JSON.stringify(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
  };
}
