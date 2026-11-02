import { Router } from "express";
import { slug } from "../validate.js";

export function smartRoutes(smart, heavyLimiter) {
  const r = Router();
  r.get("/playlists/:id/smart", async (req, res) => res.json(await smart.status(req.user, slug(req.params.id))));
  r.post("/playlists/:id/smart", heavyLimiter, async (req, res) => {
    const out = await smart.start(req.user, slug(req.params.id));
    res.status(out.started ? 202 : 200).json(out.status);
  });
  return r;
}
