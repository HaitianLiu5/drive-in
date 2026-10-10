const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

// Random, URL-safe identifiers such as `itm_k3j9…`. 16 base-36 characters
// carry about 82 bits, which is plenty for single-user row ids.
export function newId(prefix, length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${id}`;
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
