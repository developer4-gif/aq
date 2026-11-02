/* AQ Learning - smart playlist: the "Smart arrange" button + the learning-path panel on the playlist detail screen.

   The playlist name is the learning goal, its videos are what is already covered. One run (aq-api, which asks the Python worker)
   orders the videos, finds the missing topics and suggests real YouTube videos for them. Contract: lecture-notes-ai/docs/smart-playlist-contract.md
     POST /api/v1/playlists/<id>/smart   start (200 cached / 202 started)
     GET  /api/v1/playlists/<id>/smart   latest run: { state: none|queued|running|ready|error, pct, stage, error, current, generatedAt, result, usage }

   API (used by app.js):
     AQ.smart.init({ toast, announce })   the page's toast + live-region helpers (kept private in app.js)
     AQ.smart.button(playlist)            -> liquid-glass <button class="wbtn smart-wbtn"> (smartmagic.js; click = start a run + the 3 s charge / burst / row glide)
     AQ.smart.panel(playlist)             -> <div class="smart"> placeholder (empty, display:none; only a hint note in rare cases). The learning path
                                             itself lives in a RIGHT-SIDE DRAWER (one per page, in <body>) with a slim handle on the right edge: waiting
                                             skeleton while running, error + Retry, or the topics. Closed on page load; it opens by itself when a run the
                                             user just started finishes. On wide screens the page content shrinks to make room, below 1024px it is an overlay.

   Run state lives at module level (per playlist id), NOT in the DOM, so render() may rebuild the page at any time without losing a
   running poll or starting a second one. The button and panel register as views and are repainted when the run changes; views that
   left the DOM are dropped. Polling stops when the user leaves the playlist (the server keeps the run; coming back reads it again).
   All server text is written with textContent (never innerHTML); YouTube ids are validated before any URL is built. */
(function () {
  "use strict";
  var AQ = window.AQ = window.AQ || {};
  var u = AQ.util, S = AQ.store, el = u.el, icon = u.icon;

  var POLL_MS = 1500, POLL_MAX_MS = 10 * 60 * 1000, FAIL_MAX = 3;
  var MIN_VIDEOS = 2, MAX_VIDEOS = 20;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var STAGES = { queued: "Waiting to start", transcripts: "Reading transcripts", profiling: "Profiling videos", ordering: "Ordering",
                 gaps: "Finding gaps", checking: "Verifying", candidates: "Finding videos" };

  var runs = {};            // playlist id -> run record (see runOf)
  var prefs = {};           // playlist id -> { open, coveredOpen, focus } : small UI memory that survives a re-render (open = the side drawer)
  var hooks = { toast: function () {}, announce: function () {} };
  var lastPid = null;       // playlist currently on screen (to tell "same playlist, notes opened" from "left and came back")

  /* ---------- small helpers ---------- */
  function noop() {}
  function str(x, max) { return typeof x === "string" ? x.slice(0, max || 400) : ""; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function pageId() {
    var m = /^#\/playlist\/([a-z0-9-]{1,48})(?:\/notes\/[A-Za-z0-9_-]{11})?\/?$/.exec(location.hash || "");
    return m ? m[1] : null;
  }
  function sigOf(p) { return p ? p.videos.map(function (v) { return v.id; }).sort().join(",") : ""; }   // same idea as the server fingerprint (order does not matter)
  function available() { return !!(AQ.api && AQ.api.available && AQ.api.available()); }
  function prefsOf(pid) { return prefs[pid] || (prefs[pid] = { open: false, coveredOpen: false, focus: null }); }
  function runOf(pid) {
    return runs[pid] || (runs[pid] = {
      pid: pid, state: "none", pct: 0, stage: "", error: "", result: null, usage: null, current: true, generatedAt: "", provider: "", model: "",
      fetched: false, fetching: false, posting: false, polling: false, gen: 0, timer: 0, fails: 0, sig: "", failedAt: 0, pollStart: 0, views: [], apiWait: false
    });
  }
  function register(r, view) {
    r.views.push(view);
    if (r.views.length > 12) r.views = r.views.filter(function (v, i) { return v.el.isConnected || i >= r.views.length - 2; });   // old screens that were re-rendered away
  }
  function busy(r) { return r.posting || r.holding || r.state === "queued" || r.state === "running"; }     // holding = the magic sequence (smartmagic.js) has not revealed yet

  /** JSON request against aq-api (same base as api.js). Resolves {status, json}; rejects only on network failure / timeout. */
  function request(method, path, body) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch((AQ.api ? AQ.api.base : "") + path, {
      method: method, cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (j) { clearTimeout(timer); return { status: res.status, json: j }; });
    }, function (err) { clearTimeout(timer); throw err; });
  }
  function runPath(pid) { return "/api/v1/playlists/" + encodeURIComponent(pid) + "/smart"; }

  /** A calm sentence for a failed request - never raw server output. */
  function failText(res) {
    var s = res ? res.status : 0;
    if (s === 429) return "The server is busy with another analysis. Try again in a moment.";
    if (s === 404) return "This playlist is not on the server yet. Wait a moment and try again.";
    if (s === 422) {
      var m = res.json && typeof res.json.error === "string" ? res.json.error.slice(0, 160) : "";
      return m || "This playlist cannot be arranged yet. It needs between " + MIN_VIDEOS + " and " + MAX_VIDEOS + " videos.";
    }
    if (s === 503) return "The analysis engine is not available right now.";
    return "Smart arrange could not be started. Please try again.";
  }

  /* ---------- run state ---------- */
  function paintViews(r) {
    r.views = r.views.filter(function (v) {
      if (!v.el.isConnected) return false;
      try { v.update(); } catch (e) { if (window.console) console.error(e); }   // one broken view must not stop the others
      return true;
    });
  }

  /** Copy a GET payload into the run record. A "ready" payload without a usable result becomes an error. */
  function apply(r, j) {
    var st = j && typeof j.state === "string" ? j.state : "none";
    if (["none", "queued", "running", "ready", "error"].indexOf(st) < 0) st = "none";
    j = j || {};
    r.state = st;
    r.pct = Math.max(0, Math.min(100, Math.round(+j.pct) || 0));
    r.stage = str(j.stage, 20);
    r.error = str(j.error, 240);
    r.current = j.current !== false;
    r.generatedAt = str(j.generatedAt, 40);
    r.provider = str(j.provider, 40); r.model = str(j.model, 60);
    r.result = null; r.usage = null;
    if (st === "ready") {
      if (j.result && typeof j.result === "object") { r.result = j.result; r.usage = j.usage && typeof j.usage === "object" ? j.usage : null; }
      else { r.state = "error"; r.error = "The result could not be read."; }
    }
  }

  function stopPoll(r) {
    clearTimeout(r.timer); r.timer = 0;
    r.polling = false; r.gen++;                    // answers still in flight are ignored
  }
  function startPoll(r, first) {
    if (r.polling) return;
    r.polling = true; r.fails = 0; r.pollStart = Date.now();
    r.timer = setTimeout(function () { tick(r); }, first == null ? POLL_MS : first);
  }
  function wanted(r) {                             // is the user still looking at this playlist?
    return pageId() === r.pid && r.views.some(function (v) { return v.el.isConnected; });
  }
  function finished(r, wasRunning) {
    var held = r.holding;                          // a click started this run: smartmagic.js decides when the result is revealed
    if (held) AQ.smartmagic.finish(r.pid, r.state === "ready" && !!r.result);
    paintViews(r);
    if (held && r.state === "ready") return;       // announced by the reveal ("Videos arranged" / ...)
    if (wasRunning && r.state === "ready") hooks.announce("The learning path is ready.");
    else if (wasRunning && r.state === "error") hooks.announce("Smart arrange could not finish.");
  }
  function tick(r) {
    r.timer = 0;
    if (!r.polling) return;
    if (!wanted(r)) { stopPoll(r); return; }       // left the page / switched playlist: no leaked timers
    var gen = r.gen;
    request("GET", runPath(r.pid)).then(function (res) {
      if (!r.polling || gen !== r.gen) return;
      if (res.status === 200 && res.json) {
        r.fails = 0;
        apply(r, res.json);
        if (r.state === "queued" || r.state === "running") {
          if (Date.now() - r.pollStart > POLL_MAX_MS) { stopPoll(r); r.state = "error"; r.error = "This is taking longer than expected."; finished(r, true); return; }
          paintViews(r);
          r.timer = setTimeout(function () { tick(r); }, POLL_MS);
          return;
        }
        if (r.state === "none" && Date.now() - r.pollStart < 15000) { r.state = "queued"; r.timer = setTimeout(function () { tick(r); }, POLL_MS); return; }   // POST just landed, the row is not visible yet
        stopPoll(r); finished(r, true);
        return;
      }
      throw new Error("poll " + res.status);
    }).catch(function () {
      if (!r.polling || gen !== r.gen) return;
      r.fails++;
      if (r.fails >= FAIL_MAX) { stopPoll(r); r.state = "error"; r.error = "Lost contact with the server."; finished(r, true); return; }
      r.timer = setTimeout(function () { tick(r); }, POLL_MS);
    });
  }

  /** Read the stored run (once per visit, and again when the playlist's videos changed) so the panel shows without a click. */
  function load(pid) {
    var r = runOf(pid), p = S.get(pid);
    if (!p) return;
    if (!available()) {                            // api.js may still be probing: look again once it settled
      if (!r.apiWait && AQ.api && AQ.api.ready) {
        r.apiWait = true;
        AQ.api.ready().then(function () { r.apiWait = false; paintViews(r); if (available()) load(pid); }, function () { r.apiWait = false; });
      }
      return;
    }
    var sig = sigOf(p);
    if (r.polling || r.posting || r.fetching) return;
    if (r.fetched && r.sig === sig) return;
    if (r.failedAt && Date.now() - r.failedAt < 8000) return;
    r.fetching = true;
    var gen = r.gen;
    request("GET", runPath(pid)).then(function (res) {
      r.fetching = false;
      if (gen !== r.gen) return;
      if (res.status === 200 && res.json) {
        apply(r, res.json); r.fetched = true; r.sig = sig; r.failedAt = 0;
        if (r.state === "queued" || r.state === "running") startPoll(r, POLL_MS);
        paintViews(r);
      } else if (res.status === 404) {
        apply(r, null); r.fetched = true; r.sig = sig; paintViews(r);
      } else r.failedAt = Date.now();              // stay quiet; the button still works
    }, function () { r.fetching = false; r.failedAt = Date.now(); });
  }

  function fail(r, msg) {
    r.posting = false; r.state = "error"; r.error = msg; r.result = null; r.usage = null;
    if (r.holding) AQ.smartmagic.finish(r.pid, false);
    paintViews(r);
    hooks.announce(msg);
  }

  function start(pid) {
    var r = runOf(pid), p = S.get(pid);
    if (!p || busy(r) || r.polling || !available() || p.videos.length < MIN_VIDEOS || p.videos.length > MAX_VIDEOS) return;
    r.posting = true; r.error = ""; r.pct = 0; r.stage = ""; r.result = null; r.usage = null;
    var gen = ++r.gen;
    r.holding = !!(AQ.smartmagic && AQ.smartmagic.begin(pid, magicHooks(r, pid)));   // the 3 s "charge" + the reveal burst (smartmagic.js)
    paintViews(r);
    hooks.announce("Arranging");
    var sent = AQ.api && AQ.api.flush ? AQ.api.flush() : Promise.resolve();     // the server must have the latest videos before it analyses them
    sent.catch(noop).then(function () { return request("POST", runPath(pid), {}); }).then(function (res) {
      if (gen !== r.gen) return;
      r.posting = false;
      if ((res.status === 200 || res.status === 202) && res.json !== undefined) {
        r.fetched = true; r.sig = sigOf(S.get(pid) || p); r.failedAt = 0;
        r.state = "queued"; r.current = true;          // the first GET (cached runs answer "ready" at once) decides what happens next
        startPoll(r, 300); paintViews(r);
        return;
      }
      fail(r, failText(res));
    }, function () { if (gen === r.gen) fail(r, "Could not reach the server. Check that it is running and try again."); });
  }

  /** Leaving a playlist stops its poll; coming back (or another playlist) reads the stored run again. */
  window.addEventListener("hashchange", function () {
    var pid = pageId();
    if (pid === lastPid) return;                    // same playlist (notes panel opened / closed)
    lastPid = pid;
    Object.keys(runs).forEach(function (k) {
      var r = runs[k];
      if (r.polling && k !== pid) stopPoll(r);
      if (r.holding && k !== pid) AQ.smartmagic.abort(k);   // left mid-sequence: no burst, no reorder
      if (!r.posting) r.fetched = false;
    });
  });
  lastPid = pageId();

  /* ---------- the button ---------- */
  function sparkle(cls) {
    var s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    s.setAttribute("class", cls);
    var p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "M12 2C12.7 8.2 15.8 11.3 22 12C15.8 12.7 12.7 15.8 12 22C11.3 15.8 8.2 12.7 2 12C8.2 11.3 11.3 8.2 12 2Z");   // four-point star
    p.setAttribute("fill", "currentColor");
    s.appendChild(p);
    return s;
  }

  /** What smartmagic.js calls back during one click sequence (see its header). `flip` glides the video rows while the store reorders. */
  function magicHooks(r, pid) {
    return {
      reorder: function (flip) {                    // the burst moment: put the placed videos in the recommended order
        var m = model(r, pid), ids = placed(pid, m), p = S.get(pid);
        if (!p || !ids.length) return { state: "none", ms: 0 };
        if (alreadyInOrder(pid, ids)) return { state: "same", ms: 0 };
        var before = p.videos.map(function (v) { return v.id; });
        var ms = flip(function () { arrange(pid, ids); });
        return { state: "moved", ms: ms, goal: m.goal, undo: function () { AQ.smartmagic.flip(function () { arrange(pid, before); }); } };
      },
      reveal: function (res) {                      // the glide is done (or there was nothing to move, or the run failed): show the panel
        r.holding = false; paintViews(r);
        if (res.state === "moved") {
          hooks.toast("Videos arranged for " + res.goal + ".", "Undo", res.undo);
          hooks.announce("Videos arranged");
        } else if (res.state === "same") {
          hooks.toast("Already in the best order.");
          hooks.announce("Already in the best order");
        } else if (res.state === "none") hooks.announce("The learning path is ready.");
      },
      abort: function () { r.holding = false; paintViews(r); },
      paint: function () { paintViews(r); }          // the phase changed (label "Arranged")
    };
  }

  function button(playlist) {
    var pid = playlist.id, magic = AQ.smartmagic, r = runOf(pid);
    var b = magic.button(pid, sparkle("smart-wbtn__spark"), function () { if (!busy(r)) start(pid); });   // liquid-glass lens (water.js) + sparkle
    var label = b.querySelector(".wbtn__label");

    function update() {
      var p = S.get(pid), n = p ? p.videos.length : 0, bz = busy(r), why = "", ph = magic.phase(pid);
      if (!bz) {
        if (!available()) why = "Smart arrange needs the AQ server, which is not reachable right now.";
        else if (n < MIN_VIDEOS) why = "Add at least " + MIN_VIDEOS + " videos to arrange this playlist.";
        else if (n > MAX_VIDEOS) why = "Smart arrange works with up to " + MAX_VIDEOS + " videos.";
      }
      var text = ph === "burst" ? "Arranged" : bz ? "Arranging..." : "Smart arrange";
      if (label.textContent !== text) label.textContent = text;
      b.disabled = !!why;
      b.classList.toggle("is-busy", bz);
      if (bz && ph !== "burst") { b.setAttribute("aria-busy", "true"); b.setAttribute("aria-disabled", "true"); }   // aria-disabled (not disabled): keyboard focus stays on the button
      else { b.removeAttribute("aria-busy"); b.removeAttribute("aria-disabled"); }
      b.title = bz ? "Working on it - this page updates by itself" : (why || "Order the videos as a learning path and find the topics that are still missing");
      magic.paint(pid, b);                          // charge / burst look (smartmagic.css); a re-rendered button picks the sequence up here
    }
    register(r, { el: b, update: update });
    update();
    load(pid);
    return b;
  }

  /* ---------- the panel: data helpers ---------- */
  function validId(id) { return typeof id === "string" && u.ID_RE.test(id); }
  function vInfo(pid, id) {                        // title/channel from the playlist in the store; the id when it is unknown
    var p = S.get(pid), i = p ? S.indexOfVideo(p, id) : -1;
    return i >= 0 ? { title: p.videos[i].title, channel: p.videos[i].channel, here: true } : { title: id, channel: "", here: false };
  }
  function prio(a) { return a.priority === "high" ? 0 : a.priority === "medium" ? 1 : 2; }
  function byPriority(list) {
    return list.map(function (a, i) { return { a: a, i: i }; }).sort(function (x, y) { return prio(x.a) - prio(y.a) || x.i - y.i; }).map(function (x) { return x.a; });
  }
  function cleanArea(a) {
    if (!a || typeof a !== "object" || !str(a.area, 200).trim()) return null;
    var st = a.status === "covered" || a.status === "partial" ? a.status : "missing";
    return { area: str(a.area, 200).trim(), why: str(a.why, 600), status: st, priority: a.priority === "high" || a.priority === "low" ? a.priority : "medium",
             covered_by: arr(a.covered_by).filter(validId) };
  }
  function cleanCand(c) {
    if (!c || !validId(c.id)) return null;
    var sec = Math.round(+c.duration_sec);
    return { id: c.id, title: str(c.title, 150).trim() || "YouTube video " + c.id, channel: str(c.channel, 80).trim(), sec: sec > 0 && sec < 86400 ? sec : 0 };
  }
  function cleanSug(s) {
    if (!s || typeof s !== "object") return null;
    var kind = s.kind === "overview" ? "Overview" : s.kind === "deep-dive" ? "Deep dive" : s.kind === "practice" ? "Practice" : "";
    return { topic: str(s.topic, 200).trim(), reason: str(s.reason, 500), kind: kind, cands: arr(s.candidates).map(cleanCand).filter(Boolean) };
  }

  var STOP = { and: 1, the: 1, of: 1, for: 1, to: 1, in: 1, a: 1, an: 1, vs: 1, with: 1, on: 1, how: 1, system: 1, systems: 1, design: 1 };
  function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(function (w) { return w && !STOP[w]; }); }
  /** 0..1 how closely a suggestion topic and an area name talk about the same thing. */
  function relate(topic, area) {
    var a = String(topic).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), b = String(area).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.indexOf(b) > -1 || b.indexOf(a) > -1) return 0.9;
    var wa = words(topic), wb = words(area);
    if (!wa.length || !wb.length) return 0;
    var hit = wa.filter(function (w) { return wb.indexOf(w) > -1; }).length;
    return hit / Math.min(wa.length, wb.length);
  }

  /** Everything the panel shows, cleaned once: sorted areas with their matched suggestions, the order list, the left-out videos. */
  function model(r, pid) {
    var res = r.result || {};
    var areas = arr(res.areas).map(cleanArea).filter(Boolean);
    var sugs = arr(res.suggestions).map(cleanSug).filter(function (s) { return s && s.cands.length; });
    var gaps = byPriority(areas.filter(function (a) { return a.status === "missing"; })).concat(byPriority(areas.filter(function (a) { return a.status === "partial"; })));
    var covered = byPriority(areas.filter(function (a) { return a.status === "covered"; }));
    var also = [];
    gaps.forEach(function (a) { a.sugs = []; });
    sugs.forEach(function (s) {
      var best = null, bestScore = 0;
      areas.forEach(function (a) { var sc = relate(s.topic, a.area); if (sc > bestScore || (sc === bestScore && best && best.status === "covered" && a.status !== "covered")) { best = a; bestScore = sc; } });
      if (best && bestScore >= 0.5 && best.status !== "covered") best.sugs.push(s); else also.push(s);
    });
    var seen = {}, order = [];
    arr(res.order).forEach(function (o) {
      if (!o || !validId(o.video_id) || seen[o.video_id]) return;
      seen[o.video_id] = 1;
      var topics = res.video_topics && res.video_topics[o.video_id];
      order.push({ id: o.video_id, reason: str(o.reason, 500), level: topics && typeof topics.level === "string" ? str(topics.level, 20) : "" });
    });
    var left = [], leftSeen = {};
    arr(res.off_goal).forEach(function (o) { if (o && validId(o.video_id) && !leftSeen[o.video_id]) { leftSeen[o.video_id] = 1; left.push({ id: o.video_id, reason: str(o.reason, 500), off: true }); } });
    arr(res.unplaced).forEach(function (o) { if (o && validId(o.video_id) && !leftSeen[o.video_id]) { leftSeen[o.video_id] = 1; left.push({ id: o.video_id, reason: str(o.reason, 500), off: false }); } });
    return { goal: str(res.goal, 200) || (S.get(pid) ? S.get(pid).name : ""), summary: str(res.path_summary, 800), gaps: gaps, covered: covered, also: also,
             order: order, left: left, checks: arr(res.checks).map(function (c) { return str(c, 300); }).filter(Boolean),
             stats: res.stats && typeof res.stats === "object" ? res.stats : {}, counts: {
               missing: areas.filter(function (a) { return a.status === "missing"; }).length,
               partial: areas.filter(function (a) { return a.status === "partial"; }).length,
               covered: covered.length } };
  }

  /* ---------- the panel: actions ---------- */
  /** Re-focus something after the page re-rendered (a store change rebuilds the whole screen, which drops focus). */
  function focusAfter(pid, sel) { prefsOf(pid).focus = sel; }

  function addCandidate(pid, c) {
    var p = S.get(pid);
    if (!p) return;
    focusAfter(pid, '[data-smart-open="' + c.id + '"]');
    var v = S.addVideo(pid, { id: c.id, title: c.title, channel: c.channel, duration: c.sec ? S.clock(c.sec) : "" });
    if (!v) { prefsOf(pid).focus = null; hooks.toast("That video is already in this playlist."); return; }
    hooks.toast("Added “" + v.title + "” to this playlist.", "Undo", function () { S.removeVideo(pid, v.id); });
    hooks.announce("Added " + v.title);
  }

  /** Move `target` ids to the front in that order (store reorder = one move at a time); everything else keeps its relative order behind them. */
  function arrange(pid, target) {
    var p = S.get(pid);
    if (!p) return;
    var have = p.videos.map(function (v) { return v.id; });
    var front = target.filter(function (id, i) { return have.indexOf(id) > -1 && target.indexOf(id) === i; });
    var full = front.concat(have.filter(function (id) { return front.indexOf(id) < 0; }));
    for (var i = 0; i < full.length; i++) {
      var cur = S.get(pid), at = cur ? S.indexOfVideo(cur, full[i]) : -1;
      if (at > -1 && at !== i) S.moveVideo(pid, at, i);
    }
  }
  function placed(pid, m) {                         // recommended ids that are still in the playlist
    var p = S.get(pid);
    return m.order.map(function (o) { return o.id; }).filter(function (id) { return p && S.indexOfVideo(p, id) > -1; });
  }
  function alreadyInOrder(pid, ids) {
    var p = S.get(pid);
    if (!p) return true;
    return ids.every(function (id, i) { return p.videos[i] && p.videos[i].id === id; });
  }
  function applyOrder(pid, m) {
    var p = S.get(pid);
    if (!p) return;
    var before = p.videos.map(function (v) { return v.id; }), ids = placed(pid, m);
    focusAfter(pid, '[data-smart-focus="order"]');
    arrange(pid, ids);
    hooks.toast("Applied the recommended order.", "Undo", function () { focusAfter(pid, '[data-smart-focus="order"]'); arrange(pid, before); });
    hooks.announce("Applied the recommended order");
  }

  /* ---------- the panel: DOM ---------- */
  var REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var STEP = 70, STEP_SOFT = 45;                   // ms between rows entering: a fresh run / a stored run shown on page load
  var played = {};                                 // "<playlist>|<run stamp>|<item>" -> 1 : that item's entrance already ran (one-shot per run)

  function stampOf(r) { return r.generatedAt || "run"; }
  function pad2(i) { return (i < 9 ? "0" : "") + (i + 1); }

  /** Count the .smart-num figures inside `node` up from 0 (quick, ease-out). The final number is already in the text, so this is only polish. */
  function countUp(node, delay) {
    if (REDUCED.matches || !node.querySelectorAll) return;
    Array.prototype.forEach.call(node.querySelectorAll(".smart-num"), function (n) {
      var to = +n.getAttribute("data-to"), dec = +n.getAttribute("data-dec") || 0, t0 = 0;
      if (!(to > 0)) return;
      function frame(now) {
        if (!n.isConnected) return;
        if (!t0) t0 = now;
        var k = Math.min(1, (now - t0) / 800);
        n.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(dec);
        if (k < 1) requestAnimationFrame(frame);
      }
      n.textContent = (0).toFixed(dec);
      setTimeout(function () { requestAnimationFrame(frame); }, delay || 0);
    });
  }

  /** The entrance of one render. rv(node, key) marks a row as a reveal item; the rows that have not played yet are watched and, when they
      scroll into view, slide in from the left one after another (--i = place in the batch). Rows that played before (the page re-rendered for
      an unrelated reason) are just shown. No motion at all with prefers-reduced-motion or without IntersectionObserver. */
  function entrance(pid, r, soft) {
    var prefix = pid + "|" + stampOf(r) + "|", items = [], io = null, step = soft ? STEP_SOFT : STEP;
    function rv(node, key) {
      node.classList.add("smart-rv");
      if (played[prefix + key]) node.classList.add("is-in", "is-seen");
      else { node.setAttribute("data-rv", prefix + key); items.push(node); }
      return node;
    }
    function show(batch) {
      batch.sort(function (a, b) { return a.compareDocumentPosition(b) & 4 ? -1 : 1; });
      var rows = 0;                                // only the rows count for the stagger; titles, rules and figures ride with the row they sit next to
      batch.forEach(function (n) {
        var i = Math.min(rows, 10);
        if (n.classList.contains("smart-hov")) rows++;
        n.style.setProperty("--i", String(i));
        played[n.getAttribute("data-rv")] = 1;
        n.classList.add("is-in");
        countUp(n, i * step + 220);
      });
    }
    var live = false;                              // false: nothing to animate (reduced motion, no IntersectionObserver, or everything played already)
    function prepare(card) {                       // rows stay invisible until arm() watches them (the drawer must be open for that)
      if (!items.length) return;
      if (REDUCED.matches || typeof IntersectionObserver !== "function") { items.forEach(function (n) { played[n.getAttribute("data-rv")] = 1; }); return; }
      live = true;
      card.classList.add("smart-anim");
      if (soft) card.classList.add("smart-anim--soft");
    }
    function arm() {                               // the drawer is open: rows enter as they come into the drawer's scroll area
      if (!live || io) return;
      io = new IntersectionObserver(function (entries) {
        var hit = [];
        entries.forEach(function (e) { if (e.isIntersecting) { hit.push(e.target); io.unobserve(e.target); } });
        if (hit.length) show(hit);
      }, { root: dock ? dock.scroller : null, threshold: 0.08, rootMargin: "0px 0px -4% 0px" });
      items.forEach(function (n) { io.observe(n); });
    }
    function stop() { if (io) io.disconnect(); io = null; }
    return { rv: rv, prepare: prepare, arm: arm, stop: stop };
  }

  /* quiet status marks: a small dot (hollow = missing, half = partly, filled = covered), priority as three little bars */
  function dot(kind) { return el("i", "smart-dot smart-dot--" + kind + " smart-mark"); }
  function tag(text, kind) {
    var t = el("span", "smart-tag");
    t.appendChild(dot(kind));
    t.appendChild(document.createTextNode(text));
    return t;
  }
  function prioMark(level) {
    var n = level === "high" ? 3 : level === "low" ? 1 : 2, w = el("span", "smart-prio");
    w.setAttribute("aria-hidden", "true");
    for (var i = 0; i < 3; i++) w.appendChild(el("i", "smart-mark" + (i < n ? " on" : "")));
    return w;
  }
  function numNode(n, dec) {
    n = +n || 0;
    var s = el("b", "smart-num", dec ? n.toFixed(dec) : String(n));
    s.setAttribute("data-to", String(n));
    if (dec) s.setAttribute("data-dec", String(dec));
    return s;
  }

  function openLink(id) {
    var a = el("a", "btn smart-act smart-act--icon smart-glass");
    a.href = u.watchUrl(id); a.target = "_blank"; a.rel = "noopener noreferrer"; a.setAttribute("data-smart-open", id);
    a.title = "Open on YouTube";
    a.appendChild(icon("external"));
    return a;
  }
  function candRow(pid, c, topic, idx) {
    var li = el("li", "smart-cand");
    li.style.setProperty("--c", String(Math.min(idx, 5)));
    var info = el("div", "smart-cand__info");
    info.appendChild(el("p", "smart-cand__title", c.title));
    info.appendChild(el("p", "smart-cand__meta muted", [c.channel, c.sec ? u.humanDuration(c.sec) : ""].filter(Boolean).join(" · ") || "YouTube"));
    li.appendChild(info);
    var acts = el("div", "smart-cand__acts");
    var p = S.get(pid), inList = p && S.indexOfVideo(p, c.id) > -1;
    var add = u.button(inList ? "Added" : "Add", { cls: "btn smart-act smart-glass" + (inList ? " is-added" : ""), icon: inList ? null : "plus", aria: (inList ? "Already in this playlist: " : "Add to this playlist: ") + c.title });
    add.disabled = !!inList;
    add.addEventListener("click", function () { addCandidate(pid, c); });
    acts.appendChild(add);
    var open = openLink(c.id); open.setAttribute("aria-label", "Open on YouTube: " + c.title + (topic ? " (" + topic + ")" : ""));
    acts.appendChild(open);
    li.appendChild(acts);
    return li;
  }
  function sugBlock(pid, s) {
    var d = el("div", "smart-sug");
    if (s.reason || s.kind) {
      var head = el("p", "smart-sug__why muted");
      if (s.kind) head.appendChild(el("span", "smart-kind", s.kind));
      if (s.reason) head.appendChild(el("span", "smart-sug__reason", s.reason));
      d.appendChild(head);
    }
    var ul = el("ul", "smart-cands");
    s.cands.forEach(function (c, i) { ul.appendChild(candRow(pid, c, s.topic, i)); });
    d.appendChild(ul);
    return d;
  }
  function areaCard(pid, a, i, ent) {
    var li = ent.rv(el("li", "smart-area smart-hov smart-area--" + a.status), "a:" + a.area);
    li.appendChild(el("span", "smart-area__n", pad2(i)));
    var main = el("div", "smart-area__main");
    var head = el("div", "smart-area__head");
    head.appendChild(el("h4", "smart-area__name", a.area));
    var st = el("p", "smart-status");
    var s1 = el("span", "smart-st"); s1.appendChild(dot(a.status)); s1.appendChild(document.createTextNode(a.status === "missing" ? "Missing" : "Partly covered"));
    var s2 = el("span", "smart-st"); s2.appendChild(prioMark(a.priority)); s2.appendChild(document.createTextNode(a.priority === "high" ? "High priority" : a.priority === "low" ? "Low priority" : "Medium priority"));
    st.appendChild(s1); st.appendChild(s2);
    head.appendChild(st);
    main.appendChild(head);
    if (a.why) main.appendChild(el("p", "smart-area__why", a.why));
    if (a.status === "partial" && a.covered_by.length) {
      var cb = el("p", "smart-area__by muted");
      cb.appendChild(document.createTextNode("Touched on in "));
      a.covered_by.forEach(function (id, k) { if (k) cb.appendChild(document.createTextNode(", ")); cb.appendChild(el("span", "smart-vt", vInfo(pid, id).title)); });
      main.appendChild(cb);
    }
    if (a.sugs && a.sugs.length) {
      main.appendChild(el("p", "smart-label", "Suggested videos"));
      a.sugs.forEach(function (s) { main.appendChild(sugBlock(pid, s)); });
    } else main.appendChild(el("p", "smart-area__none muted", "No video was found for this yet."));
    li.appendChild(main);
    return li;
  }

  /** A section: serif title, then a hairline that draws itself left to right under it (the sweep of the entrance). */
  function section(cls, title, id, ent) {
    var s = el("section", "smart-sec " + cls);
    var h = el("h3", "smart-h", title); h.id = id; h.tabIndex = -1; h.setAttribute("data-smart-focus", cls.replace("smart-sec--", ""));
    s.setAttribute("aria-labelledby", id);
    var head = ent.rv(el("div", "smart-sec__head"), "h:" + cls); head.appendChild(h);
    s.appendChild(head);
    var rule = ent.rv(el("span", "smart-rule"), "r:" + cls); rule.setAttribute("aria-hidden", "true");
    s.appendChild(rule);
    return { sec: s, head: head };
  }

  function topicsSection(pid, m, uid, ent) {
    var sc = section("smart-sec--topics", "Topics to cover", uid + "-topics", ent);
    var n = m.gaps.length;
    var sum = el("p", "smart-sec__sub muted", n ? plural(n, "area", "areas") + " this playlist does not fully cover yet." : "Every area of this goal is covered by the videos you have.");
    sc.sec.appendChild(sum);
    if (n) {
      var ul = el("ul", "smart-areas");
      m.gaps.forEach(function (a, i) { ul.appendChild(areaCard(pid, a, i, ent)); });
      sc.sec.appendChild(ul);
    }
    if (m.also.length) {
      sc.sec.appendChild(el("h4", "smart-h2", "Also worth adding"));
      m.also.forEach(function (s, i) {
        var box = ent.rv(el("div", "smart-also smart-hov"), "s:" + i + ":" + s.topic);
        if (s.topic) box.appendChild(el("p", "smart-also__topic", s.topic));
        box.appendChild(sugBlock(pid, s));
        sc.sec.appendChild(box);
      });
    }
    if (m.covered.length) {
      var det = ent.rv(el("details", "smart-covered"), "cov");
      det.open = prefsOf(pid).coveredOpen;
      det.addEventListener("toggle", function () { prefsOf(pid).coveredOpen = det.open; });
      det.appendChild(el("summary", "smart-covered__sum", "Already covered (" + m.covered.length + ")"));
      var cl = el("ul", "smart-covlist");
      m.covered.forEach(function (a) {
        var li = el("li", "smart-cov");
        li.appendChild(el("p", "smart-cov__name", a.area));
        if (a.covered_by.length) li.appendChild(el("p", "smart-cov__by muted", a.covered_by.map(function (id) { return vInfo(pid, id).title; }).join(" · ")));
        cl.appendChild(li);
      });
      det.appendChild(cl);
      sc.sec.appendChild(det);
    }
    return sc.sec;
  }

  function levelText(l) { return l === "beginner" ? "Beginner" : l === "intermediate" ? "Intermediate" : l === "advanced" ? "Advanced" : ""; }
  function orderSection(pid, m, uid, ent) {
    var sc = section("smart-sec--order", "Recommended order", uid + "-order", ent);
    var ids = placed(pid, m);
    var apply = u.button("Apply order", { cls: "btn btn--white btn--sm" });
    var same = alreadyInOrder(pid, ids);
    apply.disabled = !ids.length || same;
    apply.title = same ? "The playlist is already in this order" : "Reorder this playlist (you can undo it)";
    apply.addEventListener("click", function () { applyOrder(pid, m); });
    sc.head.appendChild(apply);
    sc.sec.appendChild(el("p", "smart-sec__sub muted", "Videos left out of the path stay at the end of the playlist when you apply this."));
    var ol = el("ol", "smart-order");
    m.order.forEach(function (o, i) {
      var info = vInfo(pid, o.id);
      var li = ent.rv(el("li", "smart-ord smart-hov" + (info.here ? "" : " is-gone")), "o:" + o.id);
      li.appendChild(el("span", "smart-ord__n", String(i + 1)));
      var body = el("div", "smart-ord__body");
      body.appendChild(el("p", "smart-ord__title", info.title));
      var meta = [info.here ? "" : "No longer in this playlist", levelText(o.level)].filter(Boolean).join(" · ");
      if (meta) body.appendChild(el("p", "smart-ord__meta muted", meta));
      if (o.reason) body.appendChild(el("p", "smart-ord__why", o.reason));
      li.appendChild(body);
      ol.appendChild(li);
    });
    sc.sec.appendChild(ol);
    if (m.left.length) {
      sc.sec.appendChild(el("h4", "smart-h2", "Left out of the path"));
      var ul = el("ul", "smart-left");
      m.left.forEach(function (o) {
        var li = ent.rv(el("li", "smart-lo smart-hov"), "l:" + o.id), info = vInfo(pid, o.id);
        var top = el("div", "smart-lo__top");
        top.appendChild(el("p", "smart-lo__title", info.title));
        top.appendChild(tag(o.off ? "Off-goal" : "Not placed", "off"));
        li.appendChild(top);
        if (o.reason) li.appendChild(el("p", "smart-lo__why muted", o.reason));
        ul.appendChild(li);
      });
      sc.sec.appendChild(ul);
    }
    return sc.sec;
  }

  /** "2 of 2 topics backed by transcript quotes · 8 videos found · 14.5 s" with the numbers as counting figures. */
  function footerLine(r, m) {
    var st = m.stats, p = el("p", "smart-foot__line muted"), first = true;
    function part(nodes) {
      if (!first) p.appendChild(document.createTextNode(" · "));
      first = false;
      nodes.forEach(function (n) { p.appendChild(typeof n === "string" ? document.createTextNode(n) : n); });
    }
    if (+st.topics_claimed > 0) part([numNode(st.topics_grounded), " of ", numNode(st.topics_claimed), " topics backed by transcript quotes"]);
    if (+st.candidates_found > 0) part([numNode(st.candidates_found), +st.candidates_found === 1 ? " video found" : " videos found"]);
    if (r.usage && +r.usage.wall_seconds > 0) part([numNode(r.usage.wall_seconds, 1), " s"]);
    return first ? null : p;
  }

  function resultView(r, pid, uid, p, fresh) {
    var m = model(r, pid), ent = entrance(pid, r, !fresh);
    var card = el("div", "smart-card");
    var head = ent.rv(el("header", "smart-head"), "head");
    var titles = el("div", "smart-head__titles");
    if (r.generatedAt && u.timeAgo(r.generatedAt)) titles.appendChild(el("p", "smart-gen", "Generated " + u.timeAgo(r.generatedAt)));
    var h2 = el("h2", "smart-title", "Learning path for ");
    h2.appendChild(el("em", "smart-title__goal", m.goal)); h2.id = uid + "-title"; h2.tabIndex = -1;
    titles.appendChild(h2);
    head.appendChild(titles);
    card.appendChild(head);
    if (m.summary) card.appendChild(ent.rv(el("p", "smart-summary", m.summary), "sum"));
    var figs = ent.rv(el("ul", "smart-figs"), "figs");
    function fig(n, label) { var li = el("li", "smart-fig"); li.appendChild(numNode(n)); li.appendChild(el("span", null, label)); figs.appendChild(li); }
    fig(m.order.length, m.order.length === 1 ? "video in the path" : "videos in the path");
    if (m.counts.missing) fig(m.counts.missing, "missing");
    if (m.counts.partial) fig(m.counts.partial, "partial");
    if (m.counts.covered) fig(m.counts.covered, "covered");
    card.appendChild(figs);
    var stale = !r.current || (r.sig && r.sig !== sigOf(p));
    if (stale) card.appendChild(el("p", "smart-stale", "The playlist changed since this was generated. Use Smart arrange to refresh it."));

    var body = el("div", "smart-body");
    body.appendChild(topicsSection(pid, m, uid, ent));
    body.appendChild(orderSection(pid, m, uid, ent));
    var foot = ent.rv(el("footer", "smart-foot"), "foot");
    var line = footerLine(r, m);
    if (line) foot.appendChild(line);
    if (m.checks.length) {
      var det = el("details", "smart-checks");
      det.appendChild(el("summary", "smart-checks__sum", "Verification notes"));
      var ul = el("ul", "smart-checks__list");
      m.checks.forEach(function (c) { ul.appendChild(el("li", null, c)); });
      det.appendChild(ul);
      foot.appendChild(det);
    }
    if (foot.firstChild) body.appendChild(foot);
    card.appendChild(body);
    card.stop = ent.stop;
    card.arm = ent.arm;
    card.gaps = m.gaps.length;
    ent.prepare(card);
    return card;
  }

  function runningView(r) {
    var card = el("div", "smart-card smart-run");
    var line = el("p", "smart-run__stage"); line.setAttribute("role", "status");     // polite live region: only changes when the stage changes
    var track = el("div", "smart-track"); track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Smart arrange progress"); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
    var fill = el("span", "smart-track__fill"); track.appendChild(fill);
    card.appendChild(line); card.appendChild(track);
    card.appendChild(el("p", "smart-run__note muted", "You can leave this page. The result will be here when you come back."));
    var sk = el("ul", "smart-skel"); sk.setAttribute("aria-hidden", "true");       // the waiting state: the rows of the result, still unwritten
    [[46, 82, 58], [38, 90, 40], [52, 74, 62]].forEach(function (w, i) {
      var li = el("li", "smart-skel__row"); li.style.setProperty("--i", String(i));
      li.appendChild(el("span", "smart-sk smart-sk--n"));
      var main = el("div", "smart-skel__main");
      w.forEach(function (pc, k) { var b = el("span", "smart-sk" + (k === 0 ? " smart-sk--h" : "")); b.style.width = pc + "%"; main.appendChild(b); });
      li.appendChild(main);
      sk.appendChild(li);
    });
    card.appendChild(sk);
    function paint() {
      var text = (STAGES[r.stage] || (r.state === "queued" ? STAGES.queued : "Working")) + "...";
      if (line.textContent !== text) line.textContent = text;
      var pct = r.posting ? 2 : Math.max(r.pct, 3);
      fill.style.width = pct + "%";
      track.setAttribute("aria-valuenow", String(r.pct));
      track.classList.toggle("is-indeterminate", !r.pct);
    }
    card.paint = paint;
    paint();
    return card;
  }

  function errorView(r, pid) {
    var card = el("div", "smart-card smart-err");
    var msg = el("div", "smart-err__msg");
    msg.setAttribute("role", "alert");
    msg.appendChild(el("p", "smart-err__title", "Smart arrange could not finish."));
    if (r.error) msg.appendChild(el("p", "muted", r.error));
    card.appendChild(msg);
    var retry = u.button("Retry", { cls: "btn btn--ghost btn--sm smart-glass" });
    retry.addEventListener("click", function () { start(pid); });
    card.appendChild(retry);
    return card;
  }

  /* ---------- the drawer: handle on the right edge + side panel ----------
     One drawer per page (a child of <body>, so it survives the page re-rendering on every store change). Hidden by default; the handle exists
     while a run exists or is running. Open on wide screens = the page content gets padding-right (body.smart-dock-open, transition in styles.css);
     below 1024px it is an overlay sheet with a scrim and the page scroll is locked. Open state lives in prefsOf(pid).open (closed again after leaving). */
  var WIDE = window.matchMedia ? window.matchMedia("(min-width: 1024px)") : { matches: true };
  var dock = null;

  function ensureDock() {
    if (dock) return dock;
    var d = dock = { pid: null, ph: null, mo: null, mode: null, cur: null, gaps: 0, wasOpen: false, armT: 0, pulsed: {} };
    d.host = el("div", "smart-dock"); d.host.hidden = true;
    d.handle = el("button", "smart-handle"); d.handle.type = "button";
    d.handle.setAttribute("aria-controls", "smart-drawer"); d.handle.setAttribute("aria-expanded", "false");
    d.handle.appendChild(sparkle("smart-handle__spark"));
    d.badge = el("span", "smart-handle__badge"); d.handle.appendChild(d.badge);
    d.label = el("span", "smart-handle__label"); d.handle.appendChild(d.label);
    d.handle.addEventListener("animationend", function () { d.handle.classList.remove("is-pulse"); });
    d.handle.addEventListener("click", function () { if (d.pid) setOpen(!prefsOf(d.pid).open, true); });
    d.scrim = el("div", "smart-scrim"); d.scrim.addEventListener("click", function () { setOpen(false, true); });
    d.drawer = el("aside", "smart-drawer"); d.drawer.id = "smart-drawer"; d.drawer.tabIndex = -1;
    d.drawer.setAttribute("aria-label", "Smart playlist: topics to cover");
    d.close = el("button", "smart-close smart-glass", "×"); d.close.type = "button"; d.close.setAttribute("aria-label", "Close Smart playlist panel");
    d.close.addEventListener("click", function () { setOpen(false, true); });
    d.scroller = el("div", "smart-drawer__scroll");
    d.content = el("div", "smart-drawer__body");
    d.content.addEventListener("pointermove", function (e) {      // the soft spotlight on a hovered row follows the pointer (--x/--y, as on the playlist cards)
      var row = e.pointerType !== "touch" && e.target && e.target.closest ? e.target.closest(".smart-hov") : null;
      if (!row) return;
      var b = row.getBoundingClientRect();
      row.style.setProperty("--x", (e.clientX - b.left).toFixed(0) + "px"); row.style.setProperty("--y", (e.clientY - b.top).toFixed(0) + "px");
    });
    d.scroller.appendChild(d.content);
    d.bar = el("div", "smart-drawer__bar");
    d.bar.appendChild(el("p", "eyebrow", "Smart playlist")); d.bar.appendChild(d.close);
    d.drawer.appendChild(d.bar); d.drawer.appendChild(d.scroller);
    d.host.appendChild(d.scrim); d.host.appendChild(d.drawer); d.host.appendChild(d.handle);
    d.drawer.addEventListener("keydown", function (e) {            // overlay mode: Tab stays inside the sheet
      if (e.key !== "Tab" || WIDE.matches) return;
      var f = Array.prototype.filter.call(d.drawer.querySelectorAll('a[href], button:not([disabled]), summary, [tabindex="0"]'), function (n) { return n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === d.drawer)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || e.defaultPrevented || !d.pid || !prefsOf(d.pid).open || d.host.hidden) return;
      if (AQ.dialog && AQ.dialog.isOpen && AQ.dialog.isOpen()) return;
      setOpen(false, true);
    });
    var onWide = function () { syncDock(); };
    if (WIDE.addEventListener) WIDE.addEventListener("change", onWide); else if (WIDE.addListener) WIDE.addListener(onWide);
    return d;
  }

  function bodyClasses(on, open, lock) {
    var c = document.body.classList;
    c.toggle("smart-dock-on", on); c.toggle("smart-dock-open", open); c.toggle("smart-lock", lock);
  }

  /** Bring the drawer + handle in line with the run state and the open flag (cheap; called after every change). */
  function syncDock() {
    var d = dock;
    if (!d || !d.pid) return;
    var showing = (d.mode === "running" || d.mode === "ready" || d.mode === "error") && d.ph && d.ph.isConnected && !d.ph.hidden;
    if (!showing) { d.host.hidden = true; d.wasOpen = false; bodyClasses(false, false, false); return; }
    var pf = prefsOf(d.pid), open = !!pf.open;
    d.host.hidden = false;
    d.host.classList.toggle("is-open", open);
    d.handle.setAttribute("aria-expanded", String(open));
    d.handle.classList.toggle("is-run", d.mode === "running");
    d.handle.classList.toggle("is-err", d.mode === "error");
    var text = d.mode === "running" ? "Arranging" : d.mode === "error" ? "Smart arrange" : "Topics to cover";
    if (d.label.textContent !== text) d.label.textContent = text;
    var badge = d.mode === "ready" && d.gaps ? String(d.gaps) : d.mode === "error" ? "!" : "";
    if (d.badge.textContent !== badge) d.badge.textContent = badge;
    d.badge.hidden = !badge && d.mode !== "running";
    d.handle.setAttribute("aria-label", d.mode === "running" ? "Smart playlist: arranging, open progress" : d.mode === "error" ? "Smart playlist: could not finish, open details"
      : "Topics to cover" + (d.gaps ? ", " + plural(d.gaps, "area", "areas") + " to add" : ""));
    d.handle.title = open ? "Close this panel" : "Open Smart playlist";
    bodyClasses(true, open, open && !WIDE.matches);
    if (d.mode === "ready" && !open && !d.pulsed[d.pid]) { d.pulsed[d.pid] = true; d.handle.classList.add("is-pulse"); }   // once, so the handle is discoverable
    var opening = open && !d.wasOpen;
    d.wasOpen = open;
    clearTimeout(d.armT);
    if (open && d.cur && d.cur.arm) {              // rows slide in once the drawer is on its way out (after the slide, not during it)
      if (opening && !REDUCED.matches) d.armT = setTimeout(function () { if (dock === d && d.cur && d.cur.arm && d.wasOpen) d.cur.arm(); }, 240);
      else d.cur.arm();
    }
  }

  function setOpen(on, byUser) {
    var d = dock;
    if (!d || !d.pid) return;
    var pf = prefsOf(d.pid);
    if (pf.open === on) return;
    pf.open = on;
    d.pulsed[d.pid] = true;
    syncDock();
    if (on && byUser) d.drawer.focus({ preventScroll: true });
    else if (!on && byUser) d.handle.focus({ preventScroll: true });
    else if (!on && d.drawer.contains(document.activeElement)) d.handle.focus({ preventScroll: true });
  }

  /** Remove the drawer, the handle and every body class (the page left the playlist, or its placeholder is gone). */
  function teardown() {
    var d = dock;
    if (!d || !d.pid) return;
    if (d.cur && d.cur.stop) d.cur.stop();
    clearTimeout(d.armT);
    if (d.mo) { d.mo.disconnect(); d.mo = null; }
    prefsOf(d.pid).open = false;
    d.pid = null; d.ph = null; d.mode = null; d.cur = null; d.wasOpen = false;
    d.content.textContent = "";
    d.host.hidden = true;
    if (d.host.parentNode) d.host.parentNode.removeChild(d.host);
    bodyClasses(false, false, false);
  }
  function guard() { if (dock && dock.pid && (!dock.ph || !dock.ph.isConnected || pageId() !== dock.pid)) teardown(); }
  window.addEventListener("hashchange", function () { setTimeout(guard, 0); });   // after app.js re-rendered
  S.subscribe(function () { setTimeout(guard, 0); });

  /** Fill the drawer for the current run state (called for every run change and every page re-render). */
  function paintDock(root, pid, r) {
    var d = dock, p = S.get(pid), n = p ? p.videos.length : 0, uid = "smart-" + pid;
    var m = busy(r) ? "running" : r.state === "ready" && r.result ? "ready" : r.state === "error" ? "error" : (available() && (n === 1 || n > MAX_VIDEOS)) ? "hint" : "none";
    if (m === "hint") { root.textContent = ""; root.appendChild(el("p", "smart-note muted", n === 1 ? "Add at least one more video to use Smart arrange on this playlist." : "Smart arrange works with up to " + MAX_VIDEOS + " videos.")); }
    else if (root.firstChild) root.textContent = "";
    if (m === "running" && d.mode === "running" && d.cur && d.cur.paint) { d.cur.paint(); syncDock(); return; }     // same node, only the numbers move
    var auto = false;
    if (m === "running") r.sawRun = true;                                                      // a result that follows a run seen here is "fresh": full entrance + the drawer opens by itself
    else if ((m === "ready" || m === "error") && r.sawRun) { r.sawRun = false; auto = true; if (m === "ready") r.freshStamp = stampOf(r); }
    if (d.cur && d.cur.stop) d.cur.stop();
    var ae = document.activeElement, inside = ae && d.content.contains(ae);
    var keep = inside ? (ae.getAttribute("data-smart-open") ? '[data-smart-open="' + ae.getAttribute("data-smart-open") + '"]' : ae.getAttribute("data-smart-focus") ? '[data-smart-focus="' + ae.getAttribute("data-smart-focus") + '"]' : "") : "";
    var top = d.mode === m ? d.scroller.scrollTop : 0;
    d.content.textContent = "";
    d.mode = m; d.cur = null;
    if (m === "running") d.cur = runningView(r);
    else if (m === "ready") d.cur = resultView(r, pid, uid, p, r.freshStamp === stampOf(r));
    else if (m === "error") d.cur = errorView(r, pid);
    d.gaps = d.cur && d.cur.gaps || 0;
    if (d.cur) d.content.appendChild(d.cur);
    d.scroller.scrollTop = top;
    if (auto) { prefsOf(pid).open = true; d.pulsed[pid] = true; }
    syncDock();
    if (keep) { var again = d.content.querySelector(keep); if (again) again.focus({ preventScroll: true }); }   // a repaint must not drop the keyboard user's place
  }

  function panel(playlist) {
    var pid = playlist.id, r = runOf(pid);
    var root = el("div", "smart");                 // page placeholder: empty (display:none); the real thing is the drawer in <body>
    root.setAttribute("data-smart-panel", "");
    var d = ensureDock();
    if (d.pid !== pid) {
      if (d.pid) teardown();
      d.pid = pid; d.mode = null; d.cur = null; d.wasOpen = false;
    }
    if (d.mo) d.mo.disconnect();
    d.ph = root;
    if (typeof MutationObserver === "function") {  // the split view (notes next to the list) hides the placeholder: hide the drawer with it
      d.mo = new MutationObserver(function () { syncDock(); });
      d.mo.observe(root, { attributes: true, attributeFilter: ["hidden"] });
    }
    if (!d.host.parentNode) document.body.appendChild(d.host);
    register(r, { el: root, update: function () { if (dock && dock.ph === root) paintDock(root, pid, r); } });
    paintDock(root, pid, r);
    load(pid);

    var pf = prefsOf(pid);
    if (pf.focus) {                                // put focus back where the user was before the page re-rendered
      setTimeout(function () {                     // (several quick re-renders: only the panel that survived does it, then the request is cleared)
        if (!root.isConnected || !pf.focus) return;
        var t = d.content.querySelector(pf.focus); pf.focus = null;
        if (t && t.focus) t.focus({ preventScroll: true });
      }, 0);
    }
    return root;
  }

  /** Hand over the page's toast + live-region helpers (they are private to app.js). */
  function init(h) {
    if (h && typeof h.toast === "function") hooks.toast = h.toast;
    if (h && typeof h.announce === "function") hooks.announce = h.announce;
  }

  AQ.smart = { init: init, button: button, panel: panel };
})();
