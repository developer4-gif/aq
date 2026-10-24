import { Router } from "express";
import { bad, notFound } from "../http.js";
import { isObj, videoId } from "../validate.js";

export function progressRoutes(repo) {
  const r = Router();
  r.get("/progress", (req, res) => res.json({ progress: repo.allProgress(req.user.id) }));
  r.get("/progress/:videoId", (req, res) => {
    const p = repo.getProgress(req.user.id, videoId(req.params.videoId));
    if (!p) throw notFound("No progress for this video.");
    res.json({ videoId: req.params.videoId, ...p });
  });
  r.put("/progress/:videoId", (req, res) => {
    if (!isObj(req.body)) throw bad("Send a JSON object {pos, dur, done}.");
    const p = repo.putProgress(req.user.id, videoId(req.params.videoId), req.body);
    res.json({ videoId: req.params.videoId, ...p });
  });
  return r;
}
