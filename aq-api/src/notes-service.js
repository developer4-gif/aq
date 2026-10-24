/* Notes records + cache. The Python service generates notes; this service remembers them per video_id.

   - One live job (queued / running / done) per video across all users (DB partial unique index + an in-process lock).
   - start(): a ready video returns immediately (cached); a running one returns its progress; otherwise a job is started in Python.
   - Python job ids are lost when the Python process restarts: a 404 from it marks the record "expired" (a new job may be started). */
import { HttpError } from "./http.js";
import { JOB_ID_RE } from "./validate.js";

const PUBLIC_STATE = { queued: "queued", running: "running", done: "ready", error: "error", expired: "none" };
const nowIso = () => new Date().toISOString();
const short = (s, n = 300) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, n);

export function createNotesService({ db, repo, py, config, clock = Date.now }) {
  const N = config.notes;
  const locks = new Map();           // videoId -> promise chain

  const live = (videoId) => db.prepare("SELECT * FROM notes_jobs WHERE video_id = ? AND status IN ('queued','running','done')").get(videoId) || null;
  const last = (videoId) => db.prepare("SELECT * FROM notes_jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1").get(videoId) || null;
  const byId = (id) => db.prepare("SELECT * FROM notes_jobs WHERE id = ?").get(id);

  function pub(videoId, row, extra = {}) {
    if (!row) return { videoId, state: "none", pct: 0, stage: "", message: "", error: "", jobId: null, ...extra };
    const state = PUBLIC_STATE[row.status];
    return {
      videoId, state, pct: state === "ready" ? 100 : row.pct, stage: row.stage, message: row.message,
      error: row.error, jobId: row.status === "expired" ? null : row.job_id, ...extra
    };
  }
  function setRow(id, f) {
    const keys = Object.keys(f);
    db.prepare(`UPDATE notes_jobs SET ${keys.map((k) => k + " = ?").join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k]), nowIso(), id);
  }

  /** Ask Python how a queued/running job is doing (throttled). Network trouble keeps the record as it is. */
  async function refresh(row) {
    if (clock() - row.checked_at < N.pollMinMs) return row;
    let r;
    try { r = await py.json(`/api/jobs/${row.job_id}`); } catch { return row; }
    if (r.status === 404) { setRow(row.id, { status: "expired", message: "Notes expired - generate again", checked_at: clock() }); return byId(row.id); }
    if (r.status !== 200 || !r.json) return row;
    const d = r.json;
    if (d.status === "done") setRow(row.id, { status: "done", pct: 100, stage: "pdf", message: "Notes ready", error: "", checked_at: clock() });
    else if (d.status === "error") setRow(row.id, { status: "error", error: short(d.error || "The notes engine reported an error."), message: short(d.error || "Error"), checked_at: clock() });
    else {
      const pct = Number(d.pct);
      setRow(row.id, {
        status: d.status === "running" ? "running" : "queued",
        pct: Number.isFinite(pct) ? Math.max(row.pct, Math.min(100, Math.round(pct))) : row.pct,
        stage: short(d.stage, 20), message: short(d.message, 160), checked_at: clock()
      });
    }
    return byId(row.id);
  }

  /** A ready record: make sure Python still has the files (definitive 404 -> expired). Checked at most every verifyMs. */
  async function verify(row, force = false) {
    if (!force && clock() - row.checked_at < N.verifyMs) return row;
    try {
      const r = await py.raw(`/api/jobs/${row.job_id}/notes.html`, { method: "HEAD", timeout: N.pyTimeoutMs });
      await r.body?.cancel();
      if (r.status === 404) { setRow(row.id, { status: "expired", message: "Notes expired - generate again", checked_at: clock() }); return byId(row.id); }
      setRow(row.id, { checked_at: clock() });
      return byId(row.id);
    } catch { return row; }
  }

  async function current(videoId) {
    let row = live(videoId);
    if (!row) return null;
    if (row.status === "done") row = await verify(row);
    else row = await refresh(row);
    return row;
  }

  /** Status for the UI: {state: none|queued|running|ready|error, pct, stage, message, error, jobId}. */
  async function status(videoId) {
    const row = await current(videoId);
    if (row) return pub(videoId, row);
    const l = last(videoId);
    return pub(videoId, l && (l.status === "error" || l.status === "expired") ? l : null);
  }

  /** Every record that is queued / running / ready (database only, no calls to Python). */
  function list() {
    return db.prepare("SELECT * FROM notes_jobs WHERE status IN ('queued','running','done') ORDER BY id").all().map((r) => pub(r.video_id, r));
  }

  function withLock(videoId, fn) {
    const prev = locks.get(videoId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(videoId, tail);
    tail.then(() => { if (locks.get(videoId) === tail) locks.delete(videoId); });
    return run;
  }

  /** Start notes for a video. -> {started: boolean, status}. `cached` is true when nothing new was started. */
  function start(user, videoId) {
    if (config.requireMembership && !repo.userHasVideo(user.id, videoId)) {
      return Promise.reject(new HttpError(403, "Add this video to one of your playlists first.", { code: "not_in_playlist" }));
    }
    return withLock(videoId, async () => {
      const existing = await current(videoId);
      if (existing && existing.status !== "expired" && existing.status !== "error") {
        return { started: false, status: pub(videoId, existing, { cached: true }) };
      }
      const r = await py.json("/api/jobs", {
        method: "POST", timeout: N.pyTimeoutMs,
        body: { url: "https://www.youtube.com/watch?v=" + videoId, provider: config.pyProvider }
      });
      if (r.status === 429) throw new HttpError(429, "The notes service is busy. Try again in a few seconds.", { retryAfter: 6 });
      if (r.status !== 202 || !r.json || !JOB_ID_RE.test(String(r.json.job_id || ""))) {
        const msg = short(r.json && r.json.error) || `The notes service answered with status ${r.status}.`;
        throw new HttpError(r.status >= 400 && r.status < 500 && r.status !== 404 ? 422 : 502, msg);
      }
      repo.ensureVideo({ id: videoId, title: "", channel: "", durationSec: 0 });
      const t = nowIso();
      const id = Number(db.prepare(
        "INSERT INTO notes_jobs (video_id, job_id, status, pct, message, requested_by, created_at, updated_at, checked_at) VALUES (?, ?, 'queued', 0, 'Queued...', ?, ?, ?, ?)"
      ).run(videoId, r.json.job_id, user.id, t, t, clock()).lastInsertRowid);
      return { started: true, status: pub(videoId, byId(id)) };
    });
  }

  /** The finished file for a video: a Response from Python to stream through. Throws 404 when there is none. */
  async function file(videoId, kind) {
    const row = live(videoId);
    if (!row || row.status !== "done") throw new HttpError(404, "Notes are not ready for this video.");
    const res = await py.raw(`/api/jobs/${row.job_id}/notes.${kind}`);
    if (res.status === 404) {
      await res.body?.cancel();
      setRow(row.id, { status: "expired", message: "Notes expired - generate again", checked_at: clock() });
      throw new HttpError(404, "These notes expired. Generate them again.");
    }
    if (!res.ok) { await res.body?.cancel(); throw new HttpError(502, "The notes service could not provide the file."); }
    return res;
  }

  return { status, list, start, file };
}
