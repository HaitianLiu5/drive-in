import test from "node:test";
import assert from "node:assert/strict";
import { buildCueEndPrefix, findActiveCues, parseVTT } from "../../src/subtitle-cues.js";

test("overlapping subtitle cues remain discoverable", () => {
  const cues = parseVTT(`WEBVTT

00:00:01.000 --> 00:00:10.000
长时间显示的标识

00:00:05.000 --> 00:00:06.000
中文对白
English dialogue

00:00:07.000 --> 00:00:08.000
Later cue
`);
  const track = { cues, cueEndPrefix: buildCueEndPrefix(cues) };

  assert.deepEqual(findActiveCues(track, 5.5).map((cue) => cue.text), [
    "长时间显示的标识",
    "中文对白\nEnglish dialogue",
  ]);
  assert.deepEqual(findActiveCues(track, 6.5).map((cue) => cue.text), ["长时间显示的标识"]);
  assert.deepEqual(findActiveCues(track, 10), []);
});

test("CRLF cues and timestamps without hours are parsed", () => {
  const cues = parseVTT("WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nFirst\r\n\r\n00:00:03.000 --> 00:00:04.000\r\nSecond\r\n");
  assert.deepEqual(cues.map((cue) => ({ start: cue.start, end: cue.end, text: cue.text })), [
    { start: 1, end: 2, text: "First" },
    { start: 3, end: 4, text: "Second" },
  ]);
});

test("duplicate styled YouTube cues display once after markup is removed", () => {
  const cues = parseVTT(`WEBVTT

first
00:00:00.000 --> 00:00:02.000 align:start
<b>我刚刚把这家超市买了下来</b>

duplicate
00:00:00.000 --> 00:00:02.000 align:center
<c.colorFFFFFF>我刚刚把这家超市买了下来</c>

00:00:02.000 --> 00:00:04.000
下一句

00:00:00.000 --> 00:00:02.000
我刚刚把这家超市买了下来
`);
  assert.deepEqual(cues, [
    { start: 0, end: 2, text: "我刚刚把这家超市买了下来" },
    { start: 2, end: 4, text: "下一句" },
  ]);
  assert.equal(findActiveCues({ cues, cueEndPrefix: buildCueEndPrefix(cues) }, 1).length, 1);
});

test("repeated dialogue at different times and distinct overlapping cues survive", () => {
  const cues = parseVTT(`WEBVTT

00:00:00.000 --> 00:00:02.000
你好

00:00:00.000 --> 00:00:02.000
Hello

00:00:01.000 --> 00:00:03.000
你好

00:00:04.000 --> 00:00:06.000
你好
`);
  assert.equal(cues.length, 4);
  assert.deepEqual(findActiveCues({ cues, cueEndPrefix: buildCueEndPrefix(cues) }, 1.5)
    .map((cue) => cue.text), ["你好", "Hello", "你好"]);
});
