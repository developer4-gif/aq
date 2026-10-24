import express, { Router } from "express";
import { HttpError } from "../http.js";
import { LIST_ID_RE } from "../validate.js";

export function healthRoutes({ db, py, version }) {
  const r = Router();
  r.get("/health", async (req, res) => {
    let dbOk = true;
    try { db.prepare("SELECT 1").get(); } catch { dbOk = false; }
    const out = { ok: dbOk, service: "aq-api", version, uptimeSec: Math.round(process.uptime()), db: dbOk ? "ok" : "error" };
    if (req.query.deep === "1") {
      try { const p = await py.json("/api/providers", { timeout: 2000 }); out.notesService = p.status === 200 ? "ok" : "error"; }
      catch { out.notesService = "offline"; }
    }
    res.status(dbOk ? 200 : 503).json(out);
  });
  return r;
}

export function meRoutes(repo) {
  const r = Router();
  r.get("/me", (req, res) => {
    const u = repo.getUser(req.user.id);
    res.json({ user: { id: u.id, name: u.name }, bootstrapped: !!u.bootstrapped_at });
  });
  return r;
}

export function importRoutes(py, config, heavyLimiter) {
  const r = Router();
  r.get("/import/youtube", heavyLimiter, async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (!url || url.length > 2048) throw new HttpError(400, "Paste a YouTube playlist link.");
    const m = /[?&]list=([A-Za-z0-9_-]{10,64})(?:[&#]|$)/.exec(url);
    if (!m || !LIST_ID_RE.test(m[1])) throw new HttpError(400, "That doesn't look like a playlist link (it should contain list=...).");
    // only the validated list id is forwarded, never the user's URL
    const canonical = "https://www.youtube.com/playlist?list=" + m[1];
    const out = await py.json("/api/playlist?url=" + encodeURIComponent(canonical), { timeout: config.notes.importTimeoutMs });
    if (out.status !== 200 || !out.json) {
      const msg = out.json && typeof out.json.error === "string" ? out.json.error.slice(0, 300) : `The notes service could not read that playlist (status ${out.status}).`;
      throw new HttpError(out.status >= 400 && out.status < 500 && out.status !== 404 ? 422 : 502, msg);
    }
    res.json(out.json);
  });
  return r;
}

/** One-time / recovery import of the browser's data. Bigger body limit than the rest of the API. */
export function syncRoutes(repo) {
  const r = Router();
  r.post("/sync/import", express.json({ limit: "2mb" }), (req, res) => {
    res.json(repo.importState(req.user.id, req.body));
  });
  return r;
}
