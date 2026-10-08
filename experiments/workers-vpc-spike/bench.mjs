#!/usr/bin/env node
// Streams segment-sized files through the spike Worker for a long period,
// alternating the VPC path and the public tunnel path, then prints a verdict.
//
//   node bench.mjs --worker https://yolo-spike-vpc.<sub>.workers.dev --minutes 60
//
// The token comes from --token or the SPIKE_TOKEN environment variable.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_PATH = "/lib/fonts/noto-sans-sc/files/noto-sans-sc-chinese-simplified-800-normal.woff";

// Pass criteria. A 720p stream needs about 4.8 Mbps, so the slow tail of the
// VPC path must still carry twice that.
const MAX_VPC_ERROR_RATE = 0.005;
const MIN_VPC_P5_MBPS = 10;
const MAX_TTFB_RATIO = 1.5;
const TTFB_SLACK_MS = 100;

const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    token: { type: "string" },
    minutes: { type: "string", default: "60" },
    interval: { type: "string", default: "4" },
    path: { type: "string", default: DEFAULT_PATH },
    timeout: { type: "string", default: "30" },
    out: { type: "string" },
  },
});

const worker = values.worker;
const token = values.token || process.env.SPIKE_TOKEN;
if (!worker || !token) {
  console.error("Usage: node bench.mjs --worker <url> [--token <token>] [--minutes 60] [--interval 4] [--path <path>]");
  process.exit(2);
}
const minutes = Number(values.minutes);
const intervalMs = Number(values.interval) * 1000;
const timeoutMs = Number(values.timeout) * 1000;
const outFile = values.out || `vpc-spike-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

const samples = [];
const startedAt = Date.now();
let stopping = false;

process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping after the current request...");
});

async function measure(via) {
  const url = new URL(values.path, worker);
  url.searchParams.set("__via", via);
  // A unique query string keeps Cloudflare's cache out of the public path.
  url.searchParams.set("r", crypto.randomUUID());
  const sample = { at: new Date().toISOString(), via };
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    sample.status = res.status;
    sample.ttfbMs = Math.round(performance.now() - t0);
    sample.servedVia = res.headers.get("x-spike-via");
    sample.cacheStatus = res.headers.get("cf-cache-status");
    sample.upstreamMs = parseUpstreamMs(res.headers.get("server-timing"));
    let bytes = 0;
    for await (const chunk of res.body) bytes += chunk.byteLength;
    const totalMs = performance.now() - t0;
    sample.bytes = bytes;
    sample.totalMs = Math.round(totalMs);
    sample.mbps = round((bytes * 8) / (totalMs / 1000) / 1e6);
    sample.ok = res.ok && bytes > 0 && sample.servedVia === via && sample.cacheStatus !== "HIT";
    if (!sample.ok) sample.error = describeFailure(sample);
  } catch (err) {
    sample.ok = false;
    sample.totalMs = Math.round(performance.now() - t0);
    sample.error = err?.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : err?.message || String(err);
  }
  return sample;
}

function describeFailure(sample) {
  if (sample.servedVia !== sample.via) return `wrong path: expected ${sample.via}, got ${sample.servedVia}`;
  if (sample.cacheStatus === "HIT") return "served from Cloudflare cache";
  if (!sample.bytes) return "empty body";
  return `HTTP ${sample.status}`;
}

function parseUpstreamMs(header) {
  const match = /upstream;[^,]*dur=([\d.]+)/.exec(header || "");
  return match ? Number(match[1]) : null;
}

function percentile(list, p) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function summarize(list) {
  const ok = list.filter((s) => s.ok);
  const pick = (key) => ok.map((s) => s[key]).filter((v) => v != null);
  return {
    requests: list.length,
    errors: list.length - ok.length,
    errorRate: list.length ? (list.length - ok.length) / list.length : 0,
    bytes: ok.reduce((sum, s) => sum + s.bytes, 0),
    ttfbMs: { p50: percentile(pick("ttfbMs"), 50), p95: percentile(pick("ttfbMs"), 95), max: percentile(pick("ttfbMs"), 100) },
    upstreamMs: { p50: percentile(pick("upstreamMs"), 50), p95: percentile(pick("upstreamMs"), 95) },
    totalMs: { p50: percentile(pick("totalMs"), 50), p95: percentile(pick("totalMs"), 95), max: percentile(pick("totalMs"), 100) },
    mbps: { p5: percentile(pick("mbps"), 5), p50: percentile(pick("mbps"), 50) },
  };
}

function line(name, s) {
  return `${name}: n=${s.requests} err=${s.errors} ttfb p50=${s.ttfbMs.p50}ms p95=${s.ttfbMs.p95}ms mbps p5=${s.mbps.p5} p50=${s.mbps.p50}`;
}

function verdict(vpc, pub) {
  const checks = [
    {
      name: `VPC error rate <= ${MAX_VPC_ERROR_RATE * 100}%`,
      pass: vpc.requests > 0 && vpc.errorRate <= MAX_VPC_ERROR_RATE,
      actual: `${round(vpc.errorRate * 100)}% (${vpc.errors}/${vpc.requests})`,
    },
    {
      name: `VPC slow-tail throughput (p5) >= ${MIN_VPC_P5_MBPS} Mbps`,
      pass: (vpc.mbps.p5 ?? 0) >= MIN_VPC_P5_MBPS,
      actual: `${vpc.mbps.p5} Mbps`,
    },
    {
      name: `VPC TTFB p95 <= public p95 x ${MAX_TTFB_RATIO} + ${TTFB_SLACK_MS} ms`,
      pass: vpc.ttfbMs.p95 != null && pub.ttfbMs.p95 != null
        && vpc.ttfbMs.p95 <= pub.ttfbMs.p95 * MAX_TTFB_RATIO + TTFB_SLACK_MS,
      actual: `${vpc.ttfbMs.p95} ms vs ${pub.ttfbMs.p95} ms`,
    },
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

console.log(`Benchmarking ${worker}${values.path} for ${minutes} min, one request every ${intervalMs / 1000}s, alternating vpc/public.`);

const deadline = startedAt + minutes * 60_000;
let nextReport = startedAt + 60_000;
for (let i = 0; Date.now() < deadline && !stopping; i += 1) {
  const tickStart = Date.now();
  const sample = await measure(i % 2 === 0 ? "vpc" : "public");
  samples.push(sample);
  if (!sample.ok) console.log(`  ${sample.at} ${sample.via} FAILED: ${sample.error}`);

  if (Date.now() >= nextReport) {
    const elapsed = Math.round((Date.now() - startedAt) / 60_000);
    const recent = samples.filter((s) => Date.parse(s.at) >= nextReport - 60_000);
    console.log(`[${elapsed}/${minutes} min] ${line("vpc", summarize(recent.filter((s) => s.via === "vpc")))} | ${line("public", summarize(recent.filter((s) => s.via === "public")))}`);
    nextReport += 60_000;
  }

  const wait = intervalMs - (Date.now() - tickStart);
  if (wait > 0 && !stopping) await new Promise((resolve) => setTimeout(resolve, wait));
}

const vpc = summarize(samples.filter((s) => s.via === "vpc"));
const pub = summarize(samples.filter((s) => s.via === "public"));
const result = verdict(vpc, pub);

console.log("\nTotals");
console.log(`  ${line("vpc", vpc)}`);
console.log(`  ${line("public", pub)}`);
console.log(`\nVerdict: ${result.pass ? "PASS" : "FAIL"}`);
for (const check of result.checks) console.log(`  [${check.pass ? "x" : " "}] ${check.name}: ${check.actual}`);

writeFileSync(outFile, JSON.stringify({ worker, path: values.path, startedAt: new Date(startedAt).toISOString(), minutes, summary: { vpc, public: pub }, verdict: result, samples }, null, 2));
console.log(`\nRaw samples: ${outFile}`);
process.exit(result.pass ? 0 : 1);
