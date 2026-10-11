import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { YoloError } from "@useyolo/core";

// The owner pairing code (decision 16): six digits that let the owner register
// the first passkey, or replace every passkey after losing them, on the control
// plane's /login page. The node issues and checks it; nothing about it is
// stored in Cloudflare. It lives only in this process as a salted hash: it
// expires after 15 minutes, dies after 5 wrong attempts, and works once.
// Issuing a new code replaces the old one; restarting the node drops it.
//
// Six digits are enough only because of these limits: the control plane's
// hostname is public in this repository, so anyone can try codes.

export const OWNER_CODE_TTL_MS = 15 * 60 * 1000;
export const OWNER_CODE_MAX_ATTEMPTS = 5;
const RUN_AGAIN = "run `npm run owner-code` on the home machine for a new one";

export function createOwnerCodes({ now = Date.now, ttlMs = OWNER_CODE_TTL_MS, maxAttempts = OWNER_CODE_MAX_ATTEMPTS } = {}) {
  let current = null; // { salt, hash, expiresAt, attempts }

  const digest = (salt, code) => createHash("sha256").update(salt).update(code).digest();

  function check(code) {
    if (current && current.expiresAt <= now()) current = null;
    if (!current) throw new YoloError("forbidden", `No pairing code is active; ${RUN_AGAIN}`);
    // Compare fixed-length digests in constant time, whatever was sent.
    const given = digest(current.salt, typeof code === "string" ? code : "");
    if (timingSafeEqual(given, current.hash)) return current;
    current.attempts += 1;
    const left = maxAttempts - current.attempts;
    if (left <= 0) {
      current = null;
      throw new YoloError("forbidden", `Too many wrong codes; ${RUN_AGAIN}`);
    }
    throw new YoloError("forbidden", `Wrong pairing code; ${left} ${left === 1 ? "try" : "tries"} left`);
  }

  return {
    issue() {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const salt = randomBytes(16);
      current = { salt, hash: digest(salt, code), expiresAt: now() + ttlMs, attempts: 0 };
      return { code, expiresAt: current.expiresAt };
    },
    // Checks without using the code up; a wrong code still counts.
    verify(code) {
      return { ok: true, expiresAt: check(code).expiresAt };
    },
    consume(code) {
      check(code);
      current = null;
      return { ok: true };
    },
  };
}
