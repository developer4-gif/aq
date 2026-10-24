import { Router } from "express";
import { Readable } from "node:stream";
import { videoId } from "../validate.js";

/** Streams a Python response (file) to the client with a small header allow-list. */
async function pipeFile(res, upstream, names) {
  res.status(upstream.status);
  for (const n of names) { const v = upstream.headers.get(n); if (v) res.setHeader(n, v); }
  if (!upstream.body) return res.end();
  const src = Readable.fromWeb(upstream.body);
  src.on("error", () => res.destroy());
  res.on("close", () => src.destroy());
  src.pipe(res);
}

export function notesRoutes(notes, heavyLimiter) {
  const r = Router();
  r.get("/notes", (_req, res) => res.json({ notes: notes.list() }));
  r.get("/notes/:videoId", async (req, res) => res.json(await notes.status(videoId(req.params.videoId))));
  r.post("/notes/:videoId", heavyLimiter, async (req, res) => {
    const out = await notes.start(req.user, videoId(req.params.videoId));
    res.status(out.started ? 202 : 200).json(out.status);
  });
  r.get("/notes/:videoId/html", async (req, res) => {
    const up = await notes.file(videoId(req.params.videoId), "html");
    // Python's own CSP allows exactly the inline scripts in the generated page (by hash) - pass it through
    await pipeFile(res, up, ["content-type", "content-security-policy", "content-length"]);
  });
  r.get("/notes/:videoId/pdf", async (req, res) => {
    const up = await notes.file(videoId(req.params.videoId), "pdf");
    await pipeFile(res, up, ["content-type", "content-disposition", "content-length"]);
  });
  return r;
}

/** The notes page references /static/fonts/<file>; serve those from the Python service. */
export function fontRoutes(py) {
  const r = Router();
  r.get("/static/fonts/:file", async (req, res) => {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(req.params.file) || req.params.file.includes("..")) return res.status(404).end();
    const up = await py.raw(`/static/fonts/${req.params.file}`);
    if (!up.ok) { await up.body?.cancel(); return res.status(404).end(); }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await pipeFile(res, up, ["content-type", "content-length"]);
  });
  return r;
}
