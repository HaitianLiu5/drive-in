import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generatePluginModule } from "../../scripts/generate-plugins.js";
import { handleMcpRequest } from "../../src/mcp/handler.js";
import { TOOLS } from "../../src/mcp/tools.js";
import { loadControlPlugins } from "../../src/plugins.js";
import { createTestControlPlane } from "../helpers/setup.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function quietLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push(`${level} ${args.join(" ")}`);
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

// Generate the static import module for `plugins` in a temporary repository
// root, import it, and load the control entries.
async function bundle(t, plugins) {
  const root = mkdtempSync(join(tmpdir(), "yolo-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "yolo.config.json"), JSON.stringify({ plugins }));
  const outFile = join(root, "plugins.generated.js");
  const generated = generatePluginModule({ root, env: {}, outFile });
  const { default: entries } = await import(pathToFileURL(outFile).href);
  return { root, outFile, generated, entries };
}

async function connect(services, tools, scopes = ["read", "control", "manage"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "localhost");
      return handleMcpRequest(new Request(url, { ...init, headers }), { services, scopes, tools });
    },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("the build step imports configured control entries statically, in config order", async (t) => {
  const { outFile, generated, entries } = await bundle(t, [
    { source: join(FIXTURES, "queue-tool"), options: { greeting: "Hi" } },
    { source: join(FIXTURES, "broken-tool"), enabled: false },
  ]);
  assert.deepEqual(generated.plugins, ["@fixture/queue-tool"]);
  const source = readFileSync(outFile, "utf8");
  assert.match(source, /^import plugin0 from "[^"]*fixtures\/queue-tool\/control\.js";$/m);
  assert.doesNotMatch(source, /broken-tool/);
  assert.deepEqual(entries.map(({ name, version, options }) => ({ name, version, options })), [
    { name: "@fixture/queue-tool", version: "1.0.0", options: { greeting: "Hi" } },
  ]);
  assert.equal(typeof entries[0].factory, "function");
});

test("a plugin's tool is served over MCP with its scope and annotations", async (t) => {
  const { entries } = await bundle(t, [{ source: join(FIXTURES, "queue-tool"), options: { greeting: "Hi" } }]);
  const { tools, plugins } = await loadControlPlugins(entries);
  assert.deepEqual(plugins, [{ name: "@fixture/queue-tool", version: "1.0.0", status: "loaded", tools: ["queue_greeting"] }]);

  const plane = createTestControlPlane();
  await plane.services.addToQueue({ itemId: "library:1" });
  const client = await connect(plane.services, tools);
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, TOOLS.length + 1);
  const tool = listed.find((candidate) => candidate.name === "queue_greeting");
  assert.deepEqual([tool.annotations.readOnlyHint, tool.annotations.destructiveHint], [true, false]);
  const result = await client.callTool({ name: "queue_greeting", arguments: { who: "Claude" } });
  assert.deepEqual(JSON.parse(result.content[0].text), { greeting: "Hi, Claude", queued: 1 });
  await client.close();

  const limited = await connect(plane.services, tools, ["manage"]);
  const denied = await limited.callTool({ name: "queue_greeting", arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, "forbidden");
  await limited.close();
});

test("a failing or clashing plugin is reported and the others still load", async (t) => {
  const { entries } = await bundle(t, [
    join(FIXTURES, "broken-tool"),
    join(FIXTURES, "clashing-tool"),
    { source: join(FIXTURES, "queue-tool"), options: { greeting: "Hi" } },
  ]);
  const logger = quietLogger();
  const { tools, plugins } = await loadControlPlugins(entries, { logger });
  assert.deepEqual(tools.map((tool) => tool.name), ["queue_greeting"]);
  assert.deepEqual(plugins.map(({ name, status, error }) => [name, status, error ?? null]), [
    ["@fixture/broken-tool", "failed", "missing API key"],
    ["@fixture/clashing-tool", "failed", "Tool play already exists"],
    ["@fixture/queue-tool", "loaded", null],
  ]);
  assert.match(logger.lines.join("\n"), /\[@fixture\/broken-tool\] failed to load: missing API key/);
});

test("tool definitions are checked", async () => {
  const register = (definition) => loadControlPlugins([{ name: "t", factory: (yolo) => yolo.registerTool(definition(yolo)) }], { logger: quietLogger() })
    .then(({ plugins }) => plugins[0].error);
  const base = (yolo) => ({ name: "ok_tool", title: "T", description: "D", scope: "read", input: yolo.z.object({}), run: () => 1 });
  assert.equal(await register(base), undefined);
  assert.match(await register((yolo) => ({ ...base(yolo), name: "Bad-Name" })), /lower_snake_case/);
  assert.match(await register((yolo) => ({ ...base(yolo), scope: "admin" })), /scope must be one of read, control, manage/);
  assert.match(await register((yolo) => ({ ...base(yolo), input: { who: "string" } })), /input must be a schema/);
});

test("the build fails when a configured plugin cannot be found", async (t) => {
  await assert.rejects(bundle(t, ["./not-there"]), /Cannot bundle the plugins[\s\S]*not-there/);
});

test("the official plugins add nothing to the Worker", (t) => {
  const outFile = join(mkdtempSync(join(tmpdir(), "yolo-control-")), "plugins.generated.js");
  t.after(() => rmSync(join(outFile, ".."), { recursive: true, force: true }));
  const { plugins } = generatePluginModule({ root: ROOT, env: { YOLO_CONFIG: "plugins/official.json" }, outFile });
  assert.deepEqual(plugins, []);
  assert.match(readFileSync(outFile, "utf8"), /export default \[\n\];/);
});
