/* AQ Learning - notes jobs manager for the Lecture Notes AI server (http://127.0.0.1:5055).

   AQ.notesJobs (the shared brain; rows, the player and the notes button all read it):
     status(videoId)      -> {state:'none'|'queued'|'running'|'ready'|'error', pct:0-100, stage, message, jobId, error}
     start(video)         -> starts a job unless one is already queued / running / ready ({id,title})
     retry(videoId)       -> forget the old result and start again
     subscribe(fn)        -> fn(videoId, status) on every change; returns an unsubscribe function
     urls(videoId)        -> {html, pdf} (absolute URLs on the notes server) or null unless the notes are ready

   Jobs live in the server's memory (a restart loses them -> 404), so {videoId:{jobId,state}} is kept in localStorage
   (`aq.notes.v1`), queued / running jobs resume polling after a reload and ready ones are re-checked lazily.
   At most 2 jobs run at once (the server's limit); extra videos wait client-side and start as slots free up.

   AQ.notes.mount(container, video) - small panel used by the player dialog (button + download link). */
(function () {
  "use strict";
  var u = AQ.util, el = u.el;

  var API = "http://127.0.0.1:5055";
  var KEY = "aq.notes.v1";
  var JOB_RE = /^[a-f0-9]{32}$/;
  var MAX_RUNNING = 2;
  var POLL_MS = 1500;
  var BUSY_RETRY_MS = 6000;
  var STALE_MS = 40 * 60 * 1000;
  var OFFLINE_MSG = "Start the notes server (start.ps1)";
  var EXPIRED_MSG = "Notes expired — generate again";

  var entries = {};   // videoId -> {state, pct, stage, message, jobId, error, startedAt, needsCheck, polling, fails, video}
  var waiting = [];   // video ids waiting for a free slot (no server job yet)
  var listeners = [];
  var posting = 0;    // POSTs in flight
  var tickTimer = null;

  /* Server mode: when served by aq-api (AQ.api.available()), notes go through its /api/v1/notes/* endpoints. The server keeps
     one job per video for everybody and caches finished notes, so a video that is already "ready" comes back immediately.
     Otherwise (opened from another static server) the notes server on :5055 is called directly, as before. */
  function serverMode() { return !!(AQ.api && AQ.api.available && AQ.api.available()); }
  function nurl(id) { return AQ.api.base + "/api/v1/notes/" + id; }
  function readJson(res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); }

  /* ---------- persistence ---------- */
  function save() {
    try {
      var out = {};
      Object.keys(entries).forEach(function (id) {
        var e = entries[id];
        if (e.state === "ready" || e.state === "queued" || e.state === "running") out[id] = { jobId: e.jobId || null, state: e.state };
      });
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch (err) { /* storage blocked: keep working in memory */ }
  }
  function make(state, jobId) {
    return { state: state, pct: state === "ready" ? 100 : 0, stage: "", message: "", jobId: jobId || null, error: "",
             startedAt: Date.now(), needsCheck: false, polling: false, fails: 0, video: null };
  }
  function load() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (err) { o = {}; }
    Object.keys(o).forEach(function (id) {
      var r = o[id];
      if (!u.ID_RE.test(id) || !r || typeof r !== "object") return;
      var jobId = JOB_RE.test(String(r.jobId || "")) ? r.jobId : null;
      if (r.state === "ready" && jobId) { var e = make("ready", jobId); e.needsCheck = true; entries[id] = e; }
      else if (r.state === "queued" || r.state === "running") {
        if (jobId) { entries[id] = make("running", jobId); entries[id].message = "Resuming…"; }
        else { entries[id] = make("queued"); entries[id].message = "Waiting for a free slot…"; waiting.push(id); }
      }
    });
  }

  /* ---------- public reads ---------- */
  function snapshot(id) {
    var e = entries[id];
    if (!e) return { state: "none", pct: 0, stage: "", message: "", jobId: null, error: "" };
    return { state: e.state, pct: Math.max(0, Math.min(100, Math.round(e.pct || 0))), stage: e.stage || "",
             message: e.message || "", jobId: e.jobId, error: e.error || "" };
  }
  function status(id) {
    var e = entries[id];
    if (e && e.needsCheck) { e.needsCheck = false; validate(id); }
    return snapshot(id);
  }
  function urls(id) {
    var e = entries[id];
    if (!e || e.state !== "ready" || !e.jobId) return null;
    if (serverMode()) return { html: nurl(id) + "/html", pdf: nurl(id) + "/pdf" };
    var base = API + "/api/jobs/" + e.jobId;
    return { html: base + "/notes.html", pdf: base + "/notes.pdf" };
  }
  function subscribe(fn) {
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }
  function changed(id) {
    save();
    var s = snapshot(id);
    listeners.slice().forEach(function (fn) { try { fn(id, s); } catch (err) { /* a bad listener must not stop the others */ } });
  }

  /* ---------- starting ---------- */
  function start(video) {
    var id = video && video.id;
    if (!id || !u.ID_RE.test(id)) return;
    var e = entries[id];
    if (e && (e.state === "queued" || e.state === "running" || e.state === "ready")) return;   // no duplicates
    e = entries[id] = make("queued");
    e.video = video; e.message = "Waiting for a free slot…";
    if (waiting.indexOf(id) < 0) waiting.push(id);
    changed(id);
    pump();
  }
  function retry(id) {
    var e = entries[id], video = (e && e.video) || { id: id };
    removeWaiting(id);
    delete entries[id];
    start(video);
  }
  function removeWaiting(id) { var i = waiting.indexOf(id); if (i >= 0) waiting.splice(i, 1); }

  function serverActive() {
    var n = posting;
    Object.keys(entries).forEach(function (id) { var e = entries[id]; if (e.jobId && (e.state === "queued" || e.state === "running")) n++; });
    return n;
  }
  var apiSettled = true;   // false until api.js has decided between server mode and direct mode (see the end of this file)
  function pump() {
    if (!apiSettled) return;
    while (waiting.length && serverActive() < MAX_RUNNING) postJob(waiting.shift());
    if (waiting.length) ensureTick();
  }

  function postJob(id) {
    var e = entries[id];
    if (!e || e.state !== "queued") return;
    if (serverMode()) { postJobServer(id, e); return; }
    posting++;
    e.message = "Sending to the notes server…"; changed(id);
    fetch(API + "/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u.watchUrl(id), provider: "groq" })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (o) {
      posting--;
      if (entries[id] !== e) return;
      if (o.res.status === 429) {                       // server busy / rate limited: try again shortly
        e.message = "Waiting for a free slot…";
        waiting.push(id); changed(id);
        setTimeout(pump, BUSY_RETRY_MS);
        return;
      }
      if (!o.res.ok || !JOB_RE.test(String(o.data.job_id || ""))) {
        fail(id, String(o.data.error || ("The notes server answered with status " + o.res.status + ".")).slice(0, 300));
        return;
      }
      e.jobId = o.data.job_id; e.startedAt = Date.now(); e.message = "Queued…"; e.stage = "";
      changed(id);
      poll(id);
      ensureTick();
    }).catch(function () {
      posting--;
      if (entries[id] === e) fail(id, OFFLINE_MSG);
    });
  }

  /* a status object from /api/v1/notes/<id> -> the entry (ready / error / running); true when the entry is still in progress */
  function applyServerStatus(id, e, d) {
    if (d.state === "ready") { e.state = "ready"; e.pct = 100; e.stage = "pdf"; e.message = "Notes ready"; e.error = ""; e.jobId = JOB_RE.test(String(d.jobId || "")) ? d.jobId : (e.jobId || "server"); changed(id); pump(); return false; }
    if (d.state === "error") { fail(id, String(d.error || "The notes engine reported an error.").slice(0, 300)); return false; }
    if (d.state === "none") { expire(id, String(d.message || EXPIRED_MSG).slice(0, 160)); return false; }
    var pct = Number(d.pct);
    e.state = d.state === "running" ? "running" : "queued";
    e.jobId = JOB_RE.test(String(d.jobId || "")) ? d.jobId : (e.jobId || "server");
    if (isFinite(pct) && pct >= (e.pct || 0)) e.pct = Math.min(100, pct);
    e.stage = String(d.stage || "").slice(0, 20);
    e.message = String(d.message || "").slice(0, 160);
    changed(id);
    return true;
  }
  function postJobServer(id, e) {
    posting++;
    e.message = "Sending to the notes server…"; changed(id);
    AQ.api.flush().then(function () {                 // the video must already be in the user's playlists on the server
      return fetch(nurl(id), { method: "POST", cache: "no-store" });
    }).then(readJson).then(function (o) {
      posting--;
      if (entries[id] !== e) return;
      if (o.res.status === 429) {                     // server busy / rate limited: try again shortly
        e.message = "Waiting for a free slot…";
        waiting.push(id); changed(id);
        setTimeout(pump, BUSY_RETRY_MS);
        return;
      }
      if (!o.res.ok) { fail(id, String(o.data.error || ("The server answered with status " + o.res.status + ".")).slice(0, 300)); return; }
      e.startedAt = Date.now();
      if (applyServerStatus(id, e, o.data)) { poll(id); ensureTick(); }
    }).catch(function () {
      posting--;
      if (entries[id] === e) fail(id, OFFLINE_MSG);
    });
  }
  /* server mode: pick up notes that are already queued / running / ready on the server (made earlier or by another browser) */
  function hydrateFromServer() {
    return fetch(AQ.api.base + "/api/v1/notes", { cache: "no-store" }).then(readJson).then(function (o) {
      if (!o.res.ok || !Array.isArray(o.data.notes)) return;
      o.data.notes.forEach(function (d) {
        var id = d.videoId;
        if (!u.ID_RE.test(id) || (entries[id] && (entries[id].state === "queued" || entries[id].state === "running" || entries[id].state === "ready") && entries[id].jobId)) return;
        var e = make(d.state === "ready" ? "ready" : "running", JOB_RE.test(String(d.jobId || "")) ? d.jobId : "server");
        e.pct = d.state === "ready" ? 100 : Math.max(0, Math.min(100, Number(d.pct) || 0));
        e.message = d.state === "ready" ? "Notes ready" : String(d.message || "").slice(0, 160);
        if (d.state === "ready") e.needsCheck = true;
        entries[id] = e; removeWaiting(id);
        changed(id);
        if (d.state !== "ready") poll(id);
      });
      ensureTick();
    });
  }
  function pollServer(id, e) {
    var jobId = e.jobId;
    fetch(nurl(id), { cache: "no-store" }).then(readJson).then(function (o) {
      e.polling = false;
      if (entries[id] !== e || e.jobId !== jobId) return;
      e.fails = 0;
      if (!o.res.ok) { fail(id, String(o.data.error || "The server reported a problem.").slice(0, 300)); return; }
      applyServerStatus(id, e, o.data);
    }).catch(function () {
      e.polling = false;
      if (entries[id] !== e) return;
      if (++e.fails >= 3) fail(id, OFFLINE_MSG);
    });
  }

  function fail(id, msg) {
    var e = entries[id]; if (!e) return;
    removeWaiting(id);
    e.state = "error"; e.error = msg; e.message = msg; e.jobId = null; e.polling = false;
    changed(id);
    pump();
  }

  /* ---------- polling ---------- */
  function ensureTick() { if (!tickTimer) tickTimer = setTimeout(tick, POLL_MS); }
  function tick() {
    tickTimer = null;
    var again = waiting.length > 0;
    Object.keys(entries).forEach(function (id) {
      var e = entries[id];
      if (e.jobId && (e.state === "queued" || e.state === "running")) { again = true; if (!e.polling) poll(id); }
    });
    if (waiting.length) pump();
    if (again) ensureTick();
  }

  function poll(id) {
    var e = entries[id];
    if (!e || !e.jobId || e.polling) return;
    if (Date.now() - e.startedAt > STALE_MS) { fail(id, "This is taking too long. Please try again."); return; }
    e.polling = true;
    if (serverMode()) { pollServer(id, e); return; }
    var jobId = e.jobId;
    fetch(API + "/api/jobs/" + jobId, { cache: "no-store" }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) { return { res: res, d: d }; });
    }).then(function (o) {
      e.polling = false;
      if (entries[id] !== e || e.jobId !== jobId) return;
      e.fails = 0;
      if (o.res.status === 404) { expire(id, "The notes server restarted — generate again"); return; }
      if (!o.res.ok) { fail(id, String(o.d.error || "The notes server reported a problem.").slice(0, 300)); return; }
      var d = o.d;
      if (d.status === "done") {
        e.state = "ready"; e.pct = 100; e.stage = "pdf"; e.message = "Notes ready"; e.error = "";
        changed(id); pump(); return;
      }
      if (d.status === "error") { fail(id, String(d.error || "The notes engine reported an error.").slice(0, 300)); return; }
      var pct = Number(d.pct);
      e.state = d.status === "running" ? "running" : "queued";
      if (isFinite(pct) && pct >= (e.pct || 0)) e.pct = Math.min(100, pct);   // never move backwards
      e.stage = String(d.stage || "").slice(0, 20);
      e.message = String(d.message || "").slice(0, 160);
      changed(id);
    }).catch(function () {
      e.polling = false;
      if (entries[id] !== e) return;
      if (++e.fails >= 3) fail(id, OFFLINE_MSG);
    });
  }

  function expire(id, msg) {
    var e = entries[id]; if (!e) return;
    delete entries[id];
    removeWaiting(id);
    save();
    var n = make("none"); n.message = msg;
    entries[id] = n;                     // keeps the message for the tooltip; "none" is never persisted
    changed(id);
    pump();
  }

  /* a ready job from an earlier session: make sure the server still has it (404 -> expired) */
  function validate(id) {
    var e = entries[id];
    if (!e || !e.jobId) return;
    var jobId = e.jobId;
    if (serverMode()) {
      fetch(nurl(id), { cache: "no-store" }).then(readJson).then(function (o) {
        if (entries[id] === e && o.res.ok && o.data.state === "none") expire(id, EXPIRED_MSG);
      }).catch(function () { /* server down: keep it */ });
      return;
    }
    fetch(API + "/api/jobs/" + jobId, { cache: "no-store" }).then(function (res) {
      if (entries[id] !== e || e.jobId !== jobId) return;
      if (res.status === 404) expire(id, EXPIRED_MSG);
    }).catch(function () { /* server down: keep it, the links work again once it is back */ });
  }

  /* ---------- player dialog panel ---------- */
  function mount(box, video) {
    box.textContent = "";
    box.className = "notes";
    box.appendChild(el("p", null, "We send this lecture to your notes server and build a hand-drawn notes notebook. It usually takes a few minutes, and you can close this window while it works."));
    var row = el("div", "modal__row");
    var b = AQ.noteButton(video, { onView: function () { var l = urls(video.id); if (l) window.open(l.html, "_blank", "noopener"); } });
    row.appendChild(b);
    var pdf = el("a", "btn btn--ghost btn--sm", "Download PDF");
    pdf.target = "_blank"; pdf.rel = "noopener noreferrer"; pdf.hidden = true;
    row.appendChild(pdf);
    function sync() { var l = urls(video.id); pdf.hidden = !l; if (l) pdf.href = l.pdf; }
    var off = subscribe(function (id) { if (!box.isConnected) { off(); return; } if (id === video.id) sync(); });
    sync();
    box.appendChild(row);
  }

  load();
  AQ.notesJobs = { status: status, start: start, subscribe: subscribe, urls: urls, retry: retry };
  AQ.notes = { mount: mount };

  // resume anything that was in flight when the page was closed
  function resume() {
    Object.keys(entries).forEach(function (id) { if (entries[id].state === "running") poll(id); });
    if (waiting.length || Object.keys(entries).some(function (id) { return entries[id].state === "running"; })) { pump(); ensureTick(); }
  }
  if (!AQ.api || !AQ.api.ready) { resume(); }
  else {
    // wait until we know whether aq-api is there (it answers in well under a second on localhost, 1.5 s at most per probe)
    apiSettled = false;
    AQ.api.ready().then(function () {
      apiSettled = true;
      if (!serverMode()) { resume(); return; }
      // the server is the source of truth for jobs: forget the direct-mode job ids kept in localStorage
      Object.keys(entries).forEach(function (id) { var e = entries[id]; if (e.jobId && !e.video) { delete entries[id]; changed(id); } });
      hydrateFromServer().catch(function () { /* the buttons simply start from "Get notes" */ }).then(function () { pump(); ensureTick(); });
    });
  }
})();
