import { YoloError } from "./errors.js";

// A Source says where content comes from (yolo-v1.md §4). v1 has `url`
// (resolved by yt-dlp on the node) and `plex`; `spotify` is reserved.
export const SOURCE_KINDS = Object.freeze(["url", "plex"]);

// Library item ids are `<provider>:<id>` so the public API never has to say
// "plex" in its routes, and the same string doubles as a source key.
const LIBRARY_ITEM_ID = /^plex:([A-Za-z0-9_-]{1,64})$/;

export function isHttpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    return Boolean(new URL(value.trim()).hostname);
  } catch {
    return false;
  }
}

export function normalizeSource(input) {
  if (!input || typeof input !== "object") throw new YoloError("invalid_request", "source is required");
  if (input.kind === "url") {
    if (!isHttpUrl(input.url)) throw new YoloError("invalid_request", "source.url must be an http(s) URL");
    return { kind: "url", url: input.url.trim() };
  }
  if (input.kind === "plex") {
    const ratingKey = String(input.ratingKey ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ratingKey)) throw new YoloError("invalid_request", "source.ratingKey is invalid");
    return { kind: "plex", ratingKey };
  }
  throw new YoloError("invalid_request", `Unsupported source kind: ${input.kind}`);
}

// Accept what an agent or client is likely to pass: a URL, a library item id
// (`plex:123`), or an already-built Source object.
export function sourceFromRef(ref) {
  if (ref && typeof ref === "object") return normalizeSource(ref);
  const value = String(ref ?? "").trim();
  if (!value) throw new YoloError("invalid_request", "A URL or item id is required");
  if (isHttpUrl(value)) return { kind: "url", url: value };
  const match = LIBRARY_ITEM_ID.exec(value);
  if (match) return { kind: "plex", ratingKey: match[1] };
  throw new YoloError(
    "invalid_request",
    `"${value}" is neither a URL nor a library item id. Use search or browse to find item ids.`,
  );
}

export function libraryItemId(source) {
  return source.kind === "plex" ? `plex:${source.ratingKey}` : null;
}

const TRACKING_PARAMS = /^(utm_\w+|si|feature|fbclid|gclid|spm_id_from|vd_source|share_source|share_medium)$/i;

// Canonical URL for history and track preferences: lowercase host, no hash,
// no tracking parameters, and one spelling per YouTube video.
export function canonicalUrl(value) {
  let url = new URL(String(value).trim());
  url.hash = "";
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (url.hostname === "youtu.be" && url.pathname.length > 1) {
    url = new URL(`https://youtube.com/watch?v=${encodeURIComponent(url.pathname.slice(1))}`);
  } else if (url.hostname === "youtube.com" && url.pathname.startsWith("/shorts/")) {
    url = new URL(`https://youtube.com/watch?v=${encodeURIComponent(url.pathname.split("/")[2] || "")}`);
  }
  for (const key of [...url.searchParams.keys()]) {
    // `t` is a start offset, not part of the video's identity.
    if (TRACKING_PARAMS.test(key) || (url.hostname === "youtube.com" && key === "t")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function sourceKey(source) {
  const normalized = normalizeSource(source);
  return normalized.kind === "plex" ? `plex:${normalized.ratingKey}` : `url:${canonicalUrl(normalized.url)}`;
}

export function sourceFromKey(key) {
  if (key.startsWith("plex:")) return { kind: "plex", ratingKey: key.slice(5) };
  if (key.startsWith("url:")) return { kind: "url", url: key.slice(4) };
  throw new YoloError("invalid_request", `Invalid source key: ${key}`);
}
