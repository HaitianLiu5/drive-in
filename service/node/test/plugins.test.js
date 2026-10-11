import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { YoloError } from "@useyolo/core";
import { loadPluginConfig, OFFICIAL_CONFIG } from "@useyolo/plugin-api/host";
import { loadPlugins } from "../src/plugins.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function quietLogger() {
  const lines = [];
  const log = (level) => (...args) => lines.push(`${level} ${args.join(" ")}`);
  return { lines, debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

const plugin = (name, factory, extra = {}) => ({ name, source: `./${name}`, enabled: true, options: {}, factory, ...extra });

test("URLs go to sources in load order and the first claim wins", async () => {
  const asked = [];
  const claimer = (id, answer) => (yolo) => yolo.registerSource(id, {
    claim: (url) => {
      asked.push(id);
      return answer(url);
    },
  });
  const host = await loadPlugins([
    plugin("first", claimer("music", () => undefined)),
    plugin("second", claimer("clips", (url) => (url.includes("clip") ? { id: "c1" } : undefined))),
    plugin("third", claimer("pages", (url) => ({ id: url, url }))),
  ], { logger: quietLogger() });
  await host.start();

  assert.deepEqual(await host.sources.claim("https://x.test/clip"), { plugin: "clips", id: "c1" });
  assert.deepEqual(asked, ["music", "clips"]);
  assert.deepEqual(await host.sources.claim("https://x.test/page"), { plugin: "pages", id: "https://x.test/page", url: "https://x.test/page" });
  assert.deepEqual(asked.slice(2), ["music", "clips", "pages"]);
});

test("no claim is a clear not_found", async () => {
  const host = await loadPlugins([plugin("none", (yolo) => yolo.registerSource("music", { claim: () => undefined }))]);
  await host.start();
  await assert.rejects(host.sources.claim("https://x.test/a"), { code: "not_found", message: /No source plugin/ });
  await assert.rejects(host.sources.claim("not a url"), { code: "invalid_request" });
});

test("start and shutdown run in load order; shutdown runs once", async () => {
  const events = [];
  const lifecycle = (name) => (yolo) => {
    yolo.on("start", () => events.push(`${name} start`));
    yolo.on("shutdown", async () => events.push(`${name} shutdown`));
    const off = yolo.on("shutdown", () => events.push(`${name} removed`));
    off();
  };
  const host = await loadPlugins([plugin("a", lifecycle("a")), plugin("b", lifecycle("b"))]);
  assert.deepEqual(events, [], "the factory itself starts nothing");
  await host.start();
  assert.deepEqual(host.status().map((entry) => entry.status), ["started", "started"]);
  await Promise.all([host.shutdown(), host.shutdown()]);
  assert.deepEqual(events, ["a start", "b start", "a shutdown", "b shutdown"]);
  assert.deepEqual(host.status().map((entry) => entry.status), ["stopped", "stopped"]);
});

test("a failing factory is reported and nothing it registered is kept", async () => {
  const logger = quietLogger();
  const host = await loadPlugins([
    plugin("broken", (yolo) => {
      yolo.registerSource("half", { claim: (url) => ({ id: url }) });
      throw new Error("missing API key");
    }),
    plugin("ok", (yolo) => yolo.registerSource("pages", { claim: (url) => ({ id: url }) })),
  ], { logger });
  await host.start();
  assert.deepEqual(host.status(), [
    { name: "broken", version: null, source: "./broken", status: "failed", sources: [], error: "missing API key" },
    { name: "ok", version: null, source: "./ok", status: "started", sources: ["pages"] },
  ]);
  assert.deepEqual(host.sources.ids(), ["pages"]);
  assert.match(logger.lines.join("\n"), /\[broken\] failed to load: missing API key/);
});

test("a plugin that fails to start loses its sources and releases what it started", async () => {
  const events = [];
  const host = await loadPlugins([
    plugin("flaky", (yolo) => {
      yolo.registerSource("flaky", { libraries: async () => [] });
      yolo.on("start", () => {
        events.push("opened");
        throw new Error("port in use");
      });
      yolo.on("shutdown", () => events.push("closed"));
    }),
    plugin("slow", (yolo) => yolo.on("start", () => new Promise(() => {}))),
  ], { logger: quietLogger(), startTimeoutMs: 20 });
  await host.start();
  assert.deepEqual(events, ["opened", "closed"]);
  assert.deepEqual(host.status().map((entry) => [entry.status, entry.error]), [
    ["failed", "start failed: port in use"],
    ["failed", "start failed: The start handler did not finish within 0s"],
  ]);
  assert.deepEqual(host.sources.ids(), []);
});

test("disabled, misconfigured and control-only plugins", async () => {
  let called = false;
  const host = await loadPlugins([
    plugin("off", () => {
      called = true;
    }, { enabled: false }),
    { name: "missing", source: "missing", enabled: true, options: {}, node: null, error: "npm package missing is not installed" },
    { name: "tools-only", source: "./tools-only", enabled: true, options: {}, node: null, control: "/x/control.js", error: null },
  ], { logger: quietLogger() });
  assert.equal(called, false);
  assert.deepEqual(host.status().map((entry) => [entry.name, entry.status, entry.error ?? null]), [
    ["off", "disabled", null],
    ["missing", "failed", "npm package missing is not installed"],
  ]);
});

test("registration is checked while the factory runs", async () => {
  let late;
  const host = await loadPlugins([
    plugin("one", (yolo) => yolo.registerSource("pages", {})),
    plugin("dup", (yolo) => yolo.registerSource("pages", {})),
    plugin("bad-id", (yolo) => yolo.registerSource("Pages", {})),
    plugin("bad-method", (yolo) => yolo.registerSource("misc", { claim: "yes" })),
    plugin("bad-event", (yolo) => yolo.on("tick", () => {})),
    plugin("late", (yolo) => {
      late = yolo;
    }),
  ], { logger: quietLogger() });
  assert.throws(() => late.registerSource("later", {}), /while the plugin factory runs/);
  assert.deepEqual(host.status().map((entry) => entry.error ?? entry.status), [
    "loaded",
    'Source id "pages" is already registered',
    'Source id "Pages" must be lowercase letters, digits and dashes, starting with a letter',
    "Source misc: claim must be a function",
    'Unknown event "tick"; plugins can handle start and shutdown',
    "loaded",
  ]);
});

test("plugins get their options, the environment, and a prefixed logger", async () => {
  const logger = quietLogger();
  let seen;
  await loadPlugins([plugin("opts", (yolo) => {
    seen = yolo;
    yolo.log.info("hello");
  }, { options: { nested: { a: 1 } }, version: "1.2.3" })], { env: { HOME_URL: "x" }, logger });
  assert.deepEqual(seen.plugin, { name: "opts", version: "1.2.3" });
  assert.deepEqual(seen.options, { nested: { a: 1 } });
  assert.throws(() => {
    seen.options.nested.a = 2;
  }, TypeError);
  assert.equal(seen.env.HOME_URL, "x");
  assert.deepEqual(logger.lines, ["info [opts] hello"]);
});

test("a plugin installed outside the repository gets the host's @useyolo/plugin-api", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yolo-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside", "package.json"), JSON.stringify({
    name: "outside-plugin", yolo: { node: "./node.js" }, peerDependencies: { "@useyolo/plugin-api": "*" },
  }));
  writeFileSync(join(dir, "outside", "node.js"), `
    import { YoloError } from "@useyolo/plugin-api";
    export default function (yolo) {
      yolo.registerSource("outside", { claim: () => { throw new YoloError("forbidden", "not this one"); } });
    }
  `);
  writeFileSync(join(dir, "yolo.config.json"), JSON.stringify({ plugins: ["./outside"] }));
  const config = loadPluginConfig({ root: dir, env: {} });
  const host = await loadPlugins(config.plugins, { logger: quietLogger() });
  await host.start();
  assert.equal(host.status()[0].status, "started");
  await assert.rejects(host.sources.claim("https://x.test/a"), (error) => error instanceof YoloError && error.code === "forbidden");
});

test("with no config the node loads and starts the official plugins", async () => {
  const config = loadPluginConfig({ root: ROOT, env: { YOLO_CONFIG: OFFICIAL_CONFIG } });
  const host = await loadPlugins(config.plugins, { env: {}, logger: quietLogger() });
  await host.start();
  const status = host.status();
  assert.deepEqual(status.map((entry) => entry.name), config.plugins.map((entry) => entry.name));
  for (const entry of status) {
    assert.equal(entry.status, "started", `${entry.name}: ${entry.error}`);
    assert.ok(entry.sources.length > 0, entry.name);
  }
  // Between them they answer web URLs and serve a library.
  const claimed = await host.sources.claim("https://example.com/watch?v=1");
  assert.equal(typeof claimed.plugin, "string");
  await host.shutdown();
});
