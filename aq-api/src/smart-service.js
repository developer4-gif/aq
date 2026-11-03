/* Smart playlist runs: arrangement + topics to cover. The Python service does the AI work (POST /api/smart, GET /api/smart/<id>);
   this service remembers each run per playlist and stores the finished result in SQLite.

   - fingerprint = sha256(goal + sorted video ids). A queued / running / ready run with the same fingerprint is returned instead of a new one.
   - Python job ids are lost when the Python process restarts: a 404 from it turns a queued/running run into an error ("interrupted").
   - A ready run is complete in the database and never asks Python again. A failed run never blocks a new start. */
import { createHash } from "node:crypto";
import { HttpError } from "./http.js";
import { JOB_ID_RE, isObj } from "./validate.js";

const PUBLIC_STATE = { queued: "queued", running: "running", done: "ready", error: "error" };
const MIN_VIDEOS = 2, MAX_VIDEOS = 20;
const MAX_RESULT_CHARS = 512 * 1024, MAX_USAGE_CHARS = 8 * 1024;
const INTERRUPTED = "The analysis was interrupted - run it again";
const nowIso = () => new Date().toISOString();
const short = (s, n = 300) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

export const fingerprintOf = (goal, ids) => createHash("sha256").update(JSON.stringify([goal, [...ids].sort()])).digest("hex");

export function createSmartService({ db, repo, py, config, clock = Date.now, onChange = null }) {
  const slugOf = (pk) => (db.prepare("SELECT slug FROM playlists WHERE pk = ?").get(pk) || {}).slug ?? null;
  const N = config.notes;
  const locks = new Map();           // playlist pk -> promise chain

  const byId = (id) => db.prepare("SELECT * FROM smart_runs WHERE id = ?").get(id);
  const latest = (pk) => db.prepare("SELECT * FROM smart_runs WHERE playlist_pk = ? ORDER BY id DESC LIMIT 1").get(pk) || null;
  const live = (pk, fp) => db.prepare("SELECT * FROM smart_runs WHERE playlist_pk = ? AND fingerprint = ? AND status IN ('queued','running','done')").get(pk, fp) || null;

  /** The user's playlist (404 when it is not theirs) with its pk and the fingerprint of its goal + videos right now. */
  function playlistOf(user, slug) {
    const playlist = repo.getPlaylist(user.id, slug);
    const { pk } = db.prepare("SELECT pk FROM playlists WHERE user_id = ? AND slug = ?").get(user.id, slug);
    return { pk, playlist, fingerprint: fingerprintOf(playlist.name, playlist.videos.map((v) => v.id)) };
  }

  function setRow(id, f) {
    const keys = Object.keys(f);
    const before = onChange && byId(id);
    db.prepare(`UPDATE smart_runs SET ${keys.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), nowIso(), id);
    if (onChange) { const after = byId(id); onChange("smart", { playlistId: slugOf(after.playlist_pk) }, before, after); }
  }
  const fail = (row, msg) => setRow(row.id, { status: "error", error: short(msg), message: short(msg, 160), checked_at: clock() });

  /** Public state: {state, pct, stage, message, error, fingerprint, current, generatedAt, provider, model, result?, usage?}. */
  function pub(row, currentFp, extra = {}) {
    if (!row) return { state: "none", pct: 0, stage: "", message: "", error: "", fingerprint: "", current: false, generatedAt: null, provider: "", model: "", ...extra };
    const state = PUBLIC_STATE[row.status];
    const out = {
      state, pct: state === "ready" ? 100 : row.pct, stage: row.stage, message: row.message, error: row.error,
      fingerprint: row.fingerprint, current: row.fingerprint === currentFp,
      generatedAt: state === "ready" ? row.updated_at : row.created_at, provider: row.provider, model: row.model, ...extra
    };
    if (state === "ready") {
      try { out.result = JSON.parse(row.result_json); out.usage = JSON.parse(row.usage_json || "{}"); }
      catch { return { ...out, state: "error", error: "The stored result is unreadable - run it again." }; }
    }
    return out;
  }

  /** Ask Python how a queued/running run is doing (throttled). Network trouble keeps the record as it is. */
  async function refresh(row) {
    if (row.status !== "queued" && row.status !== "running") return row;
    if (clock() - row.checked_at < N.pollMinMs) return row;
    let r;
    try { r = await py.json(`/api/smart/${row.job_id}`); } catch { return row; }
    if (r.status === 404) { fail(row, INTERRUPTED); return byId(row.id); }
    if (r.status !== 200 || !r.json) return row;
    const d = r.json;
    if (d.status === "done") {
      const result = JSON.stringify(d.result ?? null), usage = JSON.stringify(isObj(d.usage) ? d.usage : {});
      if (!isObj(d.result)) fail(row, "The analysis finished without a result.");
      else if (result.length > MAX_RESULT_CHARS || usage.length > MAX_USAGE_CHARS) fail(row, "The analysis result is too large to store.");
      else setRow(row.id, { status: "done", pct: 100, stage: "", message: "Ready", error: "", result_json: result, usage_json: usage, model: short(d.model || row.model, 80), checked_at: clock() });
    } else if (d.status === "error") {
      fail(row, d.error || "The analysis engine reported an error.");
    } else {
      const pct = Number(d.pct);
      setRow(row.id, {
        status: d.status === "running" ? "running" : "queued",
        pct: Number.isFinite(pct) ? Math.max(row.pct, Math.min(100, Math.round(pct))) : row.pct,
        stage: short(d.stage, 20), message: short(d.message, 160), checked_at: clock()
      });
    }
    return byId(row.id);
  }

  /** The latest run of the user's playlist (refreshed from Python while it is queued/running). */
  async function status(user, slug) {
    const { pk, fingerprint } = playlistOf(user, slug);
    const row = latest(pk);
    return pub(row && await refresh(row), fingerprint);
  }

  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  /** Start a run for the playlist. -> {started: boolean, status}. `cached` is true when an identical run already exists. */
  function start(user, slug) {
    const { pk, playlist, fingerprint } = playlistOf(user, slug);
    const videos = playlist.videos;
    if (videos.length < MIN_VIDEOS || videos.length > MAX_VIDEOS) {
      throw new HttpError(422, `Smart arrange needs ${MIN_VIDEOS} to ${MAX_VIDEOS} videos in the playlist (this one has ${videos.length}).`);
    }
    return withLock(pk, async () => {
      const existing = live(pk, fingerprint);
      if (existing) {
        const row = await refresh(existing);
        if (row.status !== "error") return { started: false, status: pub(row, fingerprint, { cached: true }) };
      }
      const body = {
        goal: playlist.name,
        videos: videos.map((v) => ({ id: v.id, title: v.title, channel: v.channel, duration_sec: v.durationSec })),
        provider: config.pySmartProvider
      };
      if (config.pySmartModel) body.model = config.pySmartModel;
      const r = await py.json("/api/smart", { method: "POST", timeout: N.pyTimeoutMs, body });
      if (r.status === 429) throw new HttpError(429, "The analysis service is busy. Try again in a few seconds.", { retryAfter: 6 });
      if (r.status !== 202 || !r.json || !JOB_ID_RE.test(String(r.json.job_id || ""))) {
        const msg = short(r.json && r.json.error) || `The analysis service answered with status ${r.status}.`;
        throw new HttpError(r.status >= 400 && r.status < 500 && r.status !== 404 ? 422 : 502, msg);
      }
      const t = nowIso();
      const id = Number(db.prepare(
        "INSERT INTO smart_runs (playlist_pk, fingerprint, job_id, status, pct, message, provider, model, requested_by, created_at, updated_at, checked_at) VALUES (?, ?, ?, 'queued', 0, 'Queued...', ?, ?, ?, ?, ?, ?)"
      ).run(pk, fingerprint, r.json.job_id, config.pySmartProvider, short(config.pySmartModel, 80), user.id, t, t, clock()).lastInsertRowid);
      if (onChange) onChange("smart", { playlistId: slug }, null, byId(id));
      return { started: true, status: pub(byId(id), fingerprint) };
    });
  }

  return { status, start };
}
