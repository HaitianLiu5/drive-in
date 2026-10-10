import { newId } from "@useyolo/core";

// v1 has exactly one user, the owner (decision 5 keeps the column anyway).

export async function getOwner(db) {
  return db.prepare("SELECT id, display_name AS displayName, created_at AS createdAt FROM users ORDER BY created_at ASC LIMIT 1").first();
}

export async function ensureOwner(db, displayName = "Owner") {
  const owner = await getOwner(db);
  if (owner) return owner;
  const id = newId("usr");
  await db.prepare("INSERT INTO users (id, user_id, display_name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, id, displayName, Date.now()).run();
  return getOwner(db);
}

export async function listPasskeys(db, userId) {
  const { results } = await db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC").bind(userId).all();
  return results.map((row) => ({
    id: row.id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: JSON.parse(row.transports || "[]"),
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function countPasskeys(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM passkeys").first();
  return row?.count ?? 0;
}

export async function getPasskey(db, id) {
  const row = await db.prepare("SELECT * FROM passkeys WHERE id = ?").bind(id).first();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: JSON.parse(row.transports || "[]"),
  };
}

export async function addPasskey(db, userId, { id, publicKey, counter, transports, deviceType, backedUp, name }) {
  await db.prepare(`
    INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, publicKey, counter, JSON.stringify(transports || []), deviceType ?? null, backedUp ? 1 : 0, name ?? null, Date.now()).run();
}

export async function updatePasskeyCounter(db, id, counter) {
  await db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(counter, Date.now(), id).run();
}

export async function isInitCodeUsed(db, codeHash) {
  return Boolean(await db.prepare("SELECT 1 AS used FROM init_codes_used WHERE code_hash = ?").bind(codeHash).first());
}

export async function markInitCodeUsed(db, userId, codeHash) {
  await db.prepare("INSERT OR IGNORE INTO init_codes_used (code_hash, user_id, used_at) VALUES (?, ?, ?)")
    .bind(codeHash, userId, Date.now()).run();
}

export async function recordNodeSeen(db, userId, { id = "node_home", version = null }) {
  await db.prepare(`
    INSERT INTO nodes (id, user_id, version, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, last_seen_at = excluded.last_seen_at
  `).bind(id, userId, version, Date.now()).run();
}

