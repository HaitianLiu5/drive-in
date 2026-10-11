import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

import { chromium } from "playwright";

import { postJson, startDriveInServer, waitFor } from "./helpers.js";

const execFileAsync = promisify(execFile);
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function createDriveInPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  return page;
}

async function createMediaOrigin(t, runtimeDir, { durationSeconds = 4 } = {}) {
  const mediaPath = `${runtimeDir}/browser-e2e.webm`;
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "testsrc2=size=640x360:rate=60",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(durationSeconds),
    "-c:v", "libvpx-vp9",
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-b:v", "1M",
    "-c:a", "libopus",
    "-y",
    mediaPath,
  ]);
  const media = await readFile(mediaPath);
  const origin = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "video/webm");
    if (!range) {
      response.setHeader("Content-Length", media.byteLength);
      response.end(media);
      return;
    }
    const start = Number(range[1]);
    const requestedEnd = range[2] ? Number(range[2]) : media.byteLength - 1;
    const end = Math.min(requestedEnd, media.byteLength - 1);
    if (start >= media.byteLength || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${media.byteLength}` });
      response.end();
      return;
    }
    const body = media.subarray(start, end + 1);
    response.writeHead(206, {
      "Content-Length": body.byteLength,
      "Content-Range": `bytes ${start}-${end}/${media.byteLength}`,
    });
    response.end(body);
  });
  await new Promise((resolveListen) => origin.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => {
    origin.closeAllConnections();
    origin.close(resolveClose);
  }));
  return `http://127.0.0.1:${origin.address().port}/browser-e2e.webm`;
}

test("the browser decodes media, paints the Canvas, and advances presentation time", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 0,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);

  try {
    await page.waitForFunction(() => {
      const player = globalThis.__driveInMediabunny?.player;
      const stats = player?.getStats();
      return stats?.videoFrameRenderCount > 0 && stats.videoCurrentTime > 250;
    }, null, { timeout: 15_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      crossOriginIsolated: globalThis.crossOriginIsolated,
      hasSharedArrayBuffer: typeof SharedArrayBuffer === "function",
      statusText: document.body.innerText,
      playerStats: globalThis.__driveInMediabunny?.player?.getStats() || null,
    }));
    const runtimeLog = await fetch(new URL("/api/dev/player-log", baseUrl))
      .then((response) => response.json());
    throw new Error(`${error.message}\n${JSON.stringify({
      diagnostics,
      pageErrors,
      runtimeLog,
    }, null, 2)}`);
  }

  const rendered = await page.evaluate(() => {
    const player = globalThis.__driveInMediabunny.player;
    const canvas = document.querySelector('canvas[data-engine="mediabunny"]');
    return {
      currentTime: player.getCurrentTime(),
      stats: player.getStats(),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    };
  });
  assert.ok(rendered.currentTime > 0.25);
  assert.ok(rendered.stats.videoFrameRenderCount > 0);
  assert.deepEqual(rendered.canvas, { width: 640, height: 360 });
  assert.deepEqual(pageErrors, []);
});

test("bilingual subtitle positions stay fixed across missing cues and fitted fonts", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 773, height: 601 });
  const english = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nEnglish first\n\n00:00:03.000 --> 00:00:05.000\nThis longer English sentence needs a smaller fitted font, but its row must stay in exactly the same place.\n";
  const chinese = "WEBVTT\n\n00:00:02.000 --> 00:00:04.000\n中文第二行\n\n00:00:05.000 --> 00:00:06.000\n只有中文字幕\n";
  await page.route("**/test/slots-*.vtt", (route) => route.fulfill({
    status: 200, contentType: "text/vtt",
    body: route.request().url().includes("mixed") ? `${english}\n${chinese.replace("WEBVTT", "")}`
      : route.request().url().includes("zh") ? chinese : english,
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const subs = await import("/src/subtitles.js");
    // Reverse load order must not affect visual language slots.
    await subs.loadSubtitleTrack("zh-Hans", "/test/slots-zh.vtt");
    await subs.loadSubtitleTrack("en", "/test/slots-en.vtt");
  });
  const snapshot = (time) => page.evaluate(async (value) => {
    const subs = await import("/src/subtitles.js");
    subs.renderSubtitle(value);
    const overlay = document.getElementById("subtitle-overlay");
    const box = overlay.getBoundingClientRect();
    return {
      top: box.top, height: box.height, display: getComputedStyle(overlay).display,
      rows: [...overlay.children].map((row) => {
        const line = row.firstElementChild;
        const rowBox = row.getBoundingClientRect();
        return { lang: row.lang, text: line.textContent, top: rowBox.top, height: rowBox.height,
          lineTop: line.getBoundingClientRect().top,
          lineHeight: parseFloat(getComputedStyle(line).lineHeight),
          fontSize: parseFloat(getComputedStyle(line).fontSize) };
      }),
    };
  }, time);
  const states = [];
  for (const time of [1.5, 2.5, 3.5, 4.5, 5.5, 2.5]) states.push(await snapshot(time));
  assert.deepEqual(states.map((state) => state.rows.map((row) => Boolean(row.text))), [
    [true, false], [true, true], [true, true], [true, false], [false, true], [true, true],
  ]);
  const positions = (state) => ({ top: state.top, height: state.height,
    rows: state.rows.map(({ lang, top, height, lineTop, lineHeight }) => ({ lang, top, height, lineTop, lineHeight })) });
  for (const state of states) assert.deepEqual(positions(state), positions(states[0]));
  assert.ok(states[2].rows[0].fontSize < states[0].rows[0].fontSize);
  assert.equal((await snapshot(7)).display, "none");
  // The same guarantee applies to a single mixed-language Plex file.
  await page.evaluate(async () => {
    const subs = await import("/src/subtitles.js");
    subs.disableExternalSubtitle();
    await subs.loadSubtitleTrack("plex:80891", "/test/slots-mixed.vtt");
  });
  for (const time of [1.5, 5.5]) assert.deepEqual(positions(await snapshot(time)), positions(states[0]));
  await page.evaluate(async () => {
    const subs = await import("/src/subtitles.js");
    subs.disableExternalSubtitle();
    await subs.loadSubtitleTrack("en", "/test/slots-en.vtt");
    await subs.loadSubtitleTrack("zh-Hans", "/test/slots-zh.vtt");
    subs.removeSubtitleTrack("zh-Hans");
  });
  assert.deepEqual((await snapshot(2.5)).rows.map((row) => row.lang), ["en"]);
  await page.evaluate(async () => (await import("/src/subtitles.js")).disableExternalSubtitle());
  assert.equal((await snapshot(2.5)).display, "none");
});

test("bilingual subtitles share one full-width backing with one row per language", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const layout = await page.evaluate(async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const captions = new Map([
      ["/test/en.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nFirst line\nSecond line\n"],
      // YouTube may supply the same text twice with different styling.
      ["/test/zh.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n<b>中文翻译</b>\n\n00:00:00.000 --> 00:00:04.000\n中文翻译\n"],
    ]);
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl, location.origin);
      if (captions.has(url.pathname)) {
        return Promise.resolve(new Response(captions.get(url.pathname), {
          status: 200,
          headers: { "Content-Type": "text/vtt" },
        }));
      }
      return realFetch(input, init);
    };

    const subtitles = await import("/src/subtitles.js");
    await subtitles.loadSubtitleTrack("en", "/test/en.vtt");
    await subtitles.loadSubtitleTrack("zh-Hans", "/test/zh.vtt");
    subtitles.renderSubtitle(1);

    const app = document.getElementById("app");
    const overlay = document.getElementById("subtitle-overlay");
    const tracks = [...overlay.querySelectorAll(":scope > .subtitle-track")];
    const englishLines = [...tracks[0].querySelectorAll(".subtitle-line")];
    const appBox = app.getBoundingClientRect();
    const overlayBox = overlay.getBoundingClientRect();
    const englishBox = tracks[0].getBoundingClientRect();
    const chineseBox = tracks[1].getBoundingClientRect();
    const firstLineBox = englishLines[0].getBoundingClientRect();
    const overlayStyle = getComputedStyle(overlay);
    const trackStyle = getComputedStyle(tracks[0]);
    const chineseTrackStyle = getComputedStyle(tracks[1]);
    const lineStyle = getComputedStyle(englishLines[0]);
    const languageFontFamily = (lang) => {
      const track = document.createElement("div");
      track.className = "subtitle-track";
      track.lang = lang;
      track.style.position = "fixed";
      track.style.visibility = "hidden";
      document.body.append(track);
      const family = getComputedStyle(track).fontFamily;
      track.remove();
      return family;
    };

    return {
      groupCount: tracks.length,
      groups: tracks.map((track) => ({
        lang: track.lang,
        lines: [...track.querySelectorAll(".subtitle-line")].map((line) => line.textContent),
      })),
      overlay: {
        display: overlayStyle.display,
        direction: overlayStyle.flexDirection,
        gap: overlayStyle.gap,
        background: overlayStyle.backgroundColor,
        bottomInset: appBox.bottom - overlayBox.bottom,
      },
      firstLanguageIsLower: englishBox.bottom > chineseBox.bottom,
      rowWidths: tracks.map((track) => track.getBoundingClientRect().width),
      oneEnglishRow: Math.abs(firstLineBox.height - parseFloat(getComputedStyle(englishLines[0]).lineHeight)) < 1,
      trackBackground: trackStyle.backgroundColor,
      lineBackground: lineStyle.backgroundColor,
      englishFontFamily: trackStyle.fontFamily,
      chineseFontFamily: chineseTrackStyle.fontFamily,
      japaneseFontFamily: languageFontFamily("ja"),
      koreanFontFamily: languageFontFamily("ko"),
    };
  });

  assert.deepEqual(layout.groups, [
    { lang: "en", lines: ["First line Second line"] },
    { lang: "zh-Hans", lines: ["中文翻译"] },
  ]);
  assert.equal(layout.groupCount, 2);
  assert.equal(layout.overlay.display, "flex");
  assert.equal(layout.overlay.direction, "column");
  assert.equal(layout.overlay.gap, "2px");
  assert.equal(layout.overlay.bottomInset, 8);
  assert.equal(layout.firstLanguageIsLower, false);
  assert.equal(layout.rowWidths[0], layout.rowWidths[1]);
  assert.equal(layout.oneEnglishRow, true);
  assert.equal(layout.overlay.background, "rgba(0, 0, 0, 0.65)");
  assert.equal(layout.trackBackground, "rgba(0, 0, 0, 0)");
  assert.equal(layout.lineBackground, "rgba(0, 0, 0, 0)");
  assert.match(layout.englishFontFamily, /^"Noto Sans"/);
  assert.match(layout.chineseFontFamily, /^"Noto Sans SC"/);
  assert.match(layout.japaneseFontFamily, /^"Noto Sans JP"/);
  assert.match(layout.koreanFontFamily, /^"Noto Sans KR"/);
});

test("Plex bilingual captions stay legible on two equal-width rows at Tesla window sizes", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined) });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 773, height: 601 });
  await page.goto(baseUrl);
  await page.waitForFunction(async () => (await import("/src/state.js")).state.ws?.readyState === 1);
  await page.evaluate(async () => {
    document.getElementById("overlay").classList.add("hidden");
    document.getElementById("browse-screen").classList.add("hidden");
    const canvas = document.createElement("canvas");
    canvas.dataset.engine = "mediabunny";
    canvas.width = 1280; canvas.height = 536;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#a0a7ab"; ctx.fillRect(0, 0, 1280, 536);
    document.getElementById("player-container").append(canvas);
    const text = "WEBVTT\n\n01:44:33.300 --> 01:44:37.410\n- He added an air-duct system... that can cut through the maze. - Good. Explain it to them.\n- 他加了一条穿过迷宫的通风管 - 好 快告诉他们\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
    const subs = await import("/src/subtitles.js");
    await subs.loadSubtitleTrack("plex:80803", url);
    subs.renderSubtitle(6274);
    await document.fonts.ready;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '.subtitle-line[lang="zh-Hans"]' });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  // Some Noto subset binaries retain a "Thin" family suffix internally even
  // though the served @font-face is the static 400 face.
  assert.ok(fonts.some((font) => font.isCustomFont && font.familyName.startsWith("Noto Sans SC") && font.glyphCount > 0), JSON.stringify(fonts));
  for (const viewport of [{ width: 773, height: 601 }, { width: 1280, height: 720 }, { width: 640, height: 360 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction((width) => Math.abs(parseFloat(document.getElementById("subtitle-overlay").style.getPropertyValue("--subtitle-picture-width")) - width) < 1, viewport.width);
    const result = await page.evaluate(() => {
      const overlay = document.getElementById("subtitle-overlay");
      const box = overlay.getBoundingClientRect();
      const lines = [...overlay.querySelectorAll(".subtitle-line")];
      return { gap: innerHeight - box.bottom, fontSize: parseFloat(getComputedStyle(lines[1]).fontSize),
        languages: lines.map((line) => line.lang), font: getComputedStyle(lines[1]).fontFamily,
        width: box.width, height: box.height, overflow: lines.some((line) => line.scrollWidth > line.clientWidth),
        rowWidths: lines.map((line) => line.getBoundingClientRect().width),
        oneRowEach: lines.every((line) => Math.abs(line.getBoundingClientRect().height - parseFloat(getComputedStyle(line).lineHeight)) < 1),
        localChineseFont: performance.getEntriesByType("resource").some((entry) => entry.name.includes("/lib/fonts/noto-sans-sc/files/") && entry.responseEnd > 0),
      };
    });
    assert.deepEqual(result.languages, ["en", "zh-Hans"]);
    assert.match(result.font, /^"Noto Sans SC"/);
    assert.ok(result.localChineseFont);
    assert.ok(result.fontSize >= 16 && result.fontSize <= 24);
    if (viewport.width === 773) assert.ok(result.fontSize < 19);
    assert.equal(result.gap, 8, JSON.stringify(result));
    assert.equal(result.rowWidths[0], result.rowWidths[1]);
    assert.equal(result.oneRowEach, true);
    assert.equal(result.overflow, false);
    assert.ok(result.height < viewport.height / 2);
    await page.evaluate(() => document.getElementById("app").classList.add("controls-visible"));
    const clearance = await page.evaluate(() => ({
      subtitleBottom: document.getElementById("subtitle-overlay").getBoundingClientRect().bottom,
      controlsTop: Math.min(...["progress-wrap", "controls-row"].map((id) => document.getElementById(id).getBoundingClientRect().top)),
    }));
    assert.ok(clearance.subtitleBottom <= clearance.controlsTop - 7, JSON.stringify(clearance));
    await page.evaluate(() => document.getElementById("app").classList.remove("controls-visible"));
  }
});

test("subtitle selection only changes after the service confirms it was saved", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(macChrome) ? macChrome : undefined) });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 773, height: 601 });
  let rejectSave = true;
  await page.route("**/api/plex/subtitles/3993/selection", (route) => route.fulfill({
    status: rejectSave ? 500 : 200, contentType: "application/json",
    body: JSON.stringify(rejectSave ? { error: "Cannot save" } : { ok: true, subtitleStreamID: 8 }),
  }));
  await page.goto(baseUrl);
  await page.waitForFunction(async () => (await import("/src/state.js")).state.ws?.readyState === 1);
  await page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    state.plexInfo = { ratingKey: "3993", activeSubtitleID: null,
      subtitles: [{ id: 8, languageCode: "zho", delivery: "external" }],
    };
    (await import("/src/browse.js")).updateSubsUI();
    document.querySelectorAll("#subs-list button")[1].click();
  });
  await page.waitForFunction(() => document.getElementById("status-text").textContent.includes("Could not save subtitle choice"));
  assert.equal(await page.evaluate(async () => (await import("/src/state.js")).state.plexInfo.activeSubtitleID), null);
  rejectSave = false;
  await page.evaluate(() => document.querySelectorAll("#subs-list button")[1].click());
  await page.waitForFunction(async () => (await import("/src/state.js")).state.plexInfo.activeSubtitleID === 8);
});

test("optimistic seek keeps the current frame visible while the new stream loads", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir, { durationSeconds: 8 });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  const initialPlay = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 0,
    autoplay: true,
  });
  assert.equal(initialPlay.response.status, 200);
  await page.waitForFunction(() => (
    globalThis.__driveInMediabunny?.player?.getStats().videoFrameRenderCount > 0
  ), null, { timeout: 15_000 });

  await page.route("**/api/proxy?*", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    await route.continue();
  });
  const seekPlay = postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 2,
    autoplay: true,
    reason: "seek",
  });

  await page.waitForFunction(() => (
    document.querySelector(".playback-transition-frame")
    && document.getElementById("progress-wrap").classList.contains("seeking")
  ), null, { timeout: 5_000 });
  const transition = await page.evaluate(() => ({
    overlayHidden: document.getElementById("overlay").classList.contains("hidden"),
    snapshotPresent: Boolean(document.querySelector(".playback-transition-frame")),
    progressBusy: document.getElementById("progress-wrap").getAttribute("aria-busy"),
    centerSpinnerVisible: document.getElementById("btn-center-play").classList.contains("buffering"),
  }));
  assert.deepEqual(transition, {
    overlayHidden: true,
    snapshotPresent: true,
    progressBusy: "true",
    centerSpinnerVisible: false,
  });
  assert.equal((await seekPlay).response.status, 200);

  await page.waitForFunction(() => (
    globalThis.__driveInMediabunny?.player?.getCurrentTime() > 2.25
    && !document.querySelector(".playback-transition-frame")
    && !document.getElementById("progress-wrap").classList.contains("seeking")
  ), null, { timeout: 15_000 });
});

test("browser back after playback ends tears down the player and shows the home screen", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 0,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);
  await page.waitForFunction(() => (
    globalThis.__driveInMediabunny?.player?.getStatus() === "ended"
  ), null, { timeout: 15_000 });
  assert.equal(new URL(page.url()).pathname, "/play");

  await page.goBack();
  await page.waitForFunction(() => (
    location.pathname === "/"
    && !globalThis.__driveInMediabunny
    && !document.querySelector('canvas[data-engine="mediabunny"]')
    && !document.getElementById("overlay").classList.contains("hidden")
  ), null, { timeout: 10_000 });

  const home = await page.evaluate(() => ({
    path: location.pathname,
    playerPresent: Boolean(globalThis.__driveInMediabunny),
    canvasPresent: Boolean(document.querySelector('canvas[data-engine="mediabunny"]')),
    overlayHidden: document.getElementById("overlay").classList.contains("hidden"),
  }));
  assert.deepEqual(home, {
    path: "/",
    playerPresent: false,
    canvasPresent: false,
    overlayHidden: false,
  });
});

test("browser back from an episode tears down the player and restores its show", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir, { durationSeconds: 12 });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  await page.evaluate(() => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const jsonResponse = (value) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl, location.origin);
      if (url.pathname === "/api/queue") return Promise.resolve(jsonResponse([]));
      if (url.pathname === "/api/playlists") return Promise.resolve(jsonResponse([]));
      if (url.pathname === "/api/history") return Promise.resolve(jsonResponse([]));
      if (url.pathname === "/api/plex/libraries") {
        return Promise.resolve(jsonResponse([
          { id: "esports", title: "Esports", type: "show" },
          { id: "shows", title: "Shows", type: "show" },
        ]));
      }
      if (url.pathname === "/api/plex/library/esports") {
        return Promise.resolve(jsonResponse({
          total: 1,
          items: [{ ratingKey: "7", title: "Esports Show", type: "show", leafCount: 1 }],
        }));
      }
      if (url.pathname === "/api/plex/library/shows") {
        return Promise.resolve(jsonResponse({
          total: 1,
          items: [{ ratingKey: "42", title: "Test Show", type: "show", leafCount: 1 }],
        }));
      }
      if (url.pathname === "/api/plex/show/42/episodes") {
        return Promise.resolve(jsonResponse([{
          ratingKey: "4201",
          title: "Test Episode",
          season: 1,
          episode: 1,
          duration: 4,
        }]));
      }
      return realFetch(input, init);
    };
    history.replaceState(null, "", "/show/42");
  });

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 0,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);
  await page.waitForFunction(() => (
    globalThis.__driveInMediabunny?.player?.getStats().videoFrameRenderCount > 0
  ), null, { timeout: 15_000 });
  assert.equal(new URL(page.url()).pathname, "/play");

  await page.goBack();
  await page.waitForFunction(() => (
    location.pathname === "/show/42"
    && !globalThis.__driveInMediabunny
    && !document.querySelector('canvas[data-engine="mediabunny"]')
    && !document.getElementById("overlay").classList.contains("hidden")
    && !document.getElementById("episodes-section").classList.contains("hidden")
    && document.getElementById("eps-show-title").textContent === "Test Show"
  ), null, { timeout: 10_000 });

  const episodeCard = page.locator("#episodes-list .episode-card");
  assert.equal(await episodeCard.locator(".episode-card-title").innerText(), "Test Episode");
  assert.equal(await episodeCard.locator(".episode-card-meta").innerText(), "E1 · 4min");

  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.status === "idle" && status.title === null;
  }, "server playback cleanup after browser back", 5_000);

  await page.goForward();
  await page.waitForFunction(() => (
    location.pathname === "/play"
    && globalThis.__driveInMediabunny?.player?.getStats().videoFrameRenderCount > 0
    && document.getElementById("overlay").classList.contains("hidden")
  ), null, { timeout: 15_000 });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.status === "playing" && status.url === mediaUrl;
  }, "server playback restored after browser forward", 5_000);
});

test("the player stop button preserves resume progress and stops the server session", async (t) => {
  const { baseUrl, runtimeDir } = await startDriveInServer(t);
  const mediaUrl = await createMediaOrigin(t, runtimeDir, { durationSeconds: 12 });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  t.after(() => browser.close());
  const page = await createDriveInPage(browser, { width: 1280, height: 720 });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "browser player connection", 5_000);

  const playResponse = await postJson(baseUrl, "/api/play", {
    url: mediaUrl,
    startTime: 6,
    autoplay: true,
  });
  assert.equal(playResponse.response.status, 200);
  await page.waitForFunction(() => (
    globalThis.__driveInMediabunny?.player?.getCurrentTime() > 6.25
  ), null, { timeout: 15_000 });

  await page.evaluate(() => document.getElementById("btn-back").click());
  await page.waitForFunction(() => (
    location.pathname === "/"
    && !globalThis.__driveInMediabunny
    && !document.querySelector('canvas[data-engine="mediabunny"]')
  ), null, { timeout: 10_000 });

  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.status === "idle" && status.title === null;
  }, "server playback cleanup after stop", 5_000);

  const savedProgress = await waitFor(async () => {
    const history = await fetch(new URL("/api/history", baseUrl)).then((response) => response.json());
    const entry = history.find((item) => item.url === mediaUrl);
    return entry?.progress >= 6 ? entry.progress : false;
  }, "saved playback progress after stop", 5_000);
  assert.ok(savedProgress >= 6 && savedProgress < 12);
});

test("a blocked player can explicitly take over the active player lease", async (t) => {
  const { baseUrl } = await startDriveInServer(t);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (existsSync(macChrome) ? macChrome : undefined);
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  t.after(() => browser.close());

  const activePage = await createDriveInPage(browser, { width: 1180, height: 919 });
  await activePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitFor(async () => {
    const status = await fetch(new URL("/api/status", baseUrl)).then((response) => response.json());
    return status.playerConnected;
  }, "first browser player connection", 5_000);

  const takeoverPage = await createDriveInPage(browser, { width: 1180, height: 919 });
  await takeoverPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await takeoverPage.waitForSelector("#status-actions:not(.hidden)", { timeout: 5_000 });
  assert.equal(
    await takeoverPage.locator("#status-text").innerText(),
    "Drive-In is open in another window",
  );

  await takeoverPage.locator("#btn-take-over").click();
  await takeoverPage.waitForFunction(() => (
    document.getElementById("connection-status")?.classList.contains("hidden")
  ), null, { timeout: 5_000 });

  await activePage.waitForSelector("#status-actions:not(.hidden)", { timeout: 10_000 });
  assert.equal(
    await activePage.locator("#status-text").innerText(),
    "Drive-In is open in another window",
  );
});
