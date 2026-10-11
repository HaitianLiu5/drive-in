import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPluginConfig, OFFICIAL_CONFIG, pluginConfigPath, readPluginConfig } from "../src/host.js";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "yolo-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePackage(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const writeConfig = (root, plugins, name = "yolo.config.json") => {
  writeFileSync(join(root, name), JSON.stringify({ plugins }));
  return join(root, name);
};

test("the config is YOLO_CONFIG, else yolo.config.json, else the official list", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(pluginConfigPath({ root, env: {} }), { path: join(root, OFFICIAL_CONFIG), explicit: false });
  writeConfig(root, []);
  assert.deepEqual(pluginConfigPath({ root, env: {} }), { path: join(root, "yolo.config.json"), explicit: true });
  assert.deepEqual(pluginConfigPath({ root, env: { YOLO_CONFIG: "other.json" } }), { path: join(root, "other.json"), explicit: true });
});

test("local paths and npm packages resolve to their entries, in config order", (t) => {
  const root = tempRoot(t);
  writePackage(join(root, "local"), { name: "local-plugin", version: "1.0.0", yolo: { node: "./node.js", control: "./control.js" } }, {
    "node.js": "export default () => {};",
    "control.js": "export default () => {};",
  });
  writePackage(join(root, "node_modules", "@acme", "remote"), { name: "@acme/remote", yolo: { node: "./main.js" } }, {
    "main.js": "export default () => {};",
  });
  writeConfig(root, [{ source: "@acme/remote", options: { a: 1 } }, "./local", { source: "./local", enabled: false }]);
  const config = loadPluginConfig({ root, env: {} });
  assert.equal(config.explicit, true);
  const [remote, local, disabled] = config.plugins;
  assert.deepEqual(
    { name: remote.name, node: remote.node, control: remote.control, options: remote.options, error: remote.error },
    { name: "@acme/remote", node: join(root, "node_modules", "@acme", "remote", "main.js"), control: null, options: { a: 1 }, error: null },
  );
  assert.deepEqual([local.name, local.version, local.node, local.control], ["local-plugin", "1.0.0", join(root, "local", "node.js"), join(root, "local", "control.js")]);
  assert.deepEqual([disabled.enabled, disabled.node, disabled.error], [false, null, null]);
});

test("a broken plugin entry is reported on that plugin only", (t) => {
  const root = tempRoot(t);
  writePackage(join(root, "plain"), { name: "plain" });
  writePackage(join(root, "missing-entry"), { name: "missing-entry", yolo: { node: "./nope.js" } });
  writePackage(join(root, "ok"), { name: "ok", yolo: { node: "./node.js" } }, { "node.js": "export default () => {};" });
  writeConfig(root, ["./plain", "./missing-entry", "not-installed", "./ok", "./ok"]);
  const errors = loadPluginConfig({ root, env: {} }).plugins.map((plugin) => plugin.error);
  assert.match(errors[0], /no "yolo" field/);
  assert.match(errors[1], /nope\.js does not exist/);
  assert.match(errors[2], /not-installed is not installed/);
  assert.equal(errors[3], null);
  assert.match(errors[4], /listed twice/);
});

test("a malformed config file fails loudly", (t) => {
  const root = tempRoot(t);
  writeFileSync(join(root, "bad.json"), "{ nope");
  assert.throws(() => readPluginConfig(join(root, "bad.json")), /Cannot read the plugin config/);
  assert.throws(() => readPluginConfig(writeConfig(root, [{ source: "./x", options: [] }], "c.json")), /options must be an object/);
  assert.throws(() => readPluginConfig(writeConfig(root, [{ enabled: true }], "d.json")), /source must be/);
});
