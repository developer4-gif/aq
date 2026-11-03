/* Developer tracker (local only): in-memory ring buffers of HTTP requests and pipeline events (also appended to daily JSONL
   files in data/devlogs, 14 days), plus /dev JSON endpoints and pages. Service console logs are tailed from ../.run with secrets masked.
   Never stores query strings, headers, cookies or bodies; ids in paths are masked (/api/v1/playlists/:id/smart). */
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./http.js";

const DEV_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dev-ui");
const ID_PARENTS = new Set(["playlists", "notes", "progress", "jobs", "smart", "videos"]);
const PUBLIC = { done: "ready", expired: "none" };
const pubState = (s) => (s == null ? null : PUBLIC[s] || s);
const KEEP = new Set(["order", "html", "pdf", "smart", "videos"]);
export const CSP_DEV = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Path without query string, ids masked, capped. */
export function maskPath(p) {
  const segs = String(p || "/").split(/[?#]/)[0].slice(0, 300).split("/");
  const api = segs[1] === "api";
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (/^[a-f0-9]{16,}$/i.test(s)) segs[i] = ":id";
    else if (api && s && ID_PARENTS.has(segs[i - 1]) && !KEEP.has(s)) segs[i] = ":id";
  }
  return segs.join("/");
}

/* ---------- persistent daily JSONL (buffered, async) ---------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(requests|events)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LIVE_STORES = new Set();
process.once("exit", () => { for (const s of LIVE_STORES) s.flushSync(); });

/** Appends entries to <dir>/<type>-YYYY-MM-DD.jsonl (UTC day of entry ts). Writes are batched every `flushMs`. */
export function createDevLog({ dir, keepDays = 14, flushMs = 1000, now = Date.now } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let pending = new Map(), timer = null, chain = Promise.resolve();
  const file = (type, day) => path.join(dir, `${type}-${day}.jsonl`);
  const store = {
    dir,
    append(type, e) {
      const f = file(type, String(e.ts).slice(0, 10));
      if (!pending.has(f)) pending.set(f, []);
      pending.get(f).push(JSON.stringify(e) + "\n");
      if (!timer) { timer = setTimeout(() => { timer = null; store.flush(); }, flushMs); timer.unref?.(); }
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      const batch = pending; pending = new Map();
      chain = chain.then(async () => {
        for (const [f, lines] of batch) { try { await fs.promises.appendFile(f, lines.join("")); } catch { /* disk issue: drop, never break requests */ } }
      });
      return chain;
    },
    flushSync() {
      for (const [f, lines] of pending) { try { fs.appendFileSync(f, lines.join("")); } catch { /* ignore */ } }
      pending = new Map();
    },
    /** Deletes files older than keepDays (by the date in the file name). Returns deleted names. */
    prune() {
      const cutoff = new Date(now() - keepDays * 86400000).toISOString().slice(0, 10);
      const gone = [];
      for (const n of fs.readdirSync(dir)) { const m = FILE_RE.exec(n); if (m && m[2] < cutoff) { try { fs.unlinkSync(path.join(dir, n)); gone.push(n); } catch { /* ignore */ } } }
      return gone;
    },
    async days() {
      await store.flush();
      const out = new Map();
      for (const n of fs.readdirSync(dir).sort().reverse()) {
        const m = FILE_RE.exec(n); if (!m) continue;
        const d = out.get(m[2]) || { date: m[2], requests: 0, events: 0, bytes: 0 };
        const buf = await fs.promises.readFile(path.join(dir, n));
        let c = 0; for (const b of buf) if (b === 10) c++;
        d[m[1]] = c; d.bytes += buf.length; out.set(m[2], d);
      }
      return [...out.values()];
    },
    async read(type, day) {
      await store.flush();
      let txt; try { txt = await fs.promises.readFile(file(type, day), "utf8"); } catch { return []; }
      const out = [];
      for (const l of txt.split("\n")) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
      return out;
    },
    close() { store.flushSync(); LIVE_STORES.delete(store); }
  };
  LIVE_STORES.add(store);
  store.prune();
  return store;
}

function ring(max, onPush) {
  const items = []; let seq = 0;
  return {
    push(o) { const e = { seq: ++seq, ts: new Date().toISOString(), ...o }; items.push(e); if (items.length > max) items.shift(); if (onPush) onPush(e); return e; },
    since(s, limit, filter = () => true) {
      const out = [];
      for (const e of items) if (e.seq > s && filter(e)) { out.push(e); if (out.length >= limit) break; }
      return out;
    },
    get last() { return seq; },
    get size() { return items.length; },
    all: () => items
  };
}

export function createTracker({ max = 2000, logDir = "", keepDays = 14, flushMs } = {}) {
  let log = null;
  if (logDir) { try { log = createDevLog({ dir: logDir, keepDays, flushMs }); } catch (e) { console.error(`dev log disabled: ${e.code || e.message}`); } }
  const requests = ring(max, log && ((e) => { if (e.layer !== "dev") log.append("requests", e); }));   // tracker polling is not persisted
  const events = ring(max, log && ((e) => log.append("events", e)));
  return {
    requests, events, log, keepDays,
    request: (o) => requests.push(o),
    /** {kind, jobId, videoId, playlistId, before, after}: pushed only when status/stage/pct changed. */
    change(kind, ids, before, after) {
      if (!after || (before && before.status === after.status && before.stage === after.stage && before.pct === after.pct)) return;
      events.push({ kind, jobId: after.job_id || null, videoId: ids.videoId ?? null, playlistId: ids.playlistId ?? null,
        from: before ? pubState(before.status) : null, to: pubState(after.status), stage: after.stage, pct: after.pct });
    },
    /** fetch wrapper for the Python client: records layer "worker". */
    wrapFetch(fetchImpl) {
      return async (url, opts = {}) => {
        const t = Date.now(); const method = opts.method || "GET";
        let p = "/"; try { p = new URL(url).pathname; } catch { /* keep "/" */ }
        try {
          const res = await fetchImpl(url, opts);
          requests.push({ method, path: maskPath(p), status: res.status, ms: Date.now() - t, layer: "worker" });
          return res;
        } catch (e) {
          requests.push({ method, path: maskPath(p), status: 0, ms: Date.now() - t, layer: "worker" });
          throw e;
        }
      };
    },
    middleware(req, res, next) {
      const t = Date.now();
      res.on("finish", () => {
        const p = req.originalUrl.split("?")[0];
        const layer = p.startsWith("/dev") ? "dev" : p.startsWith("/api/") ? "api" : "ui";
        requests.push({ method: req.method, path: maskPath(p), status: res.statusCode, ms: Date.now() - t, layer });
      });
      next();
    }
  };
}

const num = (v, d, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };

/* ---------- history helpers ---------- */
const REQ_COLS = ["seq", "ts", "layer", "method", "path", "status", "ms"];
const EV_COLS = ["seq", "ts", "kind", "jobId", "videoId", "playlistId", "from", "to", "stage", "pct"];
const str = (v) => (typeof v === "string" ? v.slice(0, 100) : "");

export function filterEntries(type, items, { q = "", layer = "", status = "" } = {}) {
  const t = str(q).trim().toLowerCase(), l = str(layer), s = str(status);
  return items.filter((e) => {
    if (type === "requests") {
      if (l && e.layer !== l) return false;
      if (s && !(s === "0" ? e.status === 0 : String(e.status)[0] === s && e.status !== 0)) return false;
      return !t || `${e.method} ${e.path} ${e.status}`.toLowerCase().includes(t);
    }
    if (l && e.kind !== l) return false;
    if (s && e.to !== s) return false;
    return !t || [e.kind, e.jobId, e.videoId, e.playlistId, e.from, e.to, e.stage].join(" ").toLowerCase().includes(t);
  });
}

/** RFC 4180 CSV; cells starting with = + - @ get a leading ' so spreadsheets do not run them as formulas. */
export function toCsv(type, items) {
  const cols = type === "requests" ? REQ_COLS : EV_COLS;
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...items.map((e) => cols.map((c) => cell(e[c])).join(","))].join("\r\n") + "\r\n";
}

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted, p) { return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null; }
const isErr = (e) => e.status === 0 || e.status >= 500 || (e.status >= 400 && !(e.status === 404 && e.layer === "ui"));

export function computeStats(items) {
  const by = new Map(), hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, errors: 0 }));
  const all = []; let errors = 0;
  for (const e of items) {
    const k = `${e.layer} ${e.method} ${e.path}`;
    let g = by.get(k); if (!g) by.set(k, (g = { layer: e.layer, method: e.method, path: e.path, count: 0, errors: 0, ms: [] }));
    g.count++; g.ms.push(e.ms); all.push(e.ms);
    const h = new Date(e.ts).getUTCHours(); if (h >= 0 && h < 24) hours[h].count++;
    if (isErr(e)) { g.errors++; errors++; if (h >= 0 && h < 24) hours[h].errors++; }
  }
  const sum = (ms) => { ms.sort((a, b) => a - b); return { p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms.length ? ms[ms.length - 1] : null }; };
  const paths = [...by.values()].map(({ ms, ...g }) => ({ ...g, errorRate: g.count ? +(g.errors / g.count).toFixed(4) : 0, ...sum(ms) }))
    .sort((a, b) => b.count - a.count);
  return { total: items.length, errors, errorRate: items.length ? +(errors / items.length).toFixed(4) : 0, ...sum(all), paths, hours };
}

/* ---------- service log tail ---------- */
const SECRETS = [
  [/gsk_[A-Za-z0-9]{8,}/g, "gsk_***"], [/AIza[0-9A-Za-z_-]{16,}/g, "AIza***"], [/nvapi-[A-Za-z0-9_-]{8,}/g, "nvapi-***"],
  [/hf_[A-Za-z0-9]{8,}/g, "hf_***"], [/xai-[A-Za-z0-9_-]{8,}/g, "xai-***"], [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  [/\b(key|api_key|apikey|api-key|token|access_token|secret|password)(["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1$2***"]
];
export function redactLine(s) { let o = String(s); for (const [re, rep] of SECRETS) o = o.replace(re, rep); return o; }

const LOG_FILES = { api: { out: "api.out.log", err: "api.err.log" }, worker: { out: "ai.out.log", err: "ai.err.log" } };
export async function tailFile(file, n, maxBytes = 512 * 1024) {
  let fh; try { fh = await fs.promises.open(file, "r"); } catch { return null; }
  try {
    const { size, mtime } = await fh.stat();
    const len = Math.min(size, maxBytes), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (len < size) lines.shift();                 // partial first line
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { size, mtime: mtime.toISOString(), lines: lines.slice(-n).map((l) => redactLine(l.slice(0, 4000))) };
  } finally { await fh.close(); }
}

export function devRoutes({ db, py, tracker, runDir = "" }) {
  const r = Router();
  r.use((req, res, next) => { res.setHeader("Content-Security-Policy", CSP_DEV); res.setHeader("Cache-Control", "no-store"); next(); });
  r.use((req, _res, next) => (req.method === "GET" || req.method === "HEAD" ? next() : next(new HttpError(405, "Method not allowed."))));

  r.get("/api/overview", async (_req, res) => {
    const t = Date.now(); let worker;
    try {
      const p = await py.json("/api/providers", { timeout: 1500 })   // the worker has no /api/health; routes/misc.js probes this too;
      worker = { ok: p.status === 200, latencyMs: Date.now() - t, error: p.status === 200 ? null : `status ${p.status}` };
    } catch (e) { worker = { ok: false, latencyMs: Date.now() - t, error: e.code === "py_offline" ? "offline" : "error" }; }
    const one = (sql) => db.prepare(sql).get().n;
    const group = (sql, keys) => {
      const out = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const row of db.prepare(sql).all()) if (row.s in out) out[row.s] += row.n;
      return out;
    };
    // notes: latest record per video; smart: latest run per playlist (playlists without a run = none)
    const notes = group(`SELECT CASE status WHEN 'done' THEN 'ready' ELSE status END AS s, COUNT(*) AS n FROM notes_jobs
      WHERE id IN (SELECT MAX(id) FROM notes_jobs GROUP BY video_id) AND status <> 'expired' GROUP BY s`, ["queued", "running", "ready", "error"]);
    const smart = group(`SELECT COALESCE(CASE s.status WHEN 'done' THEN 'ready' ELSE s.status END, 'none') AS s, COUNT(*) AS n FROM playlists p
      LEFT JOIN smart_runs s ON s.id = (SELECT MAX(id) FROM smart_runs WHERE playlist_pk = p.pk) GROUP BY 1`, ["none", "queued", "running", "ready", "error"]);
    const recentErrors = tracker.requests.all().filter((e) => e.layer !== "dev" && (e.status >= 500 || (e.status >= 400 && !(e.status === 404 && e.layer === "ui"))))
      .slice(-10).map((e) => ({ ts: e.ts, path: e.path, status: e.status }));
    const mem = process.memoryUsage();
    res.json({
      generatedAt: new Date().toISOString(),
      services: { api: { ok: true, uptimeSec: Math.round(process.uptime()), pid: process.pid, rssMb: Math.round(mem.rss / 1048576), node: process.version }, worker },
      counts: { playlists: one("SELECT COUNT(*) AS n FROM playlists"), videos: one("SELECT COUNT(*) AS n FROM videos"), notes, smart },
      recentErrors
    });
  });

  r.get("/api/requests", (req, res) => {
    const dev = req.query.include_dev === "1";
    const items = tracker.requests.since(num(req.query.since, 0, Number.MAX_SAFE_INTEGER), num(req.query.limit, 200, 500) || 200, (e) => dev || e.layer !== "dev");
    res.json({ items, last: tracker.requests.last });
  });

  r.get("/api/events", (req, res) => {
    res.json({ items: tracker.events.since(num(req.query.since, 0, Number.MAX_SAFE_INTEGER), 500), last: tracker.events.last });
  });

  r.get("/api/jobs", (_req, res) => {
    const st = (s) => (s === "done" ? "ready" : s === "expired" ? "none" : s);
    const ms = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null);
    const notes = db.prepare("SELECT id, job_id, video_id, status, stage, pct, error, created_at, updated_at FROM notes_jobs ORDER BY id DESC LIMIT 50").all()
      .map((j) => ({ kind: "notes", id: j.job_id, videoId: j.video_id, playlistId: null, state: st(j.status), stage: j.stage, pct: j.status === "done" ? 100 : j.pct,
        provider: null, model: null, startedAt: j.created_at, updatedAt: j.updated_at, durationMs: ms(j.created_at, j.updated_at), error: j.error || null }));
    const smart = db.prepare("SELECT s.job_id, p.slug, s.status, s.stage, s.pct, s.error, s.provider, s.model, s.created_at, s.updated_at FROM smart_runs s JOIN playlists p ON p.pk = s.playlist_pk ORDER BY s.id DESC LIMIT 50").all()
      .map((j) => ({ kind: "smart", id: j.job_id, videoId: null, playlistId: j.slug, state: st(j.status), stage: j.stage, pct: j.status === "done" ? 100 : j.pct,
        provider: j.provider || null, model: j.model || null, startedAt: j.created_at, updatedAt: j.updated_at, durationMs: ms(j.created_at, j.updated_at), error: j.error || null }));
    res.json({ items: [...notes, ...smart].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 50) });
  });
  // ---- persistent history ----
  const today = () => new Date().toISOString().slice(0, 10);
  const histArgs = (req) => {
    const type = req.query.type || "requests", date = req.query.date || today();
    if (type !== "requests" && type !== "events") throw new HttpError(400, "type must be requests or events.");
    if (typeof date !== "string" || !DAY_RE.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD.");
    return { type, date };
  };
  const needLog = () => { if (!tracker.log) throw new HttpError(404, "Persistent dev logs are disabled (AQ_DEVLOG_DIR is empty)."); return tracker.log; };
  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  r.get("/api/history/days", wrap(async (_req, res) => res.json({ keepDays: tracker.keepDays, items: await needLog().days() })));
  r.get("/api/history", wrap(async (req, res) => {
    const { type, date } = histArgs(req); const log = needLog();
    const all = filterEntries(type, await log.read(type, date), req.query).reverse();   // newest first
    const limit = num(req.query.limit, 100, 1000) || 100, offset = num(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    res.json({ type, date, total: all.length, offset, limit, items: all.slice(offset, offset + limit) });
  }));
  r.get("/api/export", wrap(async (req, res) => {
    const { type, date } = histArgs(req); const log = needLog();
    const format = req.query.format === "jsonl" ? "jsonl" : req.query.format === "csv" || req.query.format == null ? "csv" : null;
    if (!format) throw new HttpError(400, "format must be csv or jsonl.");
    const items = filterEntries(type, await log.read(type, date), req.query);
    res.setHeader("Content-Disposition", `attachment; filename="aq-${type}-${date}.${format}"`);
    res.type(format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
    res.send(format === "csv" ? toCsv(type, items) : items.map((e) => JSON.stringify(e) + "\n").join(""));
  }));
  r.get("/api/stats", wrap(async (req, res) => {
    const { date } = histArgs({ query: { type: "requests", date: req.query.date } });
    const items = filterEntries("requests", await needLog().read("requests", date), { layer: req.query.layer });
    res.json({ date, ...computeStats(items) });
  }));

  // ---- service console logs (.run/*.log written by start-all.ps1) ----
  r.get("/api/logs/:service", wrap(async (req, res) => {
    const files = LOG_FILES[req.params.service];
    if (!files) throw new HttpError(404, "Unknown service (api or worker).");
    if (!runDir) throw new HttpError(404, "Service log capture is not configured (AQ_RUN_DIR).");
    const n = num(req.query.tail, 200, 2000) || 200, streams = {};
    const prev = req.query.run === "prev";                  // start-all.ps1 keeps the previous run as *.prev.log
    for (const [k, f] of Object.entries(files)) streams[k] = await tailFile(path.join(runDir, prev ? f.replace(/\.log$/, ".prev.log") : f), n);
    res.json({ service: req.params.service, run: prev ? "prev" : "current", generatedAt: new Date().toISOString(), tail: n, streams });
  }));

  r.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

  if (fs.existsSync(DEV_UI)) {
    r.use((req, _res, next) => (/^\/[A-Za-z0-9_-]*(\.(html|js|css|svg|png|json))?$/.test(req.path) ? next() : next(new HttpError(404, "Not found."))));
    r.use(express.static(DEV_UI, { index: "index.html", dotfiles: "ignore", etag: true, maxAge: 0, redirect: false, fallthrough: true }));
  }
  return r;
}
