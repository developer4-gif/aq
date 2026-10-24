/* Data access for playlists, playlist videos, watch progress and users.
   Every function takes the owning userId and only ever touches that user's rows. All SQL is parameterized. */
import { tx } from "./db.js";
import { bad, conflict, notFound } from "./http.js";
import * as v from "./validate.js";

const nowIso = () => new Date().toISOString();

export function createRepo(db) {
  /* ---------- users ---------- */
  const getUser = (id) => db.prepare("SELECT id, name, email, external_id, bootstrapped_at FROM users WHERE id = ?").get(id) || null;

  /** For the OAuth integration: find or create the user for an external subject. */
  function upsertExternalUser(externalId, name, email) {
    const row = db.prepare("SELECT id FROM users WHERE external_id = ?").get(externalId);
    if (row) {
      db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name, email ?? null, row.id);
      return row.id;
    }
    return Number(db.prepare("INSERT INTO users (external_id, name, email) VALUES (?, ?, ?)").run(externalId, name, email ?? null).lastInsertRowid);
  }

  /* ---------- helpers ---------- */
  function ensureVideo(vid) {
    db.prepare("INSERT OR IGNORE INTO videos (id, title, channel, duration_sec) VALUES (?, ?, ?, ?)").run(vid.id, vid.title || "", vid.channel || "", vid.durationSec || 0);
  }
  function plRow(userId, slug) {
    return db.prepare("SELECT * FROM playlists WHERE user_id = ? AND slug = ?").get(userId, slug) || null;
  }
  function mustPl(userId, slug) {
    const p = plRow(userId, slug);
    if (!p) throw notFound("Playlist not found.");
    return p;
  }
  const videoOut = (r) => ({
    id: r.video_id, title: r.title, channel: r.channel, durationSec: r.duration_sec, duration: v.clock(r.duration_sec),
    added: r.added_at, position: r.position
  });
  function videosOf(pk) {
    return db.prepare("SELECT * FROM playlist_videos WHERE playlist_pk = ? ORDER BY position").all(pk).map(videoOut);
  }
  function plOut(p, videos) {
    const out = {
      id: p.slug, name: p.name, description: p.description, created: p.created_at, updated: p.updated_at,
      videoCount: 0, durationSec: 0
    };
    if (p.source_list_id) {
      out.source = { type: "youtube", listId: p.source_list_id, url: "https://www.youtube.com/playlist?list=" + p.source_list_id, importedAt: p.source_imported_at };
    }
    if (videos) {
      out.videoCount = videos.length;
      out.durationSec = videos.reduce((s, x) => s + x.durationSec, 0);
      out.videos = videos;
    } else {
      const c = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(duration_sec), 0) AS d FROM playlist_videos WHERE playlist_pk = ?").get(p.pk);
      out.videoCount = Number(c.n); out.durationSec = Number(c.d);
    }
    return out;
  }
  function nameTaken(userId, name, exceptPk = 0) {
    return !!db.prepare("SELECT 1 FROM playlists WHERE user_id = ? AND name = ? COLLATE NOCASE AND pk <> ?").get(userId, name, exceptPk);
  }
  function freeSlug(userId, base) {
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "playlist";
    let id = base, n = 1;
    while (plRow(userId, id)) { n++; id = `${base}-${n}`; }
    return id;
  }
  const touch = (pk) => db.prepare("UPDATE playlists SET updated_at = ? WHERE pk = ?").run(nowIso(), pk);

  /** Appends clean videos (skipping ones already in the playlist) at the end (or at `at`). Returns {added, skipped}. */
  function appendVideos(pk, list, at) {
    let count = Number(db.prepare("SELECT COUNT(*) AS n FROM playlist_videos WHERE playlist_pk = ?").get(pk).n);
    const have = new Set(db.prepare("SELECT video_id FROM playlist_videos WHERE playlist_pk = ?").all(pk).map((r) => r.video_id));
    const fresh = [];
    let skipped = 0;
    for (const x of list) { if (have.has(x.id)) { skipped++; continue; } have.add(x.id); fresh.push(x); }
    if (!fresh.length) return { added: 0, skipped };
    let pos = count;
    if (Number.isInteger(at) && at >= 0 && at < count) {
      db.prepare("UPDATE playlist_videos SET position = position + ? WHERE playlist_pk = ? AND position >= ?").run(fresh.length, pk, at);
      pos = at;
    }
    const ins = db.prepare("INSERT INTO playlist_videos (playlist_pk, video_id, position, title, channel, duration_sec, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const x of fresh) {
      ensureVideo(x);
      ins.run(pk, x.id, pos++, x.title, x.channel, x.durationSec, x.added || nowIso());
    }
    return { added: fresh.length, skipped };
  }

  /* ---------- playlists ---------- */
  function listPlaylists(userId, { withVideos = false } = {}) {
    return db.prepare("SELECT * FROM playlists WHERE user_id = ? ORDER BY pk").all(userId).map((p) => plOut(p, withVideos ? videosOf(p.pk) : null));
  }
  function getPlaylist(userId, slug) {
    const p = mustPl(userId, slug);
    return plOut(p, videosOf(p.pk));
  }

  /** body: {id?, name, description?, videos?, source?}. Returns {playlist, added, skipped}. */
  function createPlaylist(userId, body) {
    const nm = v.name(body.name), desc = v.description(body.description), src = v.source(body.source);
    if (body.videos != null && !Array.isArray(body.videos)) throw bad("videos must be a list.");
    if ((body.videos || []).length > v.LIMITS.batch) throw bad(`At most ${v.LIMITS.batch} videos per request.`);
    return tx(db, () => {
      if (nameTaken(userId, nm)) throw conflict("You already have a playlist with this name.");
      let slug;
      if (body.id != null) { slug = v.slug(body.id); if (plRow(userId, slug)) slug = freeSlug(userId, slug); }
      else slug = freeSlug(userId, nm);
      const t = nowIso();
      const pk = Number(db.prepare(
        "INSERT INTO playlists (user_id, slug, name, description, source_list_id, source_imported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(userId, slug, nm, desc, src ? src.listId : null, src ? (src.importedAt || t) : null, t, t).lastInsertRowid);
      let clean = [], skipped = 0;
      for (const raw of body.videos || []) { try { clean.push(v.videoInput(raw)); } catch { skipped++; } }
      const r = appendVideos(pk, clean, null);
      return { playlist: plOut(plRow(userId, slug), videosOf(pk)), added: r.added, skipped: skipped + r.skipped };
    });
  }

  function updatePlaylist(userId, slug, body) {
    return tx(db, () => {
      const p = mustPl(userId, slug);
      const nm = body.name !== undefined ? v.name(body.name) : p.name;
      const desc = body.description !== undefined ? v.description(body.description) : p.description;
      if (body.name === undefined && body.description === undefined) throw bad("Nothing to update (send name and/or description).");
      if (nm.toLowerCase() !== p.name.toLowerCase() && nameTaken(userId, nm, p.pk)) throw conflict("You already have a playlist with this name.");
      db.prepare("UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE pk = ?").run(nm, desc, nowIso(), p.pk);
      return plOut(plRow(userId, slug), videosOf(p.pk));
    });
  }

  function deletePlaylist(userId, slug) {
    const r = db.prepare("DELETE FROM playlists WHERE user_id = ? AND slug = ?").run(userId, slug);
    if (!r.changes) throw notFound("Playlist not found.");
  }

  /* ---------- playlist videos ---------- */
  /** One video (409 when already in the playlist) -> the stored video. */
  function addVideo(userId, slug, body) {
    const x = v.videoInput(body);
    const at = body.position === undefined ? null : body.position;
    if (at !== null && (!Number.isInteger(at) || at < 0)) throw bad("position must be a non-negative integer.");
    return tx(db, () => {
      const p = mustPl(userId, slug);
      const r = appendVideos(p.pk, [x], at);
      if (!r.added) throw conflict("This video is already in the playlist.");
      touch(p.pk);
      return videosOf(p.pk).find((q) => q.id === x.id);
    });
  }
  /** Batch: invalid entries and duplicates are skipped and counted. */
  function addVideos(userId, slug, list) {
    if (!Array.isArray(list)) throw bad("videos must be a list.");
    if (list.length > v.LIMITS.batch) throw bad(`At most ${v.LIMITS.batch} videos per request.`);
    return tx(db, () => {
      const p = mustPl(userId, slug);
      const clean = []; let skipped = 0;
      for (const raw of list) { try { clean.push(v.videoInput(raw)); } catch { skipped++; } }
      const r = appendVideos(p.pk, clean, null);
      if (r.added) touch(p.pk);
      return { added: r.added, skipped: skipped + r.skipped, playlist: plOut(plRow(userId, slug), null) };
    });
  }
  /** order = the playlist's video ids in the new order (must be exactly the current set). */
  function reorder(userId, slug, order) {
    if (!Array.isArray(order) || order.length > 5000) throw bad("order must be a list of video ids.");
    order.forEach(v.videoId);
    return tx(db, () => {
      const p = mustPl(userId, slug);
      const cur = db.prepare("SELECT video_id FROM playlist_videos WHERE playlist_pk = ?").all(p.pk).map((r) => r.video_id);
      if (order.length !== cur.length || new Set(order).size !== order.length || !order.every((id) => cur.includes(id))) {
        throw bad("order must list every video of the playlist exactly once.");
      }
      const up = db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?");
      order.forEach((id, i) => up.run(i, p.pk, id));
      touch(p.pk);
      return getPlaylist(userId, slug);
    });
  }
  function editVideo(userId, slug, vid, body) {
    v.videoId(vid);
    return tx(db, () => {
      const p = mustPl(userId, slug);
      const cur = db.prepare("SELECT * FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?").get(p.pk, vid);
      if (!cur) throw notFound("Video not in this playlist.");
      const title = body.title !== undefined ? (v.text(body.title).slice(0, v.LIMITS.title) || `YouTube video ${vid}`) : cur.title;
      const channel = body.channel !== undefined ? v.text(body.channel).slice(0, v.LIMITS.channel) : cur.channel;
      const dur = body.duration !== undefined || body.durationSec !== undefined ? v.durationSec(body.durationSec !== undefined ? body.durationSec : body.duration) : cur.duration_sec;
      db.prepare("UPDATE playlist_videos SET title = ?, channel = ?, duration_sec = ? WHERE playlist_pk = ? AND video_id = ?").run(title, channel, dur, p.pk, vid);
      if (body.position !== undefined) {
        if (!Number.isInteger(body.position) || body.position < 0) throw bad("position must be a non-negative integer.");
        const n = Number(db.prepare("SELECT COUNT(*) AS n FROM playlist_videos WHERE playlist_pk = ?").get(p.pk).n);
        const to = Math.min(body.position, n - 1), from = cur.position;
        if (to > from) db.prepare("UPDATE playlist_videos SET position = position - 1 WHERE playlist_pk = ? AND position > ? AND position <= ?").run(p.pk, from, to);
        else if (to < from) db.prepare("UPDATE playlist_videos SET position = position + 1 WHERE playlist_pk = ? AND position >= ? AND position < ?").run(p.pk, to, from);
        db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?").run(to, p.pk, vid);
      }
      touch(p.pk);
      return videosOf(p.pk).find((q) => q.id === vid);
    });
  }
  function removeVideo(userId, slug, vid) {
    v.videoId(vid);
    tx(db, () => {
      const p = mustPl(userId, slug);
      const cur = db.prepare("SELECT position FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?").get(p.pk, vid);
      if (!cur) throw notFound("Video not in this playlist.");
      db.prepare("DELETE FROM playlist_videos WHERE playlist_pk = ? AND video_id = ?").run(p.pk, vid);
      db.prepare("UPDATE playlist_videos SET position = position - 1 WHERE playlist_pk = ? AND position > ?").run(p.pk, cur.position);
      touch(p.pk);
    });
  }
  /** Is this video in any of the user's playlists? (permission check for starting notes) */
  function userHasVideo(userId, vid) {
    return !!db.prepare(
      "SELECT 1 FROM playlist_videos pv JOIN playlists p ON p.pk = pv.playlist_pk WHERE p.user_id = ? AND pv.video_id = ? LIMIT 1"
    ).get(userId, vid);
  }

  /* ---------- watch progress ---------- */
  const progOut = (r) => ({ pos: r.pos_sec, dur: r.dur_sec, done: !!r.done, updated: r.updated_ms });
  function getProgress(userId, vid) {
    const r = db.prepare("SELECT * FROM watch_progress WHERE user_id = ? AND video_id = ?").get(userId, vid);
    return r ? progOut(r) : null;
  }
  function allProgress(userId) {
    const out = {};
    for (const r of db.prepare("SELECT * FROM watch_progress WHERE user_id = ?").all(userId)) out[r.video_id] = progOut(r);
    return out;
  }
  /** body: {pos, dur, done, updated?}. An older `updated` than the stored one is ignored (returns the stored row, stale:true). */
  function putProgress(userId, vid, body) {
    v.videoId(vid);
    if (!v.isObj(body)) throw bad("Send a JSON object {pos, dur, done}.");
    const pos = v.nonNeg(body.pos ?? 0, "pos"), dur = v.nonNeg(body.dur ?? 0, "dur");
    if (body.done !== undefined && typeof body.done !== "boolean") throw bad("done must be true or false.");
    const t = Date.now();
    let updated = t;
    if (body.updated !== undefined) {
      if (!Number.isFinite(body.updated) || body.updated < 0) throw bad("updated must be epoch milliseconds.");
      updated = Math.min(Math.floor(body.updated), t + 60_000);
    }
    return tx(db, () => {
      const cur = db.prepare("SELECT * FROM watch_progress WHERE user_id = ? AND video_id = ?").get(userId, vid);
      if (cur && cur.updated_ms > updated) return { ...progOut(cur), stale: true };
      ensureVideo({ id: vid, title: "", channel: "", durationSec: Math.floor(dur) });
      db.prepare(
        `INSERT INTO watch_progress (user_id, video_id, pos_sec, dur_sec, done, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, video_id) DO UPDATE SET pos_sec = excluded.pos_sec, dur_sec = excluded.dur_sec, done = excluded.done, updated_ms = excluded.updated_ms`
      ).run(userId, vid, pos, dur, body.done ? 1 : 0, updated);
      return progOut(db.prepare("SELECT * FROM watch_progress WHERE user_id = ? AND video_id = ?").get(userId, vid));
    });
  }

  /* ---------- one-time import of the browser's localStorage data ---------- */
  /** body: {mode: "merge"|"replace", playlists: [...], progress: {videoId: {pos, dur, done, updated}}}.
      Lenient (invalid entries are dropped). "replace" also deletes server playlists that are not in the payload.
      Returns the full resulting state. */
  function importState(userId, body) {
    if (!v.isObj(body)) throw bad("Send a JSON object {playlists, progress}.");
    const mode = body.mode === "replace" ? "replace" : "merge";
    const pls = Array.isArray(body.playlists) ? body.playlists : [];
    if (pls.length > 200) throw bad("At most 200 playlists per import.");
    const prog = v.isObj(body.progress) ? body.progress : {};
    if (Object.keys(prog).length > 5000) throw bad("At most 5000 progress entries per import.");
    tx(db, () => {
      const keep = new Set();
      for (const raw of pls) {
        if (!v.isObj(raw) || typeof raw.id !== "string" || !v.SLUG_RE.test(raw.id)) continue;
        const nm = v.text(raw.name).slice(0, v.LIMITS.name);
        if (!nm) continue;
        const desc = v.text(raw.description).slice(0, v.LIMITS.description);
        let src = null; try { src = v.source(raw.source); } catch { /* ignore a bad source */ }
        const clean = []; const seen = new Set();
        for (const rv of (Array.isArray(raw.videos) ? raw.videos : []).slice(0, 1000)) {
          try { const x = v.videoInput(rv); if (!seen.has(x.id)) { seen.add(x.id); clean.push(x); } } catch { /* drop */ }
        }
        const t = nowIso(), created = v.isoOr(raw.created, t), updated = v.isoOr(raw.updated, t);
        let p = plRow(userId, raw.id), pk;
        let uname = nm;
        for (let i = 2; nameTaken(userId, uname, p ? p.pk : 0) && i < 1000; i++) uname = `${nm.slice(0, v.LIMITS.name - 6)} (${i})`;
        if (p) {
          pk = p.pk;
          db.prepare("UPDATE playlists SET name = ?, description = ?, source_list_id = ?, source_imported_at = ?, updated_at = ? WHERE pk = ?")
            .run(uname, desc, src ? src.listId : null, src ? (src.importedAt || t) : null, updated, pk);
          if (mode === "replace") db.prepare("DELETE FROM playlist_videos WHERE playlist_pk = ?").run(pk);
        } else {
          pk = Number(db.prepare(
            "INSERT INTO playlists (user_id, slug, name, description, source_list_id, source_imported_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(userId, raw.id, uname, desc, src ? src.listId : null, src ? (src.importedAt || t) : null, created, updated).lastInsertRowid);
        }
        appendVideos(pk, clean, null);
        if (mode === "replace" && clean.length) {      // keep the client's order
          const up = db.prepare("UPDATE playlist_videos SET position = ? WHERE playlist_pk = ? AND video_id = ?");
          clean.forEach((x, i) => up.run(i, pk, x.id));
        }
        keep.add(raw.id);
      }
      if (mode === "replace") {
        for (const r of db.prepare("SELECT slug FROM playlists WHERE user_id = ?").all(userId)) {
          if (!keep.has(r.slug)) db.prepare("DELETE FROM playlists WHERE user_id = ? AND slug = ?").run(userId, r.slug);
        }
      }
      for (const [vid, r] of Object.entries(prog)) {
        if (!v.VIDEO_ID_RE.test(vid) || !v.isObj(r)) continue;
        const pos = Number(r.pos), dur = Number(r.dur), upd = Number(r.updated) || Date.now();
        if (![pos, dur].every((n) => Number.isFinite(n) && n >= 0 && n <= 1e7)) continue;
        ensureVideo({ id: vid, title: "", channel: "", durationSec: Math.floor(dur) });
        db.prepare(
          `INSERT INTO watch_progress (user_id, video_id, pos_sec, dur_sec, done, updated_ms) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, video_id) DO UPDATE SET pos_sec = excluded.pos_sec, dur_sec = excluded.dur_sec, done = excluded.done, updated_ms = excluded.updated_ms
           WHERE excluded.updated_ms >= watch_progress.updated_ms`
        ).run(userId, vid, pos, dur, r.done ? 1 : 0, Math.min(Math.floor(upd), Date.now() + 60_000));
      }
      db.prepare("UPDATE users SET bootstrapped_at = ? WHERE id = ?").run(nowIso(), userId);
    });
    return { playlists: listPlaylists(userId, { withVideos: true }), progress: allProgress(userId) };
  }

  return {
    getUser, upsertExternalUser, ensureVideo,
    listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
    addVideo, addVideos, reorder, editVideo, removeVideo, userHasVideo,
    getProgress, allProgress, putProgress, importState
  };
}
