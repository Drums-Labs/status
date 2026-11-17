import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBES, classify, probeOne, parseHistory, prune, summarize, renderPage, escapeHtml, SLOW_MS } from "../src/status.mjs";

const ok200 = (c) => c === 200;
const lt500 = (c) => c < 500;
const DAY = 86_400_000;

test("classify: expected answer, slow answer, wrong answer, error", () => {
  assert.equal(classify({ code: 200, ms: 100 }, ok200), "up");
  assert.equal(classify({ code: 200, ms: SLOW_MS + 1 }, ok200), "degraded");
  assert.equal(classify({ code: 503, ms: 100 }, ok200), "down");
  assert.equal(classify({ code: 302, ms: 100 }, ok200), "down");
  assert.equal(classify({ code: null, ms: 10000, error: "timeout" }, ok200), "down");
  // Supabase: any answer below 500 counts (401 without a key), a 5xx does not
  assert.equal(classify({ code: 401, ms: 100 }, lt500), "up");
  assert.equal(classify({ code: 504, ms: 100 }, lt500), "down");
});

test("the four probes: console sign-in, both gateways, Supabase REST", () => {
  assert.deepEqual(PROBES.map((p) => p.url), [
    "https://console.drums.run/sign-in",
    "https://beta.drums.run/gw/healthz",
    "https://lab.drums.run/gw/healthz",
    "https://eqaqsuesgrzvtrhdjrok.supabase.co/rest/v1/",
  ]);
});

function clock(...ts) { let i = 0; return () => ts[Math.min(i++, ts.length - 1)]; }

test("probeOne records code and latency", async () => {
  const fetchImpl = async () => new Response("ok", { status: 200 });
  const r = await probeOne(PROBES[0], { fetchImpl, now: clock(0, 120) });
  assert.deepEqual(r, { id: "console", status: "up", code: 200, ms: 120 });
});

test("probeOne: a slow correct answer is degraded", async () => {
  const fetchImpl = async () => new Response("ok", { status: 200 });
  const r = await probeOne(PROBES[1], { fetchImpl, now: clock(0, 4500) });
  assert.equal(r.status, "degraded");
});

test("probeOne: a timeout is down with the reason", async () => {
  // AbortSignal.timeout's timer does not hold the event loop open (a real fetch does), so the fake keeps one of its own
  const fetchImpl = (_u, { signal }) => new Promise((_, rej) => {
    const keep = setTimeout(() => {}, 5000);
    signal.addEventListener("abort", () => { clearTimeout(keep); rej(signal.reason); });
  });
  const r = await probeOne(PROBES[1], { fetchImpl, timeoutMs: 20 });
  assert.equal(r.status, "down");
  assert.equal(r.code, null);
  assert.match(r.error, /timeout after 20 ms/);
});

test("probeOne: network error is down", async () => {
  const fetchImpl = async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; };
  const r = await probeOne(PROBES[2], { fetchImpl });
  assert.equal(r.status, "down");
  assert.equal(r.error, "ECONNREFUSED");
});

test("probeOne sends the Supabase anon key only to Supabase, only when set", async () => {
  const seen = [];
  const fetchImpl = async (url, { headers }) => { seen.push([url, headers]); return new Response("", { status: 200 }); };
  const env = { SUPABASE_ANON_KEY: "anon-test" };
  await probeOne(PROBES[3], { fetchImpl, env });
  await probeOne(PROBES[0], { fetchImpl, env });
  await probeOne(PROBES[3], { fetchImpl, env: {} });
  assert.equal(seen[0][1].apikey, "anon-test");
  assert.equal(seen[0][1].authorization, "Bearer anon-test");
  assert.equal(seen[1][1].apikey, undefined);
  assert.equal(seen[2][1].apikey, undefined);
});

test("parseHistory skips torn lines and sorts by time", () => {
  const h = parseHistory('{"t":"2026-11-17T10:05:00Z","results":[]}\n{"t":"2026-11\n\n{"t":"2026-11-17T10:00:00Z","results":[]}\nnot json\n');
  assert.deepEqual(h.map((e) => e.t), ["2026-11-17T10:00:00Z", "2026-11-17T10:05:00Z"]);
});

test("prune keeps 7 days", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const h = [8, 7.01, 6.99, 0].map((d) => ({ t: new Date(now - d * DAY).toISOString(), results: [] }));
  assert.equal(prune(h, now).length, 2);
});

function hist(now, statuses, stepMs = 300_000) {
  return statuses.map((s, i) => ({
    t: new Date(now - (statuses.length - 1 - i) * stepMs).toISOString(),
    results: [{ id: "console", status: s, code: s === "down" ? 503 : 200, ms: 100 }],
  }));
}

test("summarize: uptime counts up and degraded, current is the latest", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const h = hist(now, ["up", "down", "degraded", "up"]);
  const s = summarize(h, now)[0];
  assert.equal(s.uptime24h, 0.75);
  assert.equal(s.uptime7d, 0.75);
  assert.equal(s.current.status, "up");
  assert.equal(s.strip.length, 4);
  // a probe with no rows has no data rather than 0%
  assert.equal(summarize(h, now)[1].uptime24h, null);
});

test("summarize: 24 h window excludes older checks", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const h = [
    { t: new Date(now - 2 * DAY).toISOString(), results: [{ id: "console", status: "down", code: 503, ms: 1 }] },
    { t: new Date(now - 1000).toISOString(), results: [{ id: "console", status: "up", code: 200, ms: 1 }] },
  ];
  const s = summarize(h, now)[0];
  assert.equal(s.uptime24h, 1);
  assert.equal(s.uptime7d, 0.5);
});

test("summarize: strip keeps the last 48 checks", () => {
  const now = Date.now();
  const s = summarize(hist(now, Array(100).fill("up")), now)[0];
  assert.equal(s.strip.length, 48);
});

test("renderPage: overall state, UTC time, escaped error text, no scripts", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const h = [{ t: "2026-11-17T12:00:00.123Z", results: [
    { id: "console", status: "up", code: 200, ms: 90 },
    { id: "gw-lab", status: "down", code: null, ms: 10000, error: "<b>timeout</b>" },
  ] }];
  const html = renderPage(h, now);
  assert.match(html, /Some services are down/);
  assert.match(html, /2026-11-17T12:00:00Z UTC/);
  assert.match(html, /&lt;b&gt;timeout&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /width=device-width/);
  assert.match(renderPage([], now), /No checks yet/);
});

test("escapeHtml", () => assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;"));

test("CLI render writes index.html and status.json", () => {
  const d = mkdtempSync(join(tmpdir(), "status-"));
  const now = Date.now();
  writeFileSync(join(d, "h.jsonl"), hist(now, ["up", "up"]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  execFileSync(process.execPath, [new URL("../src/status.mjs", import.meta.url).pathname, "render", "--history", join(d, "h.jsonl"), "--out", join(d, "site")]);
  assert.match(readFileSync(join(d, "site/index.html"), "utf8"), /All services are answering|Some services/);
  const j = JSON.parse(readFileSync(join(d, "site/status.json"), "utf8"));
  assert.equal(j.probes.length, 4);
  assert.equal(j.probes[0].uptime24h, 1);
});
