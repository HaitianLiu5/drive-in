import { YoloError } from "./errors.js";

// A Source says where content comes from (yolo-v1.md §4). Sources belong to
// source plugins on the media node (decision 21, docs/yolo-plugins.md):
//
//   { plugin: "<source id>", id: "<item id within it>", ...fields }
//
// The plugin defines `id` and any other fields; core stores them unchanged and
// only ever reads `plugin` and `id`. `<plugin>:<id>` is the source key that
// history, resume positions and track preferences are stored under, and it is
// also the library item id agents pass around.
//
// A web address that no plugin has claimed yet is an unclaimed reference
// `{ url }`. The control plane asks the node which plugin claims it, before
// playing it or when adding it to the queue; while the node is offline, the
// queue and playlists keep it unclaimed.

const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE_KEY = /^[a-z][a-z0-9-]{0,31}:./s;
// What agents and clients may pass as a library item id.
const ITEM_REF = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._~-]{1,128})$/;
const MAX_ID_LENGTH = 2048;
const MAX_SOURCE_LENGTH = 4096;

export function isHttpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return false;
  try {
    return Boolean(new URL(value.trim()).hostname);
  } catch {
    return false;
  }
}

export const isSourceId = (value) => typeof value === "string" && SOURCE_ID.test(value);
export const isSourceKey = (value) => typeof value === "string" && SOURCE_KEY.test(value);

// True for a plugin Source, false for an unclaimed `{ url }` (or anything else).
export const isClaimed = (source) => Boolean(source && typeof source === "object" && isSourceId(source.plugin));

export function normalizeSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new YoloError("invalid_request", "source is required");
  const { plugin, id, ...fields } = input;
  if (!isSourceId(plugin)) {
    // Rows written before source plugins carried a `kind` instead.
    const hint = "kind" in input ? "; this source was saved before source plugins (apply D1 migration 0003)" : "";
    throw new YoloError("invalid_request", `source.plugin must be a source id${hint}`);
  }
  const itemId = typeof id === "number" && Number.isFinite(id) ? String(id) : id;
  if (typeof itemId !== "string" || !itemId || itemId.length > MAX_ID_LENGTH) {
    throw new YoloError("invalid_request", "source.id must be a non-empty string");
  }
  const source = { plugin, id: itemId, ...fields };
  let json;
  try {
    json = JSON.stringify(source);
  } catch {
    json = null;
  }
  if (!json || json.length > MAX_SOURCE_LENGTH) throw new YoloError("invalid_request", "source must be a small JSON object");
  return source;
}

// A plugin Source, or an unclaimed `{ url }`. Any object without `plugin` but
// with an http(s) `url` counts as unclaimed.
export function normalizeSourceRef(input) {
  if (input && typeof input === "object" && !("plugin" in input) && isHttpUrl(input.url)) return { url: input.url.trim() };
  return normalizeSource(input);
}

// Accept what an agent or client is likely to pass: a URL, a library item id
// (`<source id>:<item id>` from search or browse), or a Source object.
export function sourceFromRef(ref) {
  if (ref && typeof ref === "object") return normalizeSourceRef(ref);
  const value = String(ref ?? "").trim();
  if (!value) throw new YoloError("invalid_request", "A URL or item id is required");
  if (isHttpUrl(value)) return { url: value };
  const match = ITEM_REF.exec(value);
  if (match) return { plugin: match[1], id: match[2] };
  throw new YoloError(
    "invalid_request",
    `"${value}" is neither a URL nor a library item id. Use search or browse to find item ids.`,
  );
}

export function sourceKey(source) {
  if (!isClaimed(source)) throw new YoloError("invalid_request", "No source plugin has claimed this URL yet");
  const { plugin, id } = normalizeSource(source);
  return `${plugin}:${id}`;
}
