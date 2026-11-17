// Drums status probe and page generator. Plain Node (>= 20), no dependencies.
//
//   node src/status.mjs probe  --history data/history.jsonl     probe every target, append one line, prune to 7 days
//   node src/status.mjs render --history data/history.jsonl --out site
//
// History is JSON Lines, one line per run: {"t":"<ISO UTC>","results":[{"id","status","code","ms","error"?}]}.
// status is "up", "degraded" (answered correctly but slower than SLOW_MS) or "down" (wrong answer, 5xx, timeout,
// network error).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TIMEOUT_MS = 10_000;
export const SLOW_MS = 3_000;
export const KEEP_DAYS = 7;
export const STRIP_CHECKS = 48; // 4 h at one check per 5 min

const SUPABASE_REST = "https://eqaqsuesgrzvtrhdjrok.supabase.co/rest/v1/";

/**
 * accept(code) says whether an HTTP answer is a correct one. The Supabase REST endpoint counts as answering for any
 * status below 500 (without a key it answers 401, which still proves the API layer responds; the 2026-11-16 outage
 * showed timeouts and 5xx).
 */
export const PROBES = [
  { id: "console", name: "Console sign-in", url: "https://console.drums.run/sign-in", accept: (c) => c === 200 },
  { id: "gw-beta", name: "Gateway beta.drums.run", url: "https://beta.drums.run/gw/healthz", accept: (c) => c === 200 },
  { id: "gw-lab", name: "Gateway lab.drums.run", url: "https://lab.drums.run/gw/healthz", accept: (c) => c === 200 },
  { id: "supabase", name: "Control-plane database (Supabase REST)", url: SUPABASE_REST, accept: (c) => c < 500, supabase: true },
];

export function classify({ code, ms, error }, accept, slowMs = SLOW_MS) {
  if (error || code == null || !accept(code)) return "down";
  return ms > slowMs ? "degraded" : "up";
}

export async function probeOne(probe, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, env = process.env, now = () => performance.now() } = {}) {
  const headers = { "user-agent": "drums-status-probe" };
  if (probe.supabase && env.SUPABASE_ANON_KEY) {
    headers.apikey = env.SUPABASE_ANON_KEY;
    headers.authorization = `Bearer ${env.SUPABASE_ANON_KEY}`;
  }
  const t0 = now();
  let code = null;
  let error;
  try {
    const res = await fetchImpl(probe.url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    code = res.status;
    try { await res.arrayBuffer(); } catch { /* body read errors do not change the status code */ }
  } catch (e) {
    error = e?.name === "TimeoutError" || e?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : String(e?.cause?.code || e?.message || e);
  }
  const ms = Math.round(now() - t0);
  const out = { id: probe.id, status: classify({ code, ms, error }, probe.accept), code, ms };
  if (error) out.error = error;
  return out;
}

export async function probeAll(probes = PROBES, opts = {}) {
  return Promise.all(probes.map((p) => probeOne(p, opts)));
}

export function parseHistory(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.t === "string" && Array.isArray(e.results) && !Number.isNaN(Date.parse(e.t))) out.push(e);
    } catch { /* a torn or hand-edited line is skipped, not fatal */ }
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export function prune(history, nowMs, days = KEEP_DAYS) {
  const cut = nowMs - days * 86_400_000;
  return history.filter((e) => Date.parse(e.t) >= cut);
}

/** Per probe: latest result, uptime over 24 h and 7 d (up or degraded counts as available), recent strip. */
export function summarize(history, nowMs, probes = PROBES) {
  return probes.map((p) => {
    const rows = history.map((e) => ({ t: e.t, r: e.results.find((r) => r.id === p.id) })).filter((x) => x.r);
    const uptime = (hours) => {
      const w = rows.filter((x) => Date.parse(x.t) >= nowMs - hours * 3_600_000);
      if (!w.length) return null;
      return w.filter((x) => x.r.status !== "down").length / w.length;
    };
    const last = rows.at(-1) ?? null;
    return {
      id: p.id, name: p.name, url: p.url,
      current: last ? { t: last.t, ...last.r } : null,
      uptime24h: uptime(24), uptime7d: uptime(24 * KEEP_DAYS),
      strip: rows.slice(-STRIP_CHECKS).map((x) => ({ t: x.t, status: x.r.status, code: x.r.code, ms: x.r.ms })),
    };
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const pct = (x) => (x == null ? "no data" : `${(Math.floor(x * 10000) / 100).toFixed(2)}%`);
const LABEL = { up: "Up", degraded: "Slow", down: "Down" };

export function renderPage(history, nowMs, probes = PROBES) {
  const sum = summarize(history, nowMs, probes);
  const updated = history.length ? history.at(-1).t : null;
  const anyDown = sum.some((s) => s.current?.status === "down");
  const anySlow = sum.some((s) => s.current?.status === "degraded");
  const overall = !updated ? ["unknown", "No checks yet"] : anyDown ? ["down", "Some services are down"] : anySlow ? ["degraded", "Some services are slow"] : ["up", "All services are answering"];
  const rows = sum.map((s) => {
    const c = s.current;
    const state = c ? c.status : "unknown";
    const detail = c ? (c.error ? escapeHtml(c.error) : `HTTP ${c.code} in ${c.ms} ms`) : "no data";
    const strip = s.strip.map((x) => `<i class="${x.status}" title="${escapeHtml(`${x.t} ${LABEL[x.status] ?? x.status} ${x.code ?? "-"} ${x.ms} ms`)}"></i>`).join("");
    return `<section class="probe">
  <div class="head"><h2>${escapeHtml(s.name)}</h2><span class="pill ${state}">${LABEL[state] ?? "Unknown"}</span></div>
  <p class="detail">${detail}</p>
  <div class="strip" aria-label="last ${s.strip.length} checks, oldest first">${strip}</div>
  <dl><div><dt>24 h</dt><dd>${pct(s.uptime24h)}</dd></div><div><dt>7 days</dt><dd>${pct(s.uptime7d)}</dd></div></dl>
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drums status</title><meta http-equiv="refresh" content="300">
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--up:#15803d;--deg:#b45309;--down:#b91c1c;--none:#a8a29e}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--up:#22c55e;--deg:#f59e0b;--down:#ef4444;--none:#57534e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0;font-weight:600}
.overall{margin:16px 0 24px;padding:14px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);font-weight:600}
.overall.up{border-left:4px solid var(--up)}.overall.degraded{border-left:4px solid var(--deg)}.overall.down{border-left:4px solid var(--down)}.overall.unknown{border-left:4px solid var(--none)}
.probe{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px}
.head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.pill{font-size:12px;font-weight:600;padding:2px 10px;border-radius:999px;color:#fff;white-space:nowrap}
.pill.up{background:var(--up)}.pill.degraded{background:var(--deg)}.pill.down{background:var(--down)}.pill.unknown{background:var(--none)}
.detail{margin:4px 0 10px;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.strip{display:flex;gap:2px;height:22px}.strip i{flex:1;min-width:2px;border-radius:2px;background:var(--none)}
.strip i.up{background:var(--up)}.strip i.degraded{background:var(--deg)}.strip i.down{background:var(--down)}
dl{display:flex;gap:24px;margin:10px 0 0}dl div{display:flex;gap:6px}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}
footer,.sub{color:var(--muted);font-size:13px}footer{margin-top:24px}a{color:inherit}
</style></head>
<body><main>
<h1>Drums status</h1>
<p class="sub">Checked every 5 minutes from GitHub Actions, outside the Drums hosts, console and database. Last check: ${updated ? escapeHtml(updated.replace(/\.\d+Z$/, "Z")) + " UTC" : "none yet"}.</p>
<div class="overall ${overall[0]}">${overall[1]}</div>
${rows}
<footer>Up: the expected answer within ${SLOW_MS / 1000} s. Slow: the expected answer, after more than ${SLOW_MS / 1000} s. Down: a wrong answer, a 5xx, or no answer within ${TIMEOUT_MS / 1000} s. Uptime counts Up and Slow. The bar shows the last ${STRIP_CHECKS} checks, oldest first. Machine-readable: <a href="status.json">status.json</a>.</footer>
</main></body></html>
`;
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const cmd = process.argv[2];
  const histPath = arg("history", "data/history.jsonl");
  const history = existsSync(histPath) ? parseHistory(readFileSync(histPath, "utf8")) : [];
  const nowMs = Date.now();
  if (cmd === "probe") {
    const results = await probeAll();
    const entry = { t: new Date(nowMs).toISOString(), results };
    const kept = prune([...history, entry], nowMs);
    mkdirSync(dirname(histPath), { recursive: true });
    writeFileSync(histPath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const r of results) console.log(`${r.id.padEnd(9)} ${r.status.padEnd(9)} ${String(r.code ?? "-").padEnd(4)} ${String(r.ms).padStart(6)} ms${r.error ? `  ${r.error}` : ""}`);
    console.log(`history: ${kept.length} checks kept (${KEEP_DAYS} days)`);
  } else if (cmd === "render") {
    const out = arg("out", "site");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), renderPage(history, nowMs));
    writeFileSync(join(out, "status.json"), JSON.stringify({ updated: history.at(-1)?.t ?? null, probes: summarize(history, nowMs) }, null, 2) + "\n");
    console.log(`wrote ${out}/index.html and ${out}/status.json from ${history.length} checks`);
  } else {
    console.error("usage: node src/status.mjs probe|render [--history FILE] [--out DIR]");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
