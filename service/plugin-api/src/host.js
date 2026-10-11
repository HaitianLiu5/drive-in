import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// How Yolo finds plugins (docs/yolo-plugins.md). The media node uses this at
// startup, and the control plane's build uses it to write the static imports
// that Workers need. Node only; plugins do not import it.
//
// The config is JSON: { "plugins": [ { "source", "enabled"?, "options"? } ] }.
// `source` is a path relative to the config file (starting with "." or "/"),
// or an npm package name installed next to it. A string entry is shorthand
// for { "source": … }. The list is complete and ordered: a plugin that is not
// listed, or is listed with "enabled": false, does not load.

export const CONFIG_FILE = "yolo.config.json";
// The zero-setup default: the official plugins, with their options taken from
// environment variables.
export const OFFICIAL_CONFIG = "plugins/official.json";

// YOLO_CONFIG, else yolo.config.json in the repository, else the official list.
export function pluginConfigPath({ root, env = process.env }) {
  if (env.YOLO_CONFIG) return { path: resolve(root, env.YOLO_CONFIG), explicit: true };
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) return { path: file, explicit: true };
  return { path: join(root, OFFICIAL_CONFIG), explicit: false };
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function readPluginConfig(path) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the plugin config ${path}: ${error.message}`, { cause: error });
  }
  if (!isObject(config) || !Array.isArray(config.plugins)) throw new Error(`${path}: "plugins" must be an array`);
  return config.plugins.map((value, index) => {
    const entry = typeof value === "string" ? { source: value } : value;
    const where = `${path}: plugins[${index}]`;
    if (!isObject(entry) || typeof entry.source !== "string" || !entry.source.trim()) {
      throw new Error(`${where}.source must be a path or an npm package name`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`${where}.enabled must be true or false`);
    if (entry.options !== undefined && !isObject(entry.options)) throw new Error(`${where}.options must be an object`);
    return { source: entry.source.trim(), enabled: entry.enabled !== false, options: entry.options ?? {} };
  });
}

function packageDir(source, baseDir) {
  if (source.startsWith(".") || isAbsolute(source)) return resolve(baseDir, source);
  // An npm package: the nearest node_modules from the config file upwards,
  // the way Node resolves it, without depending on the package's "exports".
  for (let dir = baseDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", source);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

// One config entry → { name, version, source, enabled, options, root, node,
// control, error }. `node` and `control` are absolute entry paths or null.
// Problems land in `error` so one broken plugin does not stop the others.
export function resolvePlugin(entry, baseDir) {
  const result = { ...entry, name: entry.source, version: null, root: null, node: null, control: null, error: null };
  if (!entry.enabled) return result;
  try {
    const dir = packageDir(entry.source, baseDir);
    if (!dir) throw new Error(`npm package ${entry.source} is not installed`);
    result.root = dir;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${join(dir, "package.json")}: ${error.message}`, { cause: error });
    }
    result.name = typeof manifest.name === "string" && manifest.name ? manifest.name : basename(dir);
    result.version = typeof manifest.version === "string" ? manifest.version : null;
    if (!isObject(manifest.yolo)) throw new Error(`${result.name} is not a Yolo plugin: its package.json has no "yolo" field`);
    for (const side of ["node", "control"]) {
      const relative = manifest.yolo[side];
      if (relative == null) continue;
      if (typeof relative !== "string") throw new Error(`"yolo.${side}" in ${result.name}'s package.json must be a path`);
      const path = resolve(dir, relative);
      if (!existsSync(path)) throw new Error(`${result.name}'s ${side} entry ${relative} does not exist`);
      result[side] = path;
    }
    if (!result.node && !result.control) throw new Error(`${result.name} has neither a "node" nor a "control" entry`);
  } catch (error) {
    result.error = error.message;
    result.node = null;
    result.control = null;
  }
  return result;
}

export function resolvePlugins(entries, baseDir) {
  const seen = new Set();
  return entries.map((entry) => {
    const plugin = resolvePlugin(entry, baseDir);
    if (plugin.enabled && !plugin.error) {
      if (seen.has(plugin.name)) return { ...plugin, node: null, control: null, error: `${plugin.name} is listed twice` };
      seen.add(plugin.name);
    }
    return plugin;
  });
}

// Everything the node and the control build need: which file applied, and
// the resolved plugins in order. Throws only for an unreadable config file.
export function loadPluginConfig({ root, env = process.env }) {
  const { path, explicit } = pluginConfigPath({ root, env });
  return { path, explicit, plugins: resolvePlugins(readPluginConfig(path), dirname(path)) };
}
