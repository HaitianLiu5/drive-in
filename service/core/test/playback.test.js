import assert from "node:assert/strict";
import { test } from "node:test";
import { currentPosition, emptyPlaybackState, normalizeCapabilities, errorBody, fromErrorBody, YoloError } from "../src/index.js";

test("currentPosition extrapolates only while playing and clamps to duration", () => {
  const base = { ...emptyPlaybackState(), position: 10, positionAt: 1_000, item: { duration: 12 } };
  assert.equal(currentPosition({ ...base, status: "paused" }, 5_000), 10);
  assert.equal(currentPosition({ ...base, status: "playing" }, 2_000), 11);
  assert.equal(currentPosition({ ...base, status: "playing" }, 60_000), 12);
});

test("normalizeCapabilities fills safe defaults", () => {
  const caps = normalizeCapabilities({ renderer: "canvas-webcodecs", maxHeight: 720, subtitles: "nope" });
  assert.equal(caps.renderer, "canvas-webcodecs");
  assert.equal(caps.maxHeight, 720);
  assert.equal(caps.subtitles, "client-vtt");
});

test("error bodies round-trip", () => {
  const body = errorBody(new YoloError("node_offline", "Media node is offline"));
  assert.deepEqual(body, { error: { code: "node_offline", message: "Media node is offline", retryable: true } });
  const error = fromErrorBody(body, 503);
  assert.equal(error.code, "node_offline");
  assert.equal(fromErrorBody({ error: "legacy" }, 404).code, "not_found");
});
