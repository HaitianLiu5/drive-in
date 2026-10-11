import { isHttpUrl, normalizeSource, sourceKey, toYoloError, YoloError } from "@useyolo/core";

// The node's source registry (docs/yolo-plugins.md). Source plugins register
// implementations here; the internal API asks the registry, never a source
// directly. The registry owns everything that must look the same whichever
// plugin answers:
// - URLs go to sources in registration order; the first that claims one wins.
// - Library ids are `<source id>:<local id>`, so routes reach the right source
//   and the control plane never sees provider names.
// - Artwork variants become control plane URLs.

const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const LIBRARY_ID = /^([a-z][a-z0-9-]{0,31}):(.+)$/s;
export const SOURCE_METHODS = Object.freeze([
  "health", "claim", "expand", "describe", "tracks", "libraries", "items", "children", "search", "artwork",
]);

const artworkUrl = (itemId, variant) => (
  `/v1/library/items/${encodeURIComponent(itemId)}/artwork?variant=${encodeURIComponent(variant)}`
);

function thumbnailOf(itemId, value) {
  if (typeof value.artwork === "string" && value.artwork) return artworkUrl(itemId, value.artwork);
  return typeof value.thumbnail === "string" && value.thumbnail ? value.thumbnail : null;
}

function presentItem(sourceId, item) {
  if (!item || typeof item !== "object" || item.id == null || item.id === "") {
    throw new YoloError("internal", `Source ${sourceId} returned a library item without an id`);
  }
  const { artwork: _artwork, ...fields } = item;
  const id = `${sourceId}:${item.id}`;
  return { ...fields, id, thumbnail: thumbnailOf(id, item) };
}

const presentLibrary = (sourceId, library) => ({ ...library, id: `${sourceId}:${library.id}`, source: sourceId });

function toSource(sourceId, input) {
  if (!input || typeof input !== "object") throw new YoloError("internal", `Source ${sourceId} returned an invalid source`);
  return normalizeSource({ ...input, plugin: sourceId });
}

export function checkSourceImpl(id, impl) {
  if (!SOURCE_ID.test(String(id))) {
    throw new TypeError(`Source id "${id}" must be lowercase letters, digits and dashes, starting with a letter`);
  }
  if (!impl || typeof impl !== "object") throw new TypeError(`Source ${id} must be an object of methods`);
  for (const method of SOURCE_METHODS) {
    if (impl[method] !== undefined && typeof impl[method] !== "function") throw new TypeError(`Source ${id}: ${method} must be a function`);
  }
  return Object.keys(impl).filter((key) => !SOURCE_METHODS.includes(key));
}

export function createSourceRegistry() {
  const sources = new Map(); // id → { id, plugin, impl }, in registration order

  function forId(id) {
    const entry = sources.get(id);
    if (!entry) throw new YoloError("not_found", `No source plugin "${id}" is loaded on this media node`);
    return entry;
  }

  const forSource = (source) => forId(normalizeSource(source).plugin);

  function method(entry, name) {
    const fn = entry.impl[name];
    if (!fn) throw new YoloError("not_found", `Source ${entry.id} does not support ${name}`);
    return fn.bind(entry.impl);
  }

  function parseLibraryId(value) {
    const match = LIBRARY_ID.exec(String(value ?? ""));
    if (!match) throw new YoloError("invalid_request", `Not a library id: ${value}`);
    return { entry: forId(match[1]), localId: match[2] };
  }

  // Ask every source that implements `name`; fail only if all of them fail.
  async function fanOut(name, call) {
    const providers = [...sources.values()].filter((entry) => entry.impl[name]);
    if (!providers.length) throw new YoloError("not_found", "No library source is enabled on this media node");
    const settled = await Promise.allSettled(providers.map((entry) => call(entry, method(entry, name))));
    if (settled.every((result) => result.status === "rejected")) throw toYoloError(settled[0].reason);
    const values = [];
    const unavailable = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") values.push(...result.value);
      else unavailable.push({ source: providers[index].id, error: toYoloError(result.reason).message });
    });
    return { values, unavailable };
  }

  return {
    has: (id) => sources.has(id),
    ids: () => [...sources.keys()],

    // Called by the plugin loader once a plugin's factory has succeeded.
    add(id, impl, plugin) {
      checkSourceImpl(id, impl);
      if (sources.has(id)) throw new TypeError(`Source id "${id}" is already registered by ${sources.get(id).plugin}`);
      sources.set(id, { id, plugin, impl });
    },

    remove(id) {
      sources.delete(id);
    },

    // Throws not_found unless the source's plugin is loaded.
    require(source) {
      forSource(source);
      return normalizeSource(source);
    },

    async health() {
      return Promise.all([...sources.values()].map(async (entry) => {
        try {
          const status = entry.impl.health ? await entry.impl.health() : {};
          return { id: entry.id, plugin: entry.plugin, ...(status && typeof status === "object" ? status : {}) };
        } catch (error) {
          return { id: entry.id, plugin: entry.plugin, online: false, error: toYoloError(error).message };
        }
      }));
    },

    async claim(url) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "A valid http(s) URL is required");
      for (const entry of sources.values()) {
        if (!entry.impl.claim) continue;
        const claimed = await entry.impl.claim(url.trim());
        if (claimed != null) return toSource(entry.id, claimed);
      }
      throw new YoloError("not_found", "No source plugin on the media node handles this URL");
    },

    async expand(url) {
      if (!isHttpUrl(url)) throw new YoloError("invalid_request", "url must be an http(s) playlist URL");
      const target = url.trim();
      for (const entry of sources.values()) {
        if (!entry.impl.expand) continue;
        const collection = await entry.impl.expand(target);
        if (collection == null) continue;
        const items = (Array.isArray(collection.items) ? collection.items : []).map((item) => {
          const source = toSource(entry.id, item.source);
          return {
            source,
            title: item.title ?? null,
            thumbnail: thumbnailOf(sourceKey(source), item),
            duration: item.duration ?? null,
          };
        });
        return { title: collection.title ?? null, url: target, items };
      }
      throw new YoloError("not_found", "No source plugin on the media node can expand this playlist URL");
    },

    async describe(source) {
      const entry = forSource(source);
      const result = (await method(entry, "describe")(normalizeSource(source))) ?? {};
      return {
        title: result.title ?? null,
        thumbnail: thumbnailOf(sourceKey(source), result),
        duration: result.duration ?? null,
        isLive: Boolean(result.isLive),
      };
    },

    async tracks(source) {
      const entry = forSource(source);
      if (!entry.impl.tracks) return { subtitles: [], audio: [] };
      const result = (await entry.impl.tracks(normalizeSource(source))) ?? {};
      return { subtitles: result.subtitles ?? [], audio: result.audio ?? [] };
    },

    async libraries() {
      const { values, unavailable } = await fanOut("libraries", async (entry, libraries) => (
        ((await libraries()) ?? []).map((library) => presentLibrary(entry.id, library))
      ));
      return { libraries: values, ...(unavailable.length ? { unavailable } : {}) };
    },

    async items(libraryId, { offset = 0, limit = 50 } = {}) {
      const { entry, localId } = parseLibraryId(libraryId);
      const page = {
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
        limit: Math.min(200, Math.max(1, Math.floor(Number(limit) || 50))),
      };
      const result = (await method(entry, "items")(localId, page)) ?? {};
      return {
        total: result.total ?? null,
        offset: result.offset ?? page.offset,
        items: (result.items ?? []).map((item) => presentItem(entry.id, item)),
      };
    },

    async children(itemId) {
      const { entry, localId } = parseLibraryId(itemId);
      const result = (await method(entry, "children")(localId)) ?? {};
      return {
        ...(result.parent ? { parent: presentItem(entry.id, result.parent) } : {}),
        items: (result.items ?? []).map((item) => presentItem(entry.id, item)),
      };
    },

    async search(query, { type = null, limit = 20 } = {}) {
      const text = String(query ?? "").trim();
      if (!text) throw new YoloError("invalid_request", "q is required");
      const max = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
      const { values, unavailable } = await fanOut("search", async (entry, search) => (
        ((await search(text, { type: type || null, limit: max })) ?? []).map((item) => presentItem(entry.id, item))
      ));
      return { results: values.slice(0, max), ...(unavailable.length ? { unavailable } : {}) };
    },

    async artwork(itemId, variant) {
      const { entry, localId } = parseLibraryId(itemId);
      return method(entry, "artwork")(localId, variant || "poster");
    },
  };
}
