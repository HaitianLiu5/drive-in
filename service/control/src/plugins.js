import { z } from "zod";
import { SCOPES, TOOLS } from "./mcp/tools.js";

// Control entries of plugins (docs/yolo-plugins.md). Workers cannot load code
// at runtime (decision 20), so scripts/generate-plugins.js writes
// plugins.generated.js with a static import of every configured control
// entry, and wrangler bundles them into the Worker. This module calls their
// factories, the same way the node does: a factory that throws is reported
// and dropped with everything it registered, and the Worker keeps serving.
//
// A control entry can add MCP tools; they are served next to Yolo's own
// tools under the same OAuth scopes.

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const LEVELS = Object.freeze(["debug", "info", "warn", "error"]);

function checkTool(definition, taken) {
  const tool = definition && typeof definition === "object" ? definition : {};
  const name = String(tool.name ?? "");
  if (!TOOL_NAME.test(name)) throw new TypeError(`Tool name "${name}" must be lower_snake_case`);
  if (taken.has(name)) throw new TypeError(`Tool ${name} already exists`);
  if (typeof tool.title !== "string" || !tool.title) throw new TypeError(`Tool ${name} needs a title`);
  if (typeof tool.description !== "string" || !tool.description) throw new TypeError(`Tool ${name} needs a description`);
  if (!SCOPES.includes(tool.scope)) throw new TypeError(`Tool ${name}: scope must be one of ${SCOPES.join(", ")}`);
  if (!tool.input?.["~standard"]) throw new TypeError(`Tool ${name}: input must be a schema such as yolo.z.object({ … })`);
  if (typeof tool.run !== "function") throw new TypeError(`Tool ${name} needs a run(args, context) function`);
  if (tool.annotations !== undefined && (typeof tool.annotations !== "object" || tool.annotations === null)) {
    throw new TypeError(`Tool ${name}: annotations must be an object`);
  }
  return {
    name,
    title: tool.title,
    description: tool.description,
    scope: tool.scope,
    annotations: { ...WRITE, ...tool.annotations },
    input: tool.input,
    // Same calling convention as Yolo's own tools (mcp/server.js).
    run: (services, args) => tool.run(args, { services }),
  };
}

// `entries` is the generated list: [{ name, version, options, factory }].
// Resolves to { tools, plugins }, where plugins reports each one's status.
export async function loadControlPlugins(entries, { logger = console } = {}) {
  const tools = [];
  const plugins = [];
  const taken = new Set(TOOLS.map((tool) => tool.name));
  for (const entry of entries) {
    const prefix = `[${entry.name}]`;
    const log = Object.freeze(Object.fromEntries(LEVELS.map((level) => [level, (...args) => logger[level](prefix, ...args)])));
    const record = { name: entry.name, version: entry.version ?? null, status: "loaded", tools: [] };
    plugins.push(record);
    const pending = [];
    let loading = true;
    const yolo = Object.freeze({
      plugin: Object.freeze({ name: entry.name, version: entry.version ?? null }),
      options: Object.freeze(structuredClone(entry.options ?? {})),
      log,
      z,
      registerTool(definition) {
        if (!loading) throw new Error(`${entry.name}: register tools while the plugin factory runs`);
        pending.push(checkTool(definition, new Set([...taken, ...pending.map((tool) => tool.name)])));
      },
    });
    try {
      if (typeof entry.factory !== "function") throw new Error("the control entry's default export is not a function");
      await entry.factory(yolo);
      for (const tool of pending) taken.add(tool.name);
      tools.push(...pending);
      record.tools = pending.map((tool) => tool.name);
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
      log.error(`failed to load: ${record.error}`);
    } finally {
      loading = false;
    }
  }
  return { tools, plugins };
}
