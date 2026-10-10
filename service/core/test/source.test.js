import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUrl, sourceFromRef, sourceKey, sourceFromKey, libraryItemId, YoloError } from "../src/index.js";

test("sourceFromRef accepts URLs, library item ids, and Source objects", () => {
  assert.deepEqual(sourceFromRef("https://youtu.be/abc"), { kind: "url", url: "https://youtu.be/abc" });
  assert.deepEqual(sourceFromRef("plex:123"), { kind: "plex", ratingKey: "123" });
  assert.deepEqual(sourceFromRef({ kind: "plex", ratingKey: 7 }), { kind: "plex", ratingKey: "7" });
});

test("sourceFromRef rejects guesses with a hint to search", () => {
  assert.throws(() => sourceFromRef("Inception"), (error) => (
    error instanceof YoloError && error.code === "invalid_request" && /search/.test(error.message)
  ));
  assert.throws(() => sourceFromRef("javascript:alert(1)"), YoloError);
});

test("canonicalUrl folds YouTube spellings and drops tracking parameters", () => {
  const expected = "https://youtube.com/watch?v=abc";
  assert.equal(canonicalUrl("https://youtu.be/abc?si=xyz"), expected);
  assert.equal(canonicalUrl("https://www.youtube.com/watch?v=abc&t=42&utm_source=x"), expected);
  assert.equal(canonicalUrl("https://m.youtube.com/shorts/abc"), expected);
  assert.equal(canonicalUrl("http://Example.com/a?b=2&a=1#frag"), "https://example.com/a?a=1&b=2");
});

test("sourceKey round-trips through sourceFromKey", () => {
  assert.equal(sourceKey({ kind: "plex", ratingKey: "9" }), "plex:9");
  const key = sourceKey({ kind: "url", url: "https://youtu.be/abc" });
  assert.equal(key, "url:https://youtube.com/watch?v=abc");
  assert.deepEqual(sourceFromKey(key), { kind: "url", url: "https://youtube.com/watch?v=abc" });
  assert.equal(libraryItemId({ kind: "plex", ratingKey: "9" }), "plex:9");
  assert.equal(libraryItemId({ kind: "url", url: "https://x.test" }), null);
});
