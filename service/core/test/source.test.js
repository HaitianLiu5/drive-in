import assert from "node:assert/strict";
import { test } from "node:test";
import { isClaimed, isSourceKey, normalizeSource, normalizeSourceRef, sourceFromRef, sourceKey, YoloError } from "../src/index.js";

test("sourceFromRef accepts URLs, library item ids, and Source objects", () => {
  assert.deepEqual(sourceFromRef(" https://video.test/watch?v=1 "), { url: "https://video.test/watch?v=1" });
  assert.deepEqual(sourceFromRef("library:123"), { plugin: "library", id: "123" });
  assert.deepEqual(sourceFromRef({ plugin: "library", id: 7, cut: "director" }), { plugin: "library", id: "7", cut: "director" });
  assert.deepEqual(sourceFromRef({ url: "https://video.test/a" }), { url: "https://video.test/a" });
});

test("sourceFromRef rejects guesses with a hint to search", () => {
  assert.throws(() => sourceFromRef("Inception"), (error) => (
    error instanceof YoloError && error.code === "invalid_request" && /search/.test(error.message)
  ));
  assert.throws(() => sourceFromRef("javascript:alert(1)"), YoloError);
  assert.throws(() => sourceFromRef("Library:1"), YoloError);
});

test("sources are plugin-owned: core checks plugin and id and keeps the rest", () => {
  assert.deepEqual(normalizeSource({ plugin: "web", id: "https://video.test/a", url: "https://video.test/a?x=1" }), {
    plugin: "web", id: "https://video.test/a", url: "https://video.test/a?x=1",
  });
  assert.throws(() => normalizeSource({ plugin: "Web", id: "1" }), { code: "invalid_request" });
  assert.throws(() => normalizeSource({ plugin: "web", id: "" }), { code: "invalid_request" });
  assert.throws(() => normalizeSource({ plugin: "web", id: "1", blob: "x".repeat(5000) }), /small JSON/);
  assert.throws(() => normalizeSource({ kind: "old", ratingKey: "1" }), /migration 0003/);
});

test("an unclaimed URL stays a reference until a plugin claims it", () => {
  const ref = normalizeSourceRef({ kind: "old", url: "https://video.test/a" });
  assert.deepEqual(ref, { url: "https://video.test/a" });
  assert.equal(isClaimed(ref), false);
  assert.throws(() => sourceKey(ref), /claimed/);
  assert.throws(() => normalizeSourceRef({ url: "ftp://video.test/a" }), { code: "invalid_request" });
});

test("the source key is <plugin>:<id>", () => {
  assert.equal(sourceKey({ plugin: "library", id: "9" }), "library:9");
  assert.equal(sourceKey({ plugin: "web", id: "https://video.test/a", url: "https://video.test/a?si=1" }), "web:https://video.test/a");
  assert.equal(isSourceKey("web:https://video.test/a"), true);
  assert.equal(isSourceKey("default"), false);
  assert.equal(isSourceKey(":x"), false);
});
