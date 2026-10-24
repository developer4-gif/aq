import { bad } from "./http.js";

export const LIMITS = { name: 60, description: 160, title: 150, channel: 80, batch: 500, maxSec: 360000 };
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
export const JOB_ID_RE = /^[a-f0-9]{32}$/;

const CTRL = /[\u0000-\u001f\u007f]/g;
export const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Text without control characters, trimmed. Non-strings become "". */
export function text(x) { return typeof x === "string" ? x.replace(CTRL, " ").trim() : ""; }

export function videoId(x) {
  if (typeof x !== "string" || !VIDEO_ID_RE.test(x)) throw bad("Video id must be an 11-character YouTube id.");
  return x;
}
export function slug(x) {
  if (typeof x !== "string" || !SLUG_RE.test(x)) throw bad("Invalid playlist id.");
  return x;
}
export function name(x) {
  const n = text(x);
  if (!n) throw bad("Give the playlist a name.");
  if (n.length > LIMITS.name) throw bad(`Playlist name must be at most ${LIMITS.name} characters.`);
  return n;
}
export function description(x) {
  if (x == null) return "";
  if (typeof x !== "string") throw bad("Description must be text.");
  const d = text(x);
  if (d.length > LIMITS.description) throw bad(`Description must be at most ${LIMITS.description} characters.`);
  return d;
}

/** Seconds from a number or "m:ss" / "h:mm:ss" / "" (0 = unknown). Invalid input -> 0. */
export function durationSec(x) {
  if (typeof x === "number") return Number.isFinite(x) && x > 0 && x < LIMITS.maxSec ? Math.floor(x) : 0;
  if (typeof x !== "string") return 0;
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(x.trim());
  if (!m) return 0;
  const s = (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
  return s > 0 && s < LIMITS.maxSec ? s : 0;
}
/** "m:ss" / "h:mm:ss" ("" for 0) - the format the UI stores. */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? "0" : "") + n;
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function isoOr(x, fallback) { return typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : fallback; }

/** A video as sent by a client. Text is trimmed/truncated (oEmbed titles can be long). Throws on a bad id. */
export function videoInput(v) {
  if (!isObj(v)) throw bad("Each video must be an object.");
  const id = videoId(v.id);
  return {
    id,
    title: text(v.title).slice(0, LIMITS.title) || `YouTube video ${id}`,
    channel: text(v.channel).slice(0, LIMITS.channel),
    durationSec: durationSec(v.durationSec != null ? v.durationSec : v.duration),
    added: isoOr(v.added, null)
  };
}

export function source(s) {
  if (s == null) return null;
  if (!isObj(s) || s.type !== "youtube" || typeof s.listId !== "string" || !LIST_ID_RE.test(s.listId)) throw bad("Invalid playlist source.");
  return { listId: s.listId, importedAt: isoOr(s.importedAt, null) };
}

/** Finite number >= 0 and <= max, else a 400. */
export function nonNeg(x, label, max = 1e7) {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max) throw bad(`${label} must be a number between 0 and ${max}.`);
  return x;
}
