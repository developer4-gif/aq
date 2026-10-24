import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startApp, startMockPython } from "./helpers.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { assertPyUrl } from "../src/pyclient.js";
import { rateLimit } from "../src/middleware/security.js";

test("health, security headers, JSON 404s", async () => {
  const t = await startApp();
  try {
    const r = await t.get("/api/v1/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(r.headers.get("x-powered-by"), null);
    const nf = await t.get("/api/v1/nothing");
    assert.equal(nf.status, 404);
    assert.equal(typeof nf.json.error, "string");
    assert.equal((await t.get("/api/other")).status, 404);
  } finally { await t.close(); }
});

test("health?deep=1 reports the notes service", async () => {
  const py = await startMockPython();
  const t = await startApp({ py });
  try {
    assert.equal((await t.get("/api/v1/health?deep=1")).json.notesService, "ok");
    await py.close();
    assert.equal((await t.get("/api/v1/health?deep=1")).json.notesService, "offline");
  } finally { await t.close(); }
});

test("DNS-rebinding guard: foreign Host header is refused", async () => {
  const t = await startApp();
  try {
    const port = new URL(t.base).port;
    const status = await new Promise((res, rej) => {
      http.get({ host: "127.0.0.1", port, path: "/api/v1/health", headers: { Host: "evil.example.com" } }, (r) => { r.resume(); res(r.statusCode); }).on("error", rej);
    });
    assert.equal(status, 403);
  } finally { await t.close(); }
});

test("CORS: local origins allowed, foreign origins get no CORS headers and cannot write", async () => {
  const t = await startApp();
  try {
    let r = await t.get("/api/v1/health", { Origin: "http://localhost:5173" });
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(r.headers.get("vary"), "Origin");
    r = await t.get("/api/v1/health", { Origin: "http://127.0.0.1:3000" });
    assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
    r = await t.get("/api/v1/health", { Origin: "https://evil.example" });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    r = await t.get("/api/v1/health", { Origin: "http://localhost.evil.com" });
    assert.equal(r.headers.get("access-control-allow-origin"), null);

    r = await t.post("/api/v1/playlists", { name: "x" }, { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM playlists").get().n, 0);

    r = await t.call("OPTIONS", "/api/v1/playlists", undefined, { Origin: "http://localhost:5180", "Access-Control-Request-Method": "PATCH" });
    assert.equal(r.status, 204);
    assert.match(r.headers.get("access-control-allow-methods"), /PATCH/);
    r = await t.call("OPTIONS", "/api/v1/playlists", undefined, { Origin: "https://evil.example" });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally { await t.close(); }
});

test("body handling: invalid JSON, too large, wrong content type", async () => {
  const t = await startApp({ overrides: { bodyLimit: "1kb" } });
  try {
    let r = await t.post("/api/v1/playlists", "{not json");
    assert.equal(r.status, 400);
    assert.match(r.json.error, /JSON/);
    r = await t.post("/api/v1/playlists", { name: "x", description: "y".repeat(5000) });
    assert.equal(r.status, 413);
    r = await t.call("POST", "/api/v1/playlists", "name=x", { "content-type": "application/x-www-form-urlencoded" });
    assert.equal(r.status, 400);                                          // forms are not accepted
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM playlists").get().n, 0);
  } finally { await t.close(); }
});

test("rate limit per IP: 429 with Retry-After once the window budget is used", async () => {
  const t = await startApp({ overrides: { rate: { general: { max: 5, windowMs: 60000 }, heavy: { max: 2, windowMs: 60000 } } } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await t.get("/api/v1/health")).status, 200);
    const r = await t.get("/api/v1/health");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
  } finally { await t.close(); }
});

test("rateLimit(): window resets", () => {
  let now = 1000;
  const lim = rateLimit({ max: 2, windowMs: 100 }, () => now);
  const req = { socket: { remoteAddress: "1.2.3.4" } };
  const run = () => { let err = null; lim(req, { setHeader() {} }, (e) => { err = e || null; }); return err; };
  assert.equal(run(), null); assert.equal(run(), null);
  assert.equal(run().status, 429);
  now += 150;
  assert.equal(run(), null);
});

test("static UI: serves web assets, hides dot-files, scripts, docs and backups; no directory escape", async () => {
  const t = await startApp({ withUi: true });
  try {
    let r = await t.get("/");
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>ui<\/title>/);
    assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal((await t.get("/app.js")).status, 200);
    assert.equal((await t.get("/serve.ps1")).status, 404);
    assert.equal((await t.get("/README.md")).status, 404);
    assert.equal((await t.get("/_landing-backup/index.html")).status, 404);
    assert.equal((await t.get("/%2e%2e/%2e%2e/package.json")).status, 404);
    assert.equal((await t.get("/..%2f..%2fpackage.json")).status, 404);
    assert.equal((await t.call("POST", "/app.js", {})).status, 405);
  } finally { await t.close(); }
});

test("migrations are idempotent and create the expected tables", async () => {
  const cfg = loadConfig({}, {});
  const db = openDb(":memory:", cfg.sqlDir);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const n of ["users", "videos", "playlists", "playlist_videos", "watch_progress", "notes_jobs", "schema_migrations"]) assert.ok(names.includes(n), n);
  assert.equal(db.prepare("SELECT name FROM users WHERE id = 1").get().name, "local");
  const { migrate } = await import("../src/db.js");
  migrate(db, cfg.sqlDir);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 1);
  // the "one live job per video" rule is enforced by the database itself
  db.prepare("INSERT INTO videos (id) VALUES ('aaaaaaaaaaa')").run();
  const ins = (s) => db.prepare("INSERT INTO notes_jobs (video_id, status, created_at, updated_at) VALUES ('aaaaaaaaaaa', ?, 'x', 'x')").run(s);
  ins("running");
  assert.throws(() => ins("done"), /UNIQUE/);
  ins("error"); ins("error");
  db.close();
});

test("config: default bind address and Python URL guard", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.equal(loadConfig({ PORT: "1234" }).port, 1234);
  assert.equal(loadConfig({}).port, 5180);
  assert.doesNotThrow(() => assertPyUrl("http://127.0.0.1:5055"));
  assert.doesNotThrow(() => assertPyUrl("http://localhost:5055"));
  assert.throws(() => assertPyUrl("http://example.com:5055"), /this machine/);
  assert.throws(() => assertPyUrl("file:///etc/passwd"), /http/);
  assert.doesNotThrow(() => assertPyUrl("http://example.com", true));
});
