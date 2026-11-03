import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { startApp, startMockPython, VID } from "./helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTracker, createDevLog, maskPath, toCsv, computeStats, percentile, redactLine, filterEntries } from "../src/dev.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("dev tools: enabled by default, overview shape, no-store and strict CSP", async () => {
  const py = await startMockPython();
  const a = await startApp({ py });
  try {
    const r = await a.get("/dev/api/overview");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    const o = r.json;
    assert.equal(typeof o.generatedAt, "string");
    assert.equal(o.services.api.ok, true);
    for (const k of ["uptimeSec", "pid", "rssMb"]) assert.equal(typeof o.services.api[k], "number");
    assert.equal(typeof o.services.worker.ok, "boolean");   // probed via the worker's /api/providers
    assert.deepEqual(Object.keys(o.counts.notes), ["queued", "running", "ready", "error"]);
    assert.deepEqual(Object.keys(o.counts.smart), ["none", "queued", "running", "ready", "error"]);
    assert.ok(Array.isArray(o.recentErrors));
    assert.equal((await a.get("/dev/api/jobs")).json.items.length, 0);
    assert.equal((await a.get("/dev/api/nope")).status, 404);
    assert.equal((await a.post("/dev/api/overview", {})).status, 405);
    const port = new URL(a.base).port;
    const code = await new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: "/dev/api/overview", headers: { Host: "evil.example.com" } }, (x) => { x.resume(); res(x.statusCode); }).on("error", rej));
    assert.equal(code, 403);
  } finally { await a.close(); await py.close(); }
});

test("dev tools: AQ_DEV_TOOLS=0 -> /dev is 404", async () => {
  const a = await startApp({ overrides: { devTools: false } });
  try {
    assert.equal((await a.get("/dev/api/overview")).status, 404);
    assert.equal((await a.get("/dev/api/requests")).status, 404);
    assert.equal(a.app.locals.tracker, null);
  } finally { await a.close(); }
});

test("requests: query strings stripped, ids masked, dev polling excluded, secrets never returned", async () => {
  const py = await startMockPython();
  const a = await startApp({ py, overrides: { requireMembership: false } });
  try {
    await a.get("/api/v1/playlists?key=SUPERSECRET123", { authorization: "Bearer TOPSECRETTOKEN" });
    await a.get("/api/v1/playlists/my-list-1/smart?key=SUPERSECRET123");
    await a.post("/api/v1/notes/" + VID(1), {});
    const r = await a.get("/dev/api/requests?since=0");
    const paths = r.json.items.map((e) => e.path);
    assert.ok(paths.includes("/api/v1/playlists"));
    assert.ok(paths.includes("/api/v1/playlists/:id/smart"));
    assert.ok(paths.includes("/api/v1/notes/:id"));
    assert.ok(r.json.items.some((e) => e.layer === "worker" && e.path === "/api/jobs" && e.method === "POST"));
    assert.ok(r.json.items.every((e) => e.layer !== "dev"));
    for (const e of r.json.items) assert.deepEqual(Object.keys(e).sort(), ["layer", "method", "ms", "path", "seq", "status", "ts"]);
    assert.ok((await a.get("/dev/api/requests?since=0&include_dev=1")).json.items.some((e) => e.layer === "dev"));
    const since = (await a.get(`/dev/api/requests?since=${r.json.last}`)).json;
    assert.ok(since.items.every((e) => e.seq > r.json.last));

    py.state.jobs.values().next().value.status = "done";
    await a.get("/api/v1/notes/" + VID(1));
    const all = [];
    for (const p of ["/dev/api/overview", "/dev/api/requests?include_dev=1&limit=500", "/dev/api/events", "/dev/api/jobs"]) all.push((await a.get(p)).text);
    const blob = all.join("\n");
    for (const s of ["SUPERSECRET123", "TOPSECRETTOKEN", "key=", "Bearer", "?"]) assert.ok(!blob.includes(s), `leaked ${s}`);
  } finally { await a.close(); await py.close(); }
});

test("events + jobs: notes job state changes are recorded", async () => {
  const py = await startMockPython();
  const a = await startApp({ py, overrides: { requireMembership: false } });
  try {
    await a.post("/api/v1/notes/" + VID(1), {});
    await a.get("/api/v1/notes/" + VID(1));                 // queued -> running 40
    py.state.jobs.values().next().value.status = "done";
    await a.get("/api/v1/notes/" + VID(1));                 // running -> done
    const ev = (await a.get("/dev/api/events?since=0")).json;
    assert.deepEqual(ev.items.map((e) => [e.from, e.to]), [[null, "queued"], ["queued", "running"], ["running", "ready"]]);
    assert.equal(ev.items[0].kind, "notes");
    assert.equal(ev.items[0].videoId, VID(1));
    assert.equal(ev.items[2].pct, 100);
    assert.equal((await a.get(`/dev/api/events?since=${ev.last}`)).json.items.length, 0);
    const jobs = (await a.get("/dev/api/jobs")).json.items;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "ready");
    assert.equal(jobs[0].kind, "notes");
    assert.equal((await a.get("/dev/api/overview")).json.counts.notes.ready, 1);
  } finally { await a.close(); await py.close(); }
});

test("ring buffer keeps the last N entries; maskPath", () => {
  const t = createTracker({ max: 2000 });
  for (let i = 0; i < 2500; i++) t.request({ method: "GET", path: "/x", status: 200, ms: 1, layer: "api" });
  assert.equal(t.requests.size, 2000);
  assert.equal(t.requests.last, 2500);
  assert.equal(t.requests.since(0, 500)[0].seq, 501);
  assert.equal(t.requests.since(0, 500).length, 500);
  assert.equal(maskPath("/api/v1/playlists/abc/videos/aaaaaaaaaa1?x=1"), "/api/v1/playlists/:id/videos/:id");
  assert.equal(maskPath("/api/v1/playlists/abc/videos/order"), "/api/v1/playlists/:id/videos/order");
  assert.equal(maskPath("/api/jobs/" + "a".repeat(32) + "/notes.html"), "/api/jobs/:id/notes.html");
  assert.equal(maskPath("/app.js"), "/app.js");
});

test("persistent logs: JSONL files written, redacted, dev polling not persisted; history/days/export/stats endpoints", async () => {
  const py = await startMockPython();
  const dir = tmp("aq-devlog-");
  const a = await startApp({ py, overrides: { requireMembership: false, devLogDir: dir } });
  try {
    await a.get("/api/v1/playlists?key=SUPERSECRET123", { authorization: "Bearer TOPSECRETTOKEN" });
    await a.get("/api/v1/playlists/my-list-1/smart?key=SUPERSECRET123");
    await a.post("/api/v1/notes/" + VID(1), {});
    await a.get("/api/v1/nope");
    await a.get("/dev/api/overview");
    await a.app.locals.tracker.log.flush();
    const day = new Date().toISOString().slice(0, 10);
    const raw = fs.readFileSync(path.join(dir, `requests-${day}.jsonl`), "utf8");
    for (const s of ["SUPERSECRET123", "TOPSECRETTOKEN", "key=", "Bearer", "?", "/dev/"]) assert.ok(!raw.includes(s), `leaked ${s}`);
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    for (const e of lines) assert.deepEqual(Object.keys(e).sort(), ["layer", "method", "ms", "path", "seq", "status", "ts"]);
    assert.ok(fs.readFileSync(path.join(dir, `events-${day}.jsonl`), "utf8").includes('"to":"queued"'));

    const days = (await a.get("/dev/api/history/days")).json;
    assert.equal(days.items[0].date, day);
    assert.equal(days.items[0].requests, lines.length);
    assert.equal(days.items[0].events, 1);

    const h = await a.get(`/dev/api/history?type=requests&date=${day}&q=smart`);
    assert.equal(h.headers.get("cache-control"), "no-store");
    assert.deepEqual(h.json.items.map((e) => e.path), ["/api/v1/playlists/:id/smart"]);
    const h4 = (await a.get(`/dev/api/history?type=requests&date=${day}&status=4&layer=api`)).json;
    assert.ok(h4.total >= 1 && h4.items.every((e) => e.status >= 400 && e.status < 500 && e.layer === "api"));
    const page = (await a.get(`/dev/api/history?type=requests&date=${day}&limit=1&offset=1`)).json;
    assert.equal(page.items.length, 1); assert.equal(page.total, lines.length);
    assert.deepEqual(page.items[0], lines[lines.length - 2]);          // newest first
    assert.equal((await a.get(`/dev/api/history?type=events&date=${day}&q=notes`)).json.total, 1);
    assert.equal((await a.get("/dev/api/history?date=2026-1-1")).status, 400);
    assert.equal((await a.get("/dev/api/history?type=../x")).status, 400);
    assert.equal((await a.get("/dev/api/history?date=2000-01-01")).json.total, 0);

    const csv = await a.get(`/dev/api/export?type=requests&date=${day}&format=csv`);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.equal(csv.headers.get("content-disposition"), `attachment; filename="aq-requests-${day}.csv"`);
    assert.equal(csv.text.split("\r\n")[0], "seq,ts,layer,method,path,status,ms");
    assert.equal(csv.text.trim().split("\r\n").length, lines.length + 1);
    const jl = await a.get(`/dev/api/export?type=events&date=${day}&format=jsonl`);
    assert.equal(JSON.parse(jl.text.trim()).to, "queued");
    assert.equal((await a.get("/dev/api/export?format=xml")).status, 400);

    const s = (await a.get(`/dev/api/stats?date=${day}`)).json;
    assert.equal(s.total, lines.length);
    assert.equal(s.hours.length, 24);
    assert.ok(s.paths.some((p) => p.path === "/api/v1/nope" && p.errors === 1 && p.errorRate === 1));
  } finally { await a.close(); a.app.locals.tracker.log.close(); await py.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("devlog retention deletes files older than keepDays; disabled log -> 404", async () => {
  const dir = tmp("aq-devlog-");
  const now = Date.parse("2026-11-20T12:00:00Z");
  for (const d of ["2026-11-01", "2026-11-05", "2026-11-06", "2026-11-20"]) {
    fs.writeFileSync(path.join(dir, `requests-${d}.jsonl`), ""); fs.writeFileSync(path.join(dir, `events-${d}.jsonl`), "");
  }
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  createDevLog({ dir, keepDays: 14, now: () => now }).close();
  assert.deepEqual(fs.readdirSync(dir).sort(), ["events-2026-11-06.jsonl", "events-2026-11-20.jsonl", "notes.txt", "requests-2026-11-06.jsonl", "requests-2026-11-20.jsonl"]);
  fs.rmSync(dir, { recursive: true, force: true });
  const a = await startApp();
  try {
    assert.equal((await a.get("/dev/api/history")).status, 404);
    assert.equal((await a.get("/dev/api/logs/api")).status, 404);
  } finally { await a.close(); }
});

test("tracker buffers writes (no file until flush), /dev entries not persisted", async () => {
  const dir = tmp("aq-devlog-");
  const t = createTracker({ logDir: dir, flushMs: 60000 });
  t.request({ method: "GET", path: "/x", status: 200, ms: 1, layer: "api" });
  t.request({ method: "GET", path: "/dev/api/requests", status: 200, ms: 1, layer: "dev" });
  assert.equal(fs.readdirSync(dir).length, 0);
  await t.log.flush();
  const f = fs.readdirSync(dir);
  assert.equal(f.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, f[0]), "utf8").trim().split("\n").length, 1);
  t.log.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("CSV escaping, stats math, filters", () => {
  const csv = toCsv("events", [{ seq: 1, ts: "t", kind: "smart", jobId: 'a,"b"', videoId: null, playlistId: "x\ny", from: "=cmd()", to: "ready", stage: "s", pct: 100 }]);
  assert.equal(csv, 'seq,ts,kind,jobId,videoId,playlistId,from,to,stage,pct\r\n1,t,smart,"a,""b""",,"x\ny",\'=cmd(),ready,s,100\r\n');
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), null);
  const mk = (p, status, ms, h) => ({ method: "GET", path: p, status, ms, layer: "api", ts: `2026-11-03T${String(h).padStart(2, "0")}:10:00.000Z` });
  const items = [mk("/a", 200, 10, 1), mk("/a", 200, 20, 1), mk("/a", 500, 30, 2), mk("/a", 200, 40, 2), mk("/b", 0, 100, 23)];
  const s = computeStats(items);
  assert.equal(s.total, 5); assert.equal(s.errors, 2); assert.equal(s.errorRate, 0.4);
  assert.equal(s.p50, 30); assert.equal(s.p95, 100);
  assert.deepEqual(s.paths[0], { layer: "api", method: "GET", path: "/a", count: 4, errors: 1, errorRate: 0.25, p50: 20, p95: 40, max: 40 });
  assert.deepEqual([s.hours[1].count, s.hours[2].count, s.hours[2].errors, s.hours[23].errors], [2, 2, 1, 1]);
  assert.equal(filterEntries("requests", items, { status: "0" }).length, 1);
  assert.equal(filterEntries("requests", items, { status: "5" }).length, 1);
  assert.equal(filterEntries("requests", items, { q: "/B" }).length, 1);
});

test("service log tail masks secrets", async () => {
  const run = tmp("aq-run-");
  const secrets = ["gsk_abcdefghij1234567890", "AIzaSyA1234567890abcdefghij", "nvapi-abcdefghijkl123", "hf_abcdefghijkl123", "xai-abcdefghijkl123", "sk-proj-abcdefghijklmnop1234"];
  const lines = ["INFO start", ...secrets.map((s) => `WARNING using ${s} now`), "GET /x?key=TOPSECRET&x=1", "Authorization: Bearer abc.def.ghi", 'api_key="PLAINSECRET"', "ERROR last"];
  fs.writeFileSync(path.join(run, "ai.out.log"), lines.join("\r\n") + "\r\n");
  fs.writeFileSync(path.join(run, "ai.err.log"), "Traceback boom\n");
  const a = await startApp({ overrides: { runDir: run } });
  try {
    const r = await a.get("/dev/api/logs/worker?tail=100");
    assert.equal(r.status, 200);
    for (const s of [...secrets, "TOPSECRET", "abc.def.ghi", "PLAINSECRET"]) assert.ok(!r.text.includes(s), `leaked ${s}`);
    assert.equal(r.json.streams.out.lines[0], "INFO start");
    assert.equal(r.json.streams.out.lines.at(-1), "ERROR last");
    assert.deepEqual(r.json.streams.err.lines, ["Traceback boom"]);
    assert.deepEqual((await a.get("/dev/api/logs/worker?tail=2")).json.streams.out.lines, ['api_key="***"', "ERROR last"]);
    assert.equal((await a.get("/dev/api/logs/api")).json.streams.out, null);     // not captured -> null
    assert.equal((await a.get("/dev/api/logs/..%2Fetc")).status, 404);
    assert.equal(redactLine("x key=abc&y=1 token: zzz"), "x key=***&y=1 token: ***");
  } finally { await a.close(); fs.rmSync(run, { recursive: true, force: true }); }
});
