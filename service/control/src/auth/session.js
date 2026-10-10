import { randomToken, sha256 } from "@useyolo/core";

// Owner sessions after passkey sign-in. The cookie holds a random id; KV holds
// only its hash.

export const SESSION_COOKIE = "__Host-yolo-session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const kvKey = async (id) => `yolo:session:${await sha256(id)}`;

export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function cookie(name, value, { maxAge, sameSite = "Lax" } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; SameSite=${sameSite}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`;
}

export async function createSession(kv, userId) {
  const id = randomToken();
  await kv.put(await kvKey(id), JSON.stringify({ userId, createdAt: Date.now() }), { expirationTtl: SESSION_TTL_SECONDS });
  return cookie(SESSION_COOKIE, id, { maxAge: SESSION_TTL_SECONDS });
}

export async function getSession(kv, request) {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!id) return null;
  const value = await kv.get(await kvKey(id));
  return value ? JSON.parse(value) : null;
}

export async function destroySession(kv, request) {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (id) await kv.delete(await kvKey(id));
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}
