import express from "express";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./db.js";
import { createRepo } from "./repo.js";
import { createPyClient, assertPyUrl } from "./pyclient.js";
import { createNotesService } from "./notes-service.js";
import { HttpError } from "./http.js";
import { localAuth } from "./middleware/auth.js";
import { securityHeaders, hostGuard, cors, rateLimit } from "./middleware/security.js";
import { playlistRoutes } from "./routes/playlists.js";
import { progressRoutes } from "./routes/progress.js";
import { notesRoutes, fontRoutes } from "./routes/notes.js";
import { healthRoutes, meRoutes, importRoutes, syncRoutes } from "./routes/misc.js";

export const VERSION = "0.1.0";
const STATIC_OK = /\.(html|js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json|txt)$/i;

/** Builds the Express app. deps: { db?, authenticate?, fetchImpl?, clock? } (all optional; used for tests and the OAuth hook). */
export function createApp(config, deps = {}) {
  assertPyUrl(config.pyUrl, config.allowRemotePy);
  const db = deps.db || openDb(config.dbFile, config.sqlDir);
  const repo = createRepo(db);
  const py = createPyClient({ baseUrl: config.pyUrl, timeoutMs: config.notes.pyTimeoutMs, fetchImpl: deps.fetchImpl || fetch });
  const notes = createNotesService({ db, repo, py, config, clock: deps.clock || Date.now });
  const authenticate = deps.authenticate || localAuth;

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.locals.db = db; app.locals.repo = repo;

  app.use(securityHeaders);
  if (config.log) {
    app.use((req, res, next) => {              // method, path (no query string, no headers, no bodies), status, time
      const t = Date.now();
      res.on("finish", () => console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - t}ms`));
      next();
    });
  }
  app.use(hostGuard);
  app.use(cors);

  const general = rateLimit(config.rate.general, deps.clock);
  const heavy = rateLimit(config.rate.heavy, deps.clock);

  // ---- API ----
  const api = express.Router();
  api.use(general);
  api.use(healthRoutes({ db, py, version: VERSION }));      // health needs no user
  api.use(authenticate);
  api.use(meRoutes(repo));
  api.use(syncRoutes(repo));                                      // own (bigger) JSON parser, must come first
  api.use(express.json({ limit: config.bodyLimit }));
  api.use(playlistRoutes(repo));
  api.use(progressRoutes(repo));
  api.use(notesRoutes(notes, heavy));
  api.use(importRoutes(py, config, heavy));
  api.use((_req, _res, next) => next(new HttpError(404, "Not found.")));
  app.use("/api/v1", api);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

  // fonts used by the generated notes page (served from the Python service)
  app.use(fontRoutes(py));

  // ---- the UI, same origin as the API ----
  if (config.uiDir && fs.existsSync(config.uiDir)) {
    const uiDir = path.resolve(config.uiDir);
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next(new HttpError(405, "Method not allowed."));
      const p = req.path === "/" ? "/index.html" : req.path;
      // only web assets, never dot-files, backups (_landing-backup), scripts or docs
      if (p.split("/").some((s) => s.startsWith(".") || s.startsWith("_")) || !STATIC_OK.test(p)) return next(new HttpError(404, "Not found."));
      next();
    });
    app.use(express.static(uiDir, { index: "index.html", dotfiles: "ignore", etag: true, maxAge: 0, redirect: false, fallthrough: true }));
  }
  app.use((_req, _res, next) => next(new HttpError(404, "Not found.")));

  // ---- errors: always JSON, never a stack trace ----
  app.use((err, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    let status = err.status || err.statusCode || 500;
    let message = err.expose ? err.message : "Something went wrong.";
    if (err.type === "entity.parse.failed") { status = 400; message = "The request body is not valid JSON."; }
    else if (err.type === "entity.too.large") { status = 413; message = "The request body is too large."; }
    else if (/SQLITE_CONSTRAINT/.test(String(err.code || err.message))) { status = 409; message = "That conflicts with existing data."; }
    else if (status >= 500 && !err.expose) console.error(`${req.method} ${req.path} failed: ${err.name}: ${String(err.message).slice(0, 200)}`);
    if (status < 400 || status > 599) status = 500;
    if (err.retryAfter) res.setHeader("Retry-After", String(err.retryAfter));
    res.status(status).json({ error: message, ...(err.code === "py_offline" || err.code === "not_in_playlist" ? { code: err.code } : {}) });
  });

  return app;
}
