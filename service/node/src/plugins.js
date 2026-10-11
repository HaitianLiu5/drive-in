import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import { createResolve } from "./plugin-hooks.js";
import { checkSourceImpl, createSourceRegistry } from "./sources.js";

// Loads node plugins (docs/yolo-plugins.md), modelled on pi's extensions:
//
// 1. Import each enabled plugin's node entry in config order and call its
//    default export, the factory, with a `yolo` API. The factory registers
//    sources and event handlers. A factory that throws, or a plugin that
//    cannot be imported, is marked failed: nothing it registered is kept, and
//    the node carries on with the other plugins.
// 2. start(): run "start" handlers in load order. Long-lived resources
//    (processes, sockets, timers) start here, never in the factory. A handler
//    that throws or hangs fails its plugin, removes its sources, and runs its
//    "shutdown" handlers to release whatever it had started.
// 3. shutdown(): run "shutdown" handlers in load order, once. Handlers must
//    be idempotent; errors are logged and the rest still run.
//
// Plugins are trusted code running in this process with its permissions, as
// in pi: there is no permission system, so review a plugin before adding it.

const EVENTS = Object.freeze(["start", "shutdown"]);
const LEVELS = Object.freeze(["debug", "info", "warn", "error"]);
// Packages the host provides to plugins, which list them as peerDependencies.
const PROVIDED_PACKAGES = Object.freeze(["@useyolo/plugin-api"]);
const START_TIMEOUT_MS = 30_000;

let hooksRegistered = false;

// Plugins import the host's copy of each provided package wherever they are
// installed, so they share one YoloError class with the node (plugin-hooks.js).
// module.registerHooks() runs in this thread (Node 22.15+); older Node 22
// releases fall back to module.register(), which Node 26 deprecates.
export function provideHostPackages() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const provided = Object.fromEntries(PROVIDED_PACKAGES.map((name) => [name, import.meta.resolve(name)]));
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({ resolve: createResolve(provided) });
  } else {
    nodeModule.register(new URL("./plugin-hooks.js", import.meta.url), { data: { provided } });
  }
}

function pluginLogger(name, sink) {
  const prefix = `[${name}]`;
  return Object.freeze(Object.fromEntries(LEVELS.map((level) => [level, (...args) => sink[level](prefix, ...args)])));
}

function frozenCopy(value) {
  const freeze = (node) => {
    if (node && typeof node === "object") {
      Object.values(node).forEach(freeze);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(structuredClone(value ?? {}));
}

const message = (error) => error?.message || String(error);

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// `entries` come from loadPluginConfig() in @useyolo/plugin-api/host:
// { name, version, source, enabled, options, node, error }. Tests may pass a
// `factory` instead of a `node` path.
export async function loadPlugins(entries, {
  env = process.env,
  logger = console,
  importEntry = (path) => import(pathToFileURL(path).href),
  startTimeoutMs = START_TIMEOUT_MS,
} = {}) {
  const registry = createSourceRegistry();
  const plugins = [];

  for (const entry of entries) {
    // A plugin with only a control entry has nothing to do on the node.
    if (entry.enabled !== false && !entry.error && !entry.factory && !entry.node) continue;
    const plugin = {
      name: entry.name,
      version: entry.version ?? null,
      source: entry.source ?? entry.name,
      status: "disabled",
      error: null,
      sources: [],
      handlers: { start: [], shutdown: [] },
      log: pluginLogger(entry.name, logger),
    };
    plugins.push(plugin);
    if (entry.enabled === false) continue;

    const pending = [];
    const handlers = { start: [], shutdown: [] };
    let loading = true;
    const yolo = Object.freeze({
      plugin: Object.freeze({ name: plugin.name, version: plugin.version }),
      options: frozenCopy(entry.options),
      env: Object.freeze({ ...env }),
      log: plugin.log,
      registerSource(id, impl) {
        if (!loading) throw new Error(`${plugin.name}: register sources while the plugin factory runs`);
        const unknown = checkSourceImpl(id, impl);
        if (registry.has(id) || pending.some((source) => source.id === id)) throw new Error(`Source id "${id}" is already registered`);
        if (unknown.length) plugin.log.warn(`source ${id}: ignoring unknown ${unknown.join(", ")}`);
        pending.push({ id, impl });
      },
      on(event, handler) {
        if (!EVENTS.includes(event)) throw new Error(`Unknown event "${event}"; plugins can handle ${EVENTS.join(" and ")}`);
        if (typeof handler !== "function") throw new TypeError(`The ${event} handler must be a function`);
        handlers[event].push(handler);
        return () => {
          const index = handlers[event].indexOf(handler);
          if (index >= 0) handlers[event].splice(index, 1);
        };
      },
    });

    try {
      if (entry.error) throw new Error(entry.error);
      let factory = entry.factory;
      if (!factory) {
        provideHostPackages();
        factory = (await importEntry(entry.node)).default;
      }
      if (typeof factory !== "function") throw new Error("the node entry's default export is not a function");
      await factory(yolo);
      for (const { id, impl } of pending) registry.add(id, impl, plugin.name);
      plugin.sources = pending.map(({ id }) => id);
      plugin.handlers = handlers;
      plugin.status = "loaded";
    } catch (error) {
      plugin.status = "failed";
      plugin.error = message(error);
      plugin.log.error(`failed to load: ${plugin.error}`);
    } finally {
      loading = false;
    }
  }

  async function shutdownPlugin(plugin) {
    for (const handler of [...plugin.handlers.shutdown]) {
      try {
        await handler();
      } catch (error) {
        plugin.log.error(`shutdown handler failed: ${message(error)}`);
      }
    }
  }

  let starting = null;
  let stopping = null;

  return {
    sources: registry,

    status: () => plugins.map(({ name, version, source, status, error, sources }) => ({
      name, version, source, status, sources: [...sources], ...(error ? { error } : {}),
    })),

    start() {
      starting ??= (async () => {
        for (const plugin of plugins) {
          if (plugin.status !== "loaded") continue;
          try {
            for (const handler of [...plugin.handlers.start]) {
              await withTimeout(Promise.resolve().then(handler), startTimeoutMs, "The start handler");
            }
            plugin.status = "started";
          } catch (error) {
            plugin.status = "failed";
            plugin.error = `start failed: ${message(error)}`;
            plugin.log.error(plugin.error);
            for (const id of plugin.sources) registry.remove(id);
            plugin.sources = [];
            await shutdownPlugin(plugin);
          }
        }
      })();
      return starting;
    },

    shutdown() {
      stopping ??= (async () => {
        await starting;
        for (const plugin of plugins) {
          if (plugin.status !== "started" && plugin.status !== "loaded") continue;
          await shutdownPlugin(plugin);
          plugin.status = "stopped";
        }
      })();
      return stopping;
    },
  };
}
