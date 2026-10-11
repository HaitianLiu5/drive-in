// @useyolo/plugin-api: the plugin API (docs/yolo-plugins.md). Experimental
// until Yolo 1.0: it may change incompatibly in any release before that.
//
// A plugin is an npm package whose package.json names its entry points:
//
//   "yolo": { "node": "./src/node.js", "control": "./src/control.js" }
//
// Either entry may be absent. Each entry is an ES module whose default export
// is a factory. Yolo calls it once with the API for that side, and the factory
// registers what the plugin provides:
//
//   /** @param {import("@useyolo/plugin-api").YoloNodeAPI} yolo */
//   export default function (yolo) {
//     yolo.registerSource("example", { claim: (url) => …, describe: (source) => … });
//   }
//
// Plugins list this package under peerDependencies. The host provides it, so
// every plugin shares the host's copy and its YoloError class.

export { isHttpUrl, YoloError } from "@useyolo/core";

/**
 * Where an item comes from. `plugin` is the source id that a source plugin
 * registered, and `id` names the item within that source. Other fields belong
 * to the plugin; Yolo stores them unchanged and never reads them.
 *
 * `<plugin>:<id>` is the item's source key, which history, resume positions
 * and track preferences are stored under. A plugin must therefore return the
 * same `id` for the same content every time.
 * @typedef {{ plugin: string, id: string, [field: string]: unknown }} Source
 */

/**
 * A Source as a source method returns it. Yolo sets `plugin` to the source's
 * own id, and turns a numeric `id` into a string.
 * @typedef {{ id: string | number, [field: string]: unknown }} SourceInput
 */

/**
 * A subtitle or audio track.
 * @typedef {object} Track
 * @property {string} id  Stable for the same item: saved track choices match on it.
 * @property {"subtitle" | "audio"} kind
 * @property {string} language  Language code or name, such as "en" or "chi".
 * @property {string} name
 * @property {boolean} [auto]  An automatic caption.
 * @property {"text" | "image"} [format]
 * @property {boolean} [default]
 */

/** @typedef {{ subtitles: Track[], audio: Track[] }} TrackList */

/**
 * Title and artwork for one item. Give the artwork either as `thumbnail`, an
 * absolute http(s) URL, or as `artwork`, a variant name such as "poster" or
 * "landscape" that the source's own `artwork()` serves; Yolo turns a variant
 * into a control plane URL.
 * @typedef {object} Metadata
 * @property {string | null} title
 * @property {string | null} [thumbnail]
 * @property {string} [artwork]
 * @property {number | null} [duration]  Seconds.
 * @property {boolean} [isLive]
 */

/**
 * A library entry: a movie, show, season, episode, or anything a source lists.
 * `id` is local to the source; Yolo prefixes it as `<source id>:<id>`, and
 * playing the entry plays the Source `{ plugin: <source id>, id }`. Fields
 * other than `id` and `artwork` are passed through as they are.
 * @typedef {object} LibraryItem
 * @property {string} id
 * @property {string} kind  "movie", "show", "season", "episode", …
 * @property {string} title
 * @property {string | null} [thumbnail]
 * @property {string} [artwork]  See Metadata.
 */

/** @typedef {{ id: string, title: string, type?: string }} Library */

/**
 * A playlist or collection behind one URL.
 * @typedef {object} Collection
 * @property {string | null} [title]
 * @property {Array<{ source: SourceInput, title?: string, thumbnail?: string | null, duration?: number | null }>} items
 */

/**
 * What a source can do. Every method is optional; Yolo calls only what the
 * source implements, and only after the node has started the plugin.
 *
 * URLs go through the sources in registration order: `claim` and `expand`
 * return `undefined` to pass the URL to the next source, and the first
 * other answer wins. Keep `claim` cheap and offline (no network, no
 * subprocess): the control plane calls it before every play of a URL.
 * @typedef {object} SourceImpl
 * @property {() => object | Promise<object>} [health]  Free-form status for /internal/v1/health.
 * @property {(url: string) => SourceInput | undefined | Promise<SourceInput | undefined>} [claim]
 * @property {(url: string) => Promise<Collection | undefined>} [expand]
 * @property {(source: Source) => Promise<Metadata>} [describe]
 * @property {(source: Source) => Promise<TrackList>} [tracks]
 * @property {() => Promise<Library[]>} [libraries]  Library ids are local, like item ids.
 * @property {(libraryId: string, page: { offset: number, limit: number }) => Promise<{ total?: number | null, offset?: number, items: LibraryItem[] }>} [items]
 * @property {(itemId: string) => Promise<{ parent?: LibraryItem, items: LibraryItem[] }>} [children]
 * @property {(query: string, options: { type: string | null, limit: number }) => Promise<LibraryItem[]>} [search]
 * @property {(itemId: string, variant: string) => Promise<Response>} [artwork]  An image response.
 */

/**
 * @typedef {object} PluginInfo
 * @property {string} name  The package name.
 * @property {string | null} version
 */

/**
 * Prefixes every line with the plugin's name.
 * @typedef {{ debug: Function, info: Function, warn: Function, error: Function }} Logger
 */

/**
 * The API a node entry's factory receives. Register everything while the
 * factory runs. Do not start processes, sockets, timers or watchers in the
 * factory: start them in a "start" handler and release them in a "shutdown"
 * handler, which may run more than once and must not fail when nothing was
 * started.
 * @typedef {object} YoloNodeAPI
 * @property {PluginInfo} plugin
 * @property {Readonly<Record<string, unknown>>} options  The plugin's `options` from yolo.config.json, or {}.
 * @property {Readonly<Record<string, string | undefined>>} env  The node's environment, including the repository .env.
 * @property {Logger} log
 * @property {(id: string, impl: SourceImpl) => void} registerSource
 *   `id` is lowercase letters, digits and dashes, starts with a letter, and is
 *   unique on the node. It becomes the `plugin` field of this source's Sources.
 * @property {(event: "start" | "shutdown", handler: () => void | Promise<void>) => () => void} on
 *   Handlers run in plugin load order, then registration order. Returns a
 *   function that removes the handler.
 */

/**
 * An MCP tool added by a control entry. It is served next to Yolo's own tools
 * under the same OAuth scopes.
 * @typedef {object} ToolDefinition
 * @property {string} name  lower_snake_case; must not clash with another tool.
 * @property {string} title
 * @property {string} description
 * @property {"read" | "control" | "manage"} scope  The one scope a token needs to call it.
 * @property {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} [annotations]
 *   Defaults to a write that is not destructive.
 * @property {object} input  A Standard Schema object schema, such as yolo.z.object({ … }).
 * @property {(args: object, context: { services: object }) => unknown | Promise<unknown>} run
 *   `context.services` is the service layer behind Yolo's own tools and the
 *   /v1 API. The return value is sent to the agent as JSON; a thrown YoloError
 *   becomes a tool error with its code.
 */

/**
 * The API a control entry's factory receives. Control entries are bundled
 * into the Worker when it is built, so they cannot be added at runtime.
 * @typedef {object} YoloControlAPI
 * @property {PluginInfo} plugin
 * @property {Readonly<Record<string, unknown>>} options
 * @property {Logger} log
 * @property {typeof import("zod").z} z  The host's zod, for tool input schemas.
 * @property {(tool: ToolDefinition) => void} registerTool
 */

/**
 * @typedef {(yolo: YoloNodeAPI) => void | Promise<void>} NodePluginFactory
 * @typedef {(yolo: YoloControlAPI) => void | Promise<void>} ControlPluginFactory
 */
