import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

export const VID = (n) => String(n).padStart(11, "a");      // valid 11-char ids: aaaaaaaaaa1 ...
export const JOB = (n) => String(n).padStart(32, "0");     // valid 32-hex job ids

function listen(server) {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
}

/** A tiny stand-in for the Python notes service. `py.state` can be changed by tests. */
export async function startMockPython() {
  const state = {
    jobsCreated: [], nextJob: 1, jobs: new Map(),       // jobId -> {status, pct}
    busy: false, rejectWith: null, playlistUrls: [], hits: { status: 0, html: 0 }
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    let m;
    if (req.method === "POST" && u.pathname === "/api/jobs") {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (state.busy) return json(429, { error: "busy" });
        if (state.rejectWith) return json(400, { error: state.rejectWith });
        const body = JSON.parse(b);
        const id = JOB(state.nextJob++);
        state.jobsCreated.push({ id, body });
        state.jobs.set(id, { status: "running", pct: 40 });
        json(202, { job_id: id });
      });
    } else if ((m = /^\/api\/jobs\/([a-f0-9]{32})$/.exec(u.pathname)) && req.method === "GET") {
      state.hits.status++;
      const j = state.jobs.get(m[1]);
      if (!j) return json(404, { error: "Job not found" });
      json(200, { status: j.status, pct: j.pct, stage: "x", message: "m", job_id: m[1], ...(j.error ? { error: j.error } : {}) });
    } else if ((m = /^\/api\/jobs\/([a-f0-9]{32})\/notes\.(html|pdf)$/.exec(u.pathname))) {
      if (m[2] === "html") state.hits.html++;
      const j = state.jobs.get(m[1]);
      if (!j || j.status !== "done") return json(404, { error: "File not found." });
      if (m[2] === "html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" });
        res.end(req.method === "HEAD" ? undefined : "<h1>notes</h1>");
      } else {
        res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="n.pdf"' });
        res.end(req.method === "HEAD" ? undefined : "%PDF-1.4 fake");
      }
    } else if (u.pathname === "/api/playlist") {
      state.playlistUrls.push(u.searchParams.get("url"));
      json(200, { id: "PLabcdefghij", title: "T", channel: "C", count: 1, videos: [{ id: VID(1), title: "v", channel: "C", duration_sec: 61 }], truncated: false, skipped: 0 });
    } else if (u.pathname === "/api/providers") {
      json(200, { providers: [] });
    } else if ((m = /^\/static\/fonts\/([A-Za-z0-9._-]+)$/.exec(u.pathname))) {
      res.writeHead(200, { "content-type": "font/woff2" }); res.end("font");
    } else json(404, { error: "nope" });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** Starts the real app on a random port with an in-memory database. */
export async function startApp({ py, overrides = {}, authenticate, clock, withUi = false } = {}) {
  let uiDir = "";
  if (withUi) {
    uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-ui-"));
    fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>ui</title>");
    fs.writeFileSync(path.join(uiDir, "app.js"), "//js");
    fs.writeFileSync(path.join(uiDir, "serve.ps1"), "secret");
    fs.writeFileSync(path.join(uiDir, "README.md"), "docs");
    fs.mkdirSync(path.join(uiDir, "_landing-backup"));
    fs.writeFileSync(path.join(uiDir, "_landing-backup", "index.html"), "old");
  }
  const config = loadConfig({}, {
    dbFile: ":memory:", log: false, uiDir, pyUrl: py ? py.url : "http://127.0.0.1:9",
    notes: { pollMinMs: 0, verifyMs: 0, pyTimeoutMs: 2000, importTimeoutMs: 2000 },
    rate: { general: { max: 100000, windowMs: 60000 }, heavy: { max: 100000, windowMs: 60000 } },
    ...overrides
  });
  const app = createApp(config, { authenticate, clock });
  const server = http.createServer(app);
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
    });
    const txt = await res.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* not json */ }
    return { status: res.status, json, text: txt, headers: res.headers };
  }
  return {
    base, app, db: app.locals.db, repo: app.locals.repo, config, call,
    get: (p, h) => call("GET", p, undefined, h), post: (p, b, h) => call("POST", p, b, h),
    put: (p, b, h) => call("PUT", p, b, h), patch: (p, b, h) => call("PATCH", p, b, h), del: (p, h) => call("DELETE", p, undefined, h),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => { try { app.locals.db.close(); } catch { /* closed */ } if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); r(); }); })
  };
}
