import { Router } from "express";
import { bad } from "../http.js";
import { isObj, slug, videoId } from "../validate.js";

const body = (req) => {
  if (!isObj(req.body)) throw bad("Send a JSON object (Content-Type: application/json).");
  return req.body;
};

export function playlistRoutes(repo) {
  const r = Router();
  const uid = (req) => req.user.id;

  r.get("/playlists", (req, res) => {
    res.json({ playlists: repo.listPlaylists(uid(req), { withVideos: req.query.include === "videos" }) });
  });
  r.post("/playlists", (req, res) => {
    const out = repo.createPlaylist(uid(req), body(req));
    res.status(201).json(out);
  });
  r.get("/playlists/:id", (req, res) => res.json({ playlist: repo.getPlaylist(uid(req), slug(req.params.id)) }));
  r.patch("/playlists/:id", (req, res) => res.json({ playlist: repo.updatePlaylist(uid(req), slug(req.params.id), body(req)) }));
  r.delete("/playlists/:id", (req, res) => { repo.deletePlaylist(uid(req), slug(req.params.id)); res.status(204).end(); });

  // add one video ({id, title, channel, duration, position?}) or a batch ({videos: [...]})
  r.post("/playlists/:id/videos", (req, res) => {
    const b = body(req), id = slug(req.params.id);
    if (b.videos !== undefined) return res.json(repo.addVideos(uid(req), id, b.videos));
    res.status(201).json({ video: repo.addVideo(uid(req), id, b) });
  });
  // reorder: {order: [videoId, ...]} (all videos of the playlist, new order)
  r.put("/playlists/:id/videos/order", (req, res) => res.json({ playlist: repo.reorder(uid(req), slug(req.params.id), body(req).order) }));
  r.patch("/playlists/:id/videos/:videoId", (req, res) => {
    res.json({ video: repo.editVideo(uid(req), slug(req.params.id), videoId(req.params.videoId), body(req)) });
  });
  r.delete("/playlists/:id/videos/:videoId", (req, res) => {
    repo.removeVideo(uid(req), slug(req.params.id), videoId(req.params.videoId));
    res.status(204).end();
  });
  return r;
}
