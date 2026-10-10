import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestControlPlane, USER } from "../helpers/setup.js";
import { upsertDevice } from "../../src/store/devices.js";
import { addQueueItems, listQueue } from "../../src/store/queue.js";
import { listHistory } from "../../src/store/history.js";

const movie = { kind: "plex", ratingKey: "42" };

test("play defaults to the only online device and records history", async () => {
  const plane = createTestControlPlane();
  const { state, device } = await plane.hub.play({ source: movie });
  assert.equal(device.id, "node:legacy");
  assert.equal(state.status, "playing");
  assert.equal(state.item.title, "Movie 42");
  const prepare = plane.node.calls.find((call) => call.path === "/internal/v1/prepare");
  assert.equal(prepare.body.renderer, "legacy");
  assert.deepEqual(prepare.body.tracks.preferences, { saved: null, fallback: null });
  assert.equal((await listHistory(plane.db, USER))[0].sourceKey, "plex:42");
  assert.equal(plane.transport.broadcasts.at(-1).type, "state");
});

test("play fails with device_offline when nothing can play", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/renderers"] = () => ({ renderers: [] });
  await assert.rejects(plane.hub.play({ source: movie }), { code: "device_offline" });
});

test("play fails with node_offline when the node is down", async () => {
  const plane = createTestControlPlane();
  const device = await upsertDevice(plane.db, USER, { name: "Phone", kind: "phone", capabilities: {} });
  plane.transport.online.add(device.id);
  plane.node.offline = true;
  await assert.rejects(plane.hub.play({ source: movie }), { code: "node_offline" });
});

test("realtime devices receive load, then commands; position extrapolates", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/renderers"] = () => ({ renderers: [] });
  const car = await upsertDevice(plane.db, USER, { name: "Model Y", kind: "car", capabilities: { renderer: "canvas-webcodecs" } });
  plane.transport.online.add(car.id);

  await plane.hub.play({ source: movie, device: "model y", startTime: 30 });
  const load = plane.transport.sent.at(-1);
  assert.equal(load.deviceId, car.id);
  assert.equal(load.message.type, "load");
  assert.equal(load.message.startTime, 30);

  await plane.hub.deviceMessage(car.id, { type: "report", status: "playing", position: 31, duration: 600 });
  plane.advance(10_000);
  assert.equal((await plane.hub.getState()).position, 41);

  await plane.hub.control("pause");
  assert.equal(plane.transport.sent.at(-1).message.type, "pause");
  assert.equal((await plane.hub.state()).status, "paused");
  await plane.hub.seek(100);
  assert.deepEqual(
    { type: plane.transport.sent.at(-1).message.type, position: plane.transport.sent.at(-1).message.position },
    { type: "seek", position: 100 },
  );
});

test("node renderers are controlled through the node", async () => {
  const plane = createTestControlPlane();
  await plane.hub.play({ source: movie });
  await plane.hub.control("pause");
  const control = plane.node.calls.find((call) => call.path.endsWith("/control"));
  assert.deepEqual(control.body, { action: "pause" });
  await plane.hub.control("stop");
  const state = await plane.hub.state();
  assert.equal(state.status, "idle");
  assert.equal(state.deviceId, "node:legacy");
});

test("next plays the queue head; ended advances; empty queue goes idle", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/renderers"] = () => ({ renderers: [] });
  const car = await upsertDevice(plane.db, USER, { name: "Car", kind: "car", capabilities: {} });
  plane.transport.online.add(car.id);
  await addQueueItems(plane.db, USER, [
    { source: { kind: "plex", ratingKey: "1" }, title: "One" },
    { source: { kind: "plex", ratingKey: "2" }, title: "Two" },
  ]);
  await plane.hub.control("next");
  let state = await plane.hub.state();
  assert.equal(state.item.source.ratingKey, "1");

  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: state.sessionId });
  state = await plane.hub.state();
  assert.equal(state.item.source.ratingKey, "2");
  assert.equal((await listQueue(plane.db, USER)).length, 0);

  await plane.hub.deviceMessage(car.id, { type: "ended", sessionId: state.sessionId });
  assert.equal((await plane.hub.state()).status, "idle");
});

test("a failed advance puts the item back at the head", async () => {
  const plane = createTestControlPlane();
  await addQueueItems(plane.db, USER, [{ source: movie, title: "Movie" }]);
  plane.node.routes["POST /internal/v1/prepare"] = () => {
    throw Object.assign(new Error("yt-dlp failed"), { code: "resolve_failed" });
  };
  await assert.rejects(plane.hub.control("next"));
  assert.equal((await listQueue(plane.db, USER))[0].title, "Movie");
});

test("previous plays the most recent other history entry", async () => {
  const plane = createTestControlPlane();
  await plane.hub.play({ source: { kind: "plex", ratingKey: "1" } });
  plane.advance(1_000);
  await plane.hub.play({ source: { kind: "plex", ratingKey: "2" } });
  plane.advance(1_000);
  await plane.hub.control("previous");
  assert.equal((await plane.hub.state()).item.source.ratingKey, "1");
});

test("transfer continues on the new device and deactivates the old one", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["GET /internal/v1/renderers"] = () => ({ renderers: [] });
  const car = await upsertDevice(plane.db, USER, { name: "Car", kind: "car", capabilities: {} });
  const tv = await upsertDevice(plane.db, USER, { name: "Living room", kind: "tv", capabilities: {} });
  plane.transport.online.add(car.id);
  await plane.hub.play({ source: movie, device: car.id, startTime: 10 });
  await plane.hub.deviceMessage(car.id, { type: "report", status: "playing", position: 10 });
  plane.transport.online.add(tv.id);
  plane.advance(5_000);

  await plane.hub.transfer("living room");
  const messages = plane.transport.sent.slice(-2);
  assert.deepEqual(messages.map(({ deviceId, message }) => [deviceId, message.type]), [[car.id, "deactivate"], [tv.id, "load"]]);
  assert.equal(messages[1].message.reason, "transfer");
  assert.equal(messages[1].message.startTime, 15);
});

test("several online devices without an active one require a choice", async () => {
  const plane = createTestControlPlane();
  const phone = await upsertDevice(plane.db, USER, { name: "Phone", kind: "phone", capabilities: {} });
  plane.transport.online.add(phone.id);
  await assert.rejects(plane.hub.play({ source: movie }), /Several devices/);
});

test("set_tracks saves preferences that the next play passes to the node", async () => {
  const plane = createTestControlPlane();
  plane.node.routes["POST /internal/v1/sessions/*/tracks"] = () => ({
    tracks: { subtitles: [{ id: "plex:7", kind: "subtitle", language: "zh", name: "简体", format: "text" }], audio: [] },
  });
  await plane.hub.play({ source: movie });
  await plane.hub.setTracks({ subtitles: ["plex:7"] });
  assert.deepEqual((await plane.hub.state()).tracks.subtitles, ["plex:7"]);

  await plane.hub.play({ source: { kind: "plex", ratingKey: "43" } });
  const prepare = plane.node.calls.filter((call) => call.path === "/internal/v1/prepare").at(-1);
  assert.equal(prepare.body.tracks.preferences.fallback.subtitles[0].language, "zh");
});

test("hello registers a device and returns the welcome payload", async () => {
  const plane = createTestControlPlane();
  const { device, welcome } = await plane.hub.hello({ name: "Model Y", kind: "car", capabilities: { renderer: "canvas-webcodecs", maxHeight: 720 } });
  assert.match(device.id, /^dev_/);
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.deviceId, device.id);
  assert.deepEqual(welcome.queue, []);
  const again = await plane.hub.hello({ deviceId: device.id, name: "Model Y", kind: "car" });
  assert.equal(again.device.id, device.id);
});
