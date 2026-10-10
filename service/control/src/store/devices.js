import { DEVICE_KINDS, newId, normalizeCapabilities, YoloError } from "@useyolo/core";
import { parseJson } from "./rows.js";

function deviceFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    capabilities: parseJson(row.capabilities, {}),
    lastSeenAt: row.last_seen_at ?? null,
  };
}

export async function listDevices(db, userId) {
  const { results } = await db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC")
    .bind(userId).all();
  return results.map(deviceFromRow);
}

export async function getDevice(db, userId, id) {
  const row = await db.prepare("SELECT * FROM devices WHERE user_id = ? AND id = ?").bind(userId, id).first();
  return row ? deviceFromRow(row) : null;
}

// `hello` from a device: create it on first contact, refresh it afterwards.
export async function upsertDevice(db, userId, { id, name, kind, capabilities }) {
  const now = Date.now();
  const deviceKind = DEVICE_KINDS.includes(kind) ? kind : "browser";
  const deviceName = String(name || "Unnamed device").slice(0, 100);
  const caps = JSON.stringify(normalizeCapabilities(capabilities));
  const existing = id ? await getDevice(db, userId, id) : null;
  if (existing) {
    await db.prepare("UPDATE devices SET name = ?, kind = ?, capabilities = ?, last_seen_at = ? WHERE user_id = ? AND id = ?")
      .bind(deviceName, deviceKind, caps, now, userId, id).run();
    return getDevice(db, userId, id);
  }
  const deviceId = newId("dev");
  await db.prepare("INSERT INTO devices (id, user_id, name, kind, capabilities, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(deviceId, userId, deviceName, deviceKind, caps, now, now).run();
  return getDevice(db, userId, deviceId);
}

export async function touchDevice(db, userId, id) {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE user_id = ? AND id = ?").bind(Date.now(), userId, id).run();
}

export async function renameDevice(db, userId, id, name) {
  if (!String(name ?? "").trim()) throw new YoloError("invalid_request", "name is required");
  const result = await db.prepare("UPDATE devices SET name = ? WHERE user_id = ? AND id = ?")
    .bind(String(name).trim().slice(0, 100), userId, id).run();
  if (!result.meta?.changes) throw new YoloError("not_found", `Device ${id} not found`);
  return getDevice(db, userId, id);
}

export async function deleteDevice(db, userId, id) {
  const result = await db.prepare("DELETE FROM devices WHERE user_id = ? AND id = ?").bind(userId, id).run();
  if (!result.meta?.changes) throw new YoloError("not_found", `Device ${id} not found`);
}
