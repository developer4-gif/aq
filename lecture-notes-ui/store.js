/* AQ Learning - playlist store (CRUD + persistence). No DOM code in here.

   Data model (localStorage key `aq.playlists.v1`, JSON array):
   Playlist = { id, name, description, created, updated, videos: [Video], source?: { type:"youtube", listId, url, importedAt } }
   Video   = { id (11-char YouTube id), title, channel, duration ("m:ss" | "h:mm:ss" | ""), added }
   Dates are ISO strings. Playlist ids are slugs matching PLAYLIST_ID_RE (used in the #/playlist/<id> route).

   If localStorage is unavailable (or a write fails) the app keeps working in memory; AQ.store.storageOk() turns false. */
(function () {
  "use strict";

  var KEY = "aq.playlists.v1";
  var PLAYLIST_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var LIMITS = { name: 60, description: 160, title: 150, channel: 80 };
  var ID_RE = AQ.util.ID_RE;

  var playlists = [];
  var storageOk = true;
  var listeners = [];

  /* write-through to the aq-api backend (api.js, loaded after this file); a no-op when it is absent or unreachable */
  function remote(name) {
    var A = window.AQ && AQ.api;
    if (A && A.record) { try { A.record(name, Array.prototype.slice.call(arguments, 1)); } catch (e) { /* the local copy is already saved */ } }
  }

  /* ---------- seed (first run only: when the key is absent) ---------- */
  function seedData() {
    var now = new Date().toISOString();
    function v(id, title, channel, duration) { return { id: id, title: title, channel: channel, duration: duration, added: now }; }
    function p(id, name, description, videos) { return { id: id, name: name, description: description, created: now, updated: now, videos: videos }; }
    return [
      p("data-science", "Data Science", "Math and intuition behind modern data work.", [
        v("WUvTyaaNkzM", "The essence of calculus", "3Blue1Brown", "17:05"),
        v("aircAruvnKk", "But what is a neural network? | Deep learning chapter 1", "3Blue1Brown", "18:26")
      ]),
      p("ai-agents", "AI & Agents", "LLMs, agents and how they are built.", [
        v("IqQFaj3oO0Q", "What is Harness Engineering?", "Piyush Garg", "14:07"),
        v("zjkBMFhNj_g", "Intro to Large Language Models", "Andrej Karpathy", "59:48"),
        v("kCc8FmEb1nY", "Let's build GPT: from scratch, in code, spelled out.", "Andrej Karpathy", "1:56:20")
      ]),
      p("programming", "Programming", "", [
        v("rfscVS0vtbw", "Learn Python - Full Course for Beginners", "freeCodeCamp.org", "4:26:52")
      ])
    ];
  }

  /* ---------- sanitising whatever comes out of storage ---------- */
  function str(x, max) { return typeof x === "string" ? x.slice(0, max) : ""; }
  function isoOr(x, fallback) { return typeof x === "string" && !isNaN(Date.parse(x)) ? x : fallback; }

  function cleanVideo(v) {
    if (!v || typeof v.id !== "string" || !ID_RE.test(v.id)) return null;
    var dur = AQ.util.normDuration(v.duration);
    return {
      id: v.id,
      title: str(v.title, LIMITS.title).trim() || "YouTube video " + v.id,
      channel: str(v.channel, LIMITS.channel).trim(),
      duration: dur,
      added: isoOr(v.added, new Date().toISOString())
    };
  }
  /* optional provenance of an imported playlist: { type:"youtube", listId, url, importedAt }.
     The url is rebuilt from the validated listId, so a tampered value can never become a link target. */
  var LIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
  function cleanSource(s) {
    if (!s || typeof s !== "object" || s.type !== "youtube" || typeof s.listId !== "string" || !LIST_ID_RE.test(s.listId)) return null;
    return { type: "youtube", listId: s.listId, url: "https://www.youtube.com/playlist?list=" + s.listId,
             importedAt: isoOr(s.importedAt, new Date().toISOString()) };
  }
  function cleanPlaylists(arr) {
    if (!Array.isArray(arr)) return [];
    var seenIds = {}, out = [];
    arr.forEach(function (p) {
      if (!p || typeof p.id !== "string" || !PLAYLIST_ID_RE.test(p.id) || seenIds[p.id]) return;
      var name = str(p.name, LIMITS.name).trim();
      if (!name) return;
      var seenVid = {}, vids = [];
      (Array.isArray(p.videos) ? p.videos : []).forEach(function (raw) {
        var v = cleanVideo(raw);
        if (v && !seenVid[v.id]) { seenVid[v.id] = 1; vids.push(v); }
      });
      var now = new Date().toISOString();
      seenIds[p.id] = 1;
      var clean = {
        id: p.id, name: name, description: str(p.description, LIMITS.description).trim(),
        created: isoOr(p.created, now), updated: isoOr(p.updated, now), videos: vids
      };
      var src = cleanSource(p.source);
      if (src) clean.source = src;
      out.push(clean);
    });
    return out;
  }

  /* ---------- persistence ---------- */
  function load() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { storageOk = false; }
    if (raw == null) {                 // key absent (or storage unreadable): first run -> seed
      playlists = seedData();
      if (storageOk) persist();
      return;
    }
    try { playlists = cleanPlaylists(JSON.parse(raw)); } catch (e) { playlists = []; }
  }
  function persist() {
    try { window.localStorage.setItem(KEY, JSON.stringify(playlists)); storageOk = true; return true; }
    catch (e) { storageOk = false; return false; }
  }
  function changed() { persist(); listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } }); }

  // another tab changed the data: reload and tell the UI
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    try { playlists = e.newValue == null ? [] : cleanPlaylists(JSON.parse(e.newValue)); } catch (err) { return; }
    listeners.slice().forEach(function (fn) { try { fn(); } catch (x) { /* ignore */ } });
  });

  /* ---------- queries ---------- */
  function all() { return playlists; }
  function get(id) { for (var i = 0; i < playlists.length; i++) if (playlists[i].id === id) return playlists[i]; return null; }
  function nameTaken(name, exceptId) {
    var n = String(name).trim().toLowerCase();
    return playlists.some(function (p) { return p.id !== exceptId && p.name.toLowerCase() === n; });
  }
  function indexOfVideo(p, vid) { for (var i = 0; i < p.videos.length; i++) if (p.videos[i].id === vid) return i; return -1; }

  /* ---------- playlist CRUD ---------- */
  function newId(name) {
    var base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "playlist";
    var id = base, n = 1;
    while (get(id)) { n++; id = base + "-" + n; }
    return id;
  }
  /** Returns the new playlist, or null when the name is empty/too long/taken. */
  function create(name, description) {
    name = String(name || "").trim();
    if (!name || name.length > LIMITS.name || nameTaken(name)) return null;
    var now = new Date().toISOString();
    var p = { id: newId(name), name: name, description: String(description || "").trim().slice(0, LIMITS.description), created: now, updated: now, videos: [] };
    playlists.push(p);
    changed();
    remote("create", p);
    return p;
  }
  /** Batch create: a playlist with all `videos` (cleaned, duplicates skipped) in ONE write.
      `source` (optional) = { type:"youtube", listId } is recorded as playlist.source.
      Returns { playlist, added, skipped }, or null when the name is empty/too long/taken. */
  function createWithVideos(name, description, videos, source) {
    name = String(name || "").trim();
    if (!name || name.length > LIMITS.name || nameTaken(name)) return null;
    var now = new Date().toISOString(), seen = {}, vids = [], skipped = 0;
    (Array.isArray(videos) ? videos : []).forEach(function (raw) {
      var v = cleanVideo(raw);
      if (!v || seen[v.id]) { skipped++; return; }
      seen[v.id] = 1; vids.push(v);
    });
    var p = { id: newId(name), name: name, description: String(description || "").trim().slice(0, LIMITS.description), created: now, updated: now, videos: vids };
    var src = cleanSource(source);
    if (src) p.source = src;
    playlists.push(p);
    changed();
    remote("create", p);
    return { playlist: p, added: vids.length, skipped: skipped };
  }
  function update(id, name, description) {
    var p = get(id);
    name = String(name || "").trim();
    if (!p || !name || name.length > LIMITS.name || nameTaken(name, id)) return false;
    p.name = name;
    p.description = String(description || "").trim().slice(0, LIMITS.description);
    p.updated = new Date().toISOString();
    changed();
    remote("update", id, p.name, p.description);
    return true;
  }
  function remove(id) {
    var i = playlists.indexOf(get(id));
    if (i < 0) return false;
    playlists.splice(i, 1);
    changed();
    remote("remove", id);
    return true;
  }

  /* ---------- videos ---------- */
  function touch(p) { p.updated = new Date().toISOString(); }
  /** Returns the stored video, or null (invalid id / duplicate in this playlist / unknown playlist). */
  function addVideo(pid, data, atIndex) {
    var p = get(pid), v = cleanVideo(data);
    if (!p || !v || indexOfVideo(p, v.id) >= 0) return null;
    var i = typeof atIndex === "number" ? Math.max(0, Math.min(atIndex, p.videos.length)) : p.videos.length;
    p.videos.splice(i, 0, v);
    touch(p); changed();
    remote("addVideo", pid, v, i === p.videos.length - 1 ? undefined : i);
    return v;
  }
  /** Batch add: appends every valid, non-duplicate video of `list` with ONE write.
      Returns { added, skipped } or null for an unknown playlist. */
  function addVideos(pid, list) {
    var p = get(pid);
    if (!p) return null;
    var added = 0, skipped = 0, addedList = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var v = cleanVideo(raw);
      if (!v || indexOfVideo(p, v.id) >= 0) { skipped++; return; }
      p.videos.push(v); added++; addedList.push(v);
    });
    if (added) { touch(p); changed(); remote("addVideos", pid, addedList); }
    return { added: added, skipped: skipped };
  }
  function removeVideo(pid, vid) {
    var p = get(pid); if (!p) return false;
    var i = indexOfVideo(p, vid); if (i < 0) return false;
    p.videos.splice(i, 1);
    touch(p); changed();
    remote("removeVideo", pid, vid);
    return true;
  }
  function updateVideo(pid, vid, patch) {
    var p = get(pid); if (!p) return false;
    var i = indexOfVideo(p, vid); if (i < 0) return false;
    var cur = p.videos[i];
    var next = cleanVideo({ id: cur.id, title: patch.title != null ? patch.title : cur.title,
      channel: patch.channel != null ? patch.channel : cur.channel,
      duration: patch.duration != null ? patch.duration : cur.duration, added: cur.added });
    p.videos[i] = next;
    touch(p); changed();
    remote("updateVideo", pid, vid, next);
    return true;
  }
  function moveVideo(pid, from, to) {
    var p = get(pid); if (!p) return false;
    if (from === to || from < 0 || to < 0 || from >= p.videos.length || to >= p.videos.length) return false;
    p.videos.splice(to, 0, p.videos.splice(from, 1)[0]);
    touch(p); changed();
    remote("moveVideo", pid, p.videos.map(function (x) { return x.id; }));
    return true;
  }

  function subscribe(fn) { listeners.push(fn); }

  /* ----- watch progress (A2): real playback position per video -----
     localStorage `aq.watch.v1` = { videoId: { pos, dur, done, updated } }   (seconds; done = >= 95% or ended)
     The old `aq.watched.v1` id list ("opened once") is discarded, not treated as finished. Memory is the source of truth,
     storage failures are swallowed. Progress is time-based: watched seconds / total seconds. */
  var WATCH_KEY = "aq.watch.v1", OLD_WATCHED_KEY = "aq.watched.v1", DONE_AT = 0.95;
  var watch = {};

  function num(x) { x = +x; return isFinite(x) && x > 0 ? x : 0; }
  function cleanWatch(obj) {
    var out = {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    Object.keys(obj).forEach(function (id) {
      var r = obj[id];
      if (!ID_RE.test(id) || !r || typeof r !== "object") return;
      var pos = num(r.pos);
      // "done" without any real position came from the old opened-counts-as-watched migration: not finished
      out[id] = { pos: pos, dur: num(r.dur), done: !!r.done && pos >= 1, updated: num(r.updated) || Date.now() };
    });
    return out;
  }
  function persistWatch() {
    try { window.localStorage.setItem(WATCH_KEY, JSON.stringify(watch)); return true; } catch (e) { return false; }
  }
  (function loadWatch() {
    try { watch = cleanWatch(JSON.parse(window.localStorage.getItem(WATCH_KEY) || "{}")); } catch (e) { watch = {}; }
    // the old `aq.watched.v1` list only meant "opened once", not "finished": drop it instead of marking videos done
    try { window.localStorage.removeItem(OLD_WATCHED_KEY); persistWatch(); } catch (e) { /* storage unavailable */ }
  })();

  window.addEventListener("storage", function (e) {
    if (e.key !== WATCH_KEY) return;
    try { watch = cleanWatch(JSON.parse(e.newValue || "{}")); } catch (err) { return; }
    emit();
  });
  function emit() { listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } }); }

  /** Listed duration (seconds) of a video id in any playlist, 0 if unknown. */
  function listedDur(id) {
    for (var i = 0; i < playlists.length; i++) {
      var k = indexOfVideo(playlists[i], id);
      if (k >= 0) { var s = AQ.util.parseDuration(playlists[i].videos[k].duration); if (s) return s; }
    }
    return 0;
  }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s : m + ":" + (s < 10 ? "0" : "") + s;
  }
  /** {pos, dur, done, pct (0-100 for this video), state: "new"|"partial"|"done", updated} - dur falls back to the listed duration. */
  function watchInfo(id, durHint) {
    var r = watch[id], dur = (r && r.dur) || num(durHint) || listedDur(id), pos = r ? r.pos : 0, done = !!(r && r.done);
    if (dur && pos > dur) pos = dur;
    var pct = done ? 100 : (dur ? Math.min(99, Math.floor(100 * pos / dur)) : 0);
    var state = done ? "done" : (pos >= 1 ? "partial" : "new");
    return { pos: done ? dur || pos : pos, dur: dur, done: done, pct: pct, state: state, updated: r ? r.updated : 0 };
  }
  /** Label for a video row's watch button: {label, icon, state, resumeAt} ("Play" / "Resume · 12:34" / "Replay"). */
  function watchLabel(id) {
    var w = watchInfo(id);
    if (w.state === "done") return { label: "Replay", icon: "play", state: "done", resumeAt: 0 };
    if (w.state === "partial") return { label: "Resume · " + clock(w.pos), icon: "play", state: "partial", resumeAt: Math.floor(w.pos) };
    return { label: "Play", icon: "play", state: "new", resumeAt: 0 };
  }
  /** Save playback. patch = {pos, dur, done, ended}. Persists silently; pass {notify:true} (or call notify()) to re-render the UI. */
  function watchSave(id, patch, opts) {
    if (typeof id !== "string" || !ID_RE.test(id) || !patch) return null;
    var r = watch[id] || (watch[id] = { pos: 0, dur: 0, done: false, updated: 0 });
    if (patch.dur != null && num(patch.dur) > 0) r.dur = num(patch.dur);
    if (patch.pos != null) r.pos = num(patch.pos);
    var dur = r.dur || listedDur(id);
    if (dur && r.pos > dur) r.pos = dur;
    if (patch.ended || patch.done || (dur && r.pos >= DONE_AT * dur && r.pos > 0)) {
      r.done = true;
      if (patch.ended && dur) r.pos = dur;
    } else if (r.done && patch.pos != null && r.pos >= 1 && dur && r.pos < DONE_AT * dur) {
      // re-watching a finished video (Replay) and stopping part-way: it becomes "Resume" again
      r.done = false;
    }
    r.updated = Date.now();
    persistWatch();
    remote("watch", id, r);
    if (opts && opts.notify) emit();
    return watchInfo(id);
  }
  /** Learn a video's real duration (seconds): fills it in where the listing has none. Silent unless opts.notify. */
  function learnDuration(id, sec, opts) {
    sec = Math.round(num(sec));
    if (!sec || !ID_RE.test(id)) return;
    var r = watch[id] || (watch[id] = { pos: 0, dur: 0, done: false, updated: Date.now() });
    r.dur = sec;
    var touched = false;
    playlists.forEach(function (p) {
      var k = indexOfVideo(p, id);
      if (k >= 0 && !AQ.util.parseDuration(p.videos[k].duration)) {
        p.videos[k].duration = AQ.util.normDuration(clock(sec)); touched = true;
        remote("updateVideo", p.id, id, p.videos[k]);
      }
    });
    persistWatch();
    remote("watch", id, r);
    if (touched) persist();
    if (opts && opts.notify) emit();
  }
  function markWatched(id) { watchSave(id, { done: true }, { notify: true }); }
  function isWatched(id) { return !!(watch[id] && watch[id].done); }

  function sumVideos(videos) {
    var seen = {}, w = 0, t = 0, done = 0, n = 0, unknown = 0;
    videos.forEach(function (v) {
      if (seen[v.id]) return; seen[v.id] = 1; n++;
      var i = watchInfo(v.id, AQ.util.parseDuration(v.duration));
      if (i.done) done++;
      if (i.dur > 0) { t += i.dur; w += i.done ? i.dur : Math.min(i.pos, i.dur); } else unknown++;
    });
    var pct;
    if (t > 0) { pct = Math.round(100 * w / t); if (pct >= 100 && w < t) pct = 99; if (pct < 1 && w > 0) pct = 1; }
    else pct = n ? Math.round(100 * done / n) : 0;      // no known durations at all: fall back to counting videos
    return { done: done, total: n, pct: pct, watchedSec: w, totalSec: t, unknown: unknown, timed: t > 0 };
  }
  /** Time-based progress of a playlist: {done (videos finished), total (videos), pct, watchedSec, totalSec, unknown, timed}. */
  function progress(p) { return sumVideos(p.videos); }
  /** Progress across all playlists (each unique video counted once). */
  function overall() {
    var all = [];
    playlists.forEach(function (p) { p.videos.forEach(function (v) { all.push(v); }); });
    return sumVideos(all);
  }
  /** "14 of 36 min" / "1 hr 2 min of 4 hr 30 min" for a progress object. */
  function progressTime(pr) {
    var h = AQ.util.humanDuration;
    if (!pr.totalSec) return "";
    var wTxt = pr.watchedSec < 30 ? "0 min" : h(pr.watchedSec);
    if (pr.totalSec < 3600 && pr.watchedSec < 3600) return wTxt.replace(/ min$/, "") + " of " + h(pr.totalSec);
    return wTxt + " of " + h(pr.totalSec) + (pr.unknown ? "+" : "");
  }

  /* ---------- sync with the aq-api backend (called by api.js) ---------- */
  /** Everything the server needs for a full import: the playlists and the watch records. */
  function exportState() { return { playlists: playlists, progress: watch }; }
  /** Adopt the server's playlists + progress (sanitised like anything read from storage). A newer local watch record wins. */
  function applyRemote(pls, prog) {
    var np = cleanPlaylists(pls), nw = cleanWatch(prog);
    Object.keys(watch).forEach(function (id) { if (!nw[id] || watch[id].updated > nw[id].updated) nw[id] = watch[id]; });
    var diff = JSON.stringify(np) !== JSON.stringify(playlists) || JSON.stringify(nw) !== JSON.stringify(watch);
    playlists = np; watch = nw;
    persist(); persistWatch();
    if (diff) emit();
  }

  load();

  AQ.store = {
    exportState: exportState, applyRemote: applyRemote,
    KEY: KEY, LIMITS: LIMITS, PLAYLIST_ID_RE: PLAYLIST_ID_RE,
    all: all, get: get, nameTaken: nameTaken, indexOfVideo: indexOfVideo,
    create: create, createWithVideos: createWithVideos, update: update, remove: remove,
    addVideo: addVideo, addVideos: addVideos, removeVideo: removeVideo, updateVideo: updateVideo, moveVideo: moveVideo,
    markWatched: markWatched, isWatched: isWatched, progress: progress, overall: overall, progressTime: progressTime,
    watchInfo: watchInfo, watchLabel: watchLabel, watchSave: watchSave, learnDuration: learnDuration, clock: clock,
    notify: function () { emit(); },
    subscribe: subscribe, storageOk: function () { return storageOk; }
  };
})();
