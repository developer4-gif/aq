/* AQ Learning - adapter for the aq-api application backend (D:\AQspace\aq-api, http://127.0.0.1:5180).

   The UI keeps working without it: localStorage stays the offline cache / fallback and every store function is still synchronous.
   When the API is reachable (same origin when served by aq-api, else http://127.0.0.1:5180) this file
     1. loads playlists + watch progress from the server on start (and tells the store, which re-renders),
     2. migrates what was in localStorage once (the server's `bootstrapped` flag decides, so it happens only the first time),
     3. writes every later change through to the server in order (AQ.store calls AQ.api.record(...)),
     4. if a write cannot be sent (server down) it sets `aq.dirty.v1`; the next successful connection pushes the local state.

   AQ.api.ready()      -> Promise<boolean>   resolves once the first probe + sync attempt finished
   AQ.api.available()  -> boolean            server reachable and in sync (notes.js / importpl.js switch to /api/v1 on this)
   AQ.api.base         -> "" | "http://127.0.0.1:5180"
   AQ.api.flush()      -> Promise            resolves when queued writes (and pending progress) were sent
   AQ.api.record(name, argsArray)            used by store.js only */
(function () {
  "use strict";

  var FALLBACK = "http://127.0.0.1:5180";
  var DIRTY_KEY = "aq.dirty.v1";
  var WATCH_DELAY_MS = 2000;

  var api = { base: "" };
  var state = { ok: false, reconciled: false, earlyMut: false };
  var chain = Promise.resolve();
  var pending = {};            // videoId -> { timer, rec }
  var readyP = null;

  /* ---------- tiny helpers ---------- */
  function isDirty() { try { return localStorage.getItem(DIRTY_KEY) === "1"; } catch (e) { return false; } }
  function markDirty() { try { localStorage.setItem(DIRTY_KEY, "1"); } catch (e) { /* storage blocked */ } }
  function clearDirty() { try { localStorage.removeItem(DIRTY_KEY); } catch (e) { /* storage blocked */ } }
  function plain(x) { return JSON.parse(JSON.stringify(x)); }

  function req(method, path, body, opts) {
    opts = opts || {};
    var base = opts.base != null ? opts.base : api.base;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || 15000);
    function done() { clearTimeout(timer); }
    return fetch(base + path, {
      method: method, cache: "no-store", keepalive: !!opts.keepalive,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (res.status === 204) { done(); return { status: 204, json: null }; }
      return res.json().catch(function () { return null; }).then(function (j) { done(); return { status: res.status, json: j }; });
    }, function (err) { done(); throw err; });
  }

  /* ---------- finding the server ---------- */
  function probe(base) {
    return req("GET", "/api/v1/health", undefined, { base: base, timeout: 1500 })
      .then(function (r) { return r.status === 200 && r.json && r.json.service === "aq-api"; }, function () { return false; });
  }
  function detect() {
    var cands = [];
    if (/^https?:$/.test(location.protocol)) cands.push("");
    if (location.port !== "5180") cands.push(FALLBACK);
    return cands.reduce(function (p, base) {
      return p.then(function (found) {
        if (found !== null) return found;
        return probe(base).then(function (ok) { return ok ? base : null; });
      });
    }, Promise.resolve(null));
  }

  /* ---------- server -> store ---------- */
  function pull() {
    return Promise.all([req("GET", "/api/v1/playlists?include=videos"), req("GET", "/api/v1/progress")]).then(function (rs) {
      if (rs[0].status !== 200 || rs[1].status !== 200) throw new Error("pull failed");
      AQ.store.applyRemote(rs[0].json.playlists, rs[1].json.progress);
    });
  }

  /** Decides between "adopt the server's data" and "push the local data" (first run / offline edits), then applies the result. */
  function reconcile() {
    return req("GET", "/api/v1/me").then(function (me) {
      if (me.status !== 200 || !me.json) throw new Error("me failed");
      var boot = !!me.json.bootstrapped;
      if (isDirty() || !boot) {
        var st = AQ.store.exportState();
        return req("POST", "/api/v1/sync/import", { mode: boot ? "replace" : "merge", playlists: st.playlists, progress: st.progress }, { timeout: 30000 })
          .then(function (r) { if (r.status !== 200 || !r.json) throw new Error("import failed"); return r.json; });
      }
      return Promise.all([req("GET", "/api/v1/playlists?include=videos"), req("GET", "/api/v1/progress")]).then(function (rs) {
        if (rs[0].status !== 200 || rs[1].status !== 200) throw new Error("load failed");
        return { playlists: rs[0].json.playlists, progress: rs[1].json.progress };
      });
    }).then(function (data) {
      if (state.earlyMut) { state.earlyMut = false; markDirty(); return reconcile(); }   // the user edited while we were loading: push theirs instead
      clearDirty();
      AQ.store.applyRemote(data.playlists, data.progress);
      state.ok = true; state.reconciled = true;
    });
  }

  function connect() {
    return detect().then(function (base) {
      if (base === null) { state.reconciled = true; state.ok = false; return false; }
      api.base = base;
      return reconcile().then(function () { return true; }, function () { state.reconciled = true; state.ok = false; return false; });
    });
  }

  /* ---------- store -> server (write-through, in order) ---------- */
  function vid(v) { return { id: v.id, title: v.title, channel: v.channel, duration: v.duration, added: v.added }; }
  var P = "/api/v1/playlists/";
  var ops = {
    create: function (a) {
      var p = a[0];
      return req("POST", "/api/v1/playlists", { id: p.id, name: p.name, description: p.description, source: p.source, videos: p.videos.map(vid) });
    },
    update: function (a) { return req("PATCH", P + a[0], { name: a[1], description: a[2] }); },
    remove: function (a) { return req("DELETE", P + a[0]); },
    addVideo: function (a) {
      var body = vid(a[1]); if (typeof a[2] === "number") body.position = a[2];
      return req("POST", P + a[0] + "/videos", body);
    },
    addVideos: function (a) { return req("POST", P + a[0] + "/videos", { videos: a[1].map(vid) }); },
    removeVideo: function (a) { return req("DELETE", P + a[0] + "/videos/" + a[1]); },
    updateVideo: function (a) { return req("PATCH", P + a[0] + "/videos/" + a[1], { title: a[2].title, channel: a[2].channel, duration: a[2].duration }); },
    moveVideo: function (a) { return req("PUT", P + a[0] + "/videos/order", { order: a[1] }); },
    watch: function (a) {
      var r = a[1];
      return req("PUT", "/api/v1/progress/" + a[0], { pos: r.pos, dur: r.dur, done: !!r.done, updated: r.updated }, { keepalive: true });
    }
  };

  function exec(op) {
    if (!state.ok) { markDirty(); return Promise.resolve(); }
    if (isDirty()) return Promise.resolve();               // local state will be pushed as a whole on the next sync
    return ops[op.name](op.a).then(function (r) {
      if (r.status >= 500) throw new Error("server error");
      var gone = r.status === 404 && (op.name === "remove" || op.name === "removeVideo");
      if (r.status >= 400 && !gone && op.name !== "watch") return pull().catch(function () { /* next start fixes it */ });   // server refused: take its view
    }, function () {
      state.ok = false; markDirty();                       // unreachable: remember to push everything later
    });
  }
  function enqueue(op) { chain = chain.then(function () { return exec(op); }).catch(function () { /* never break the chain */ }); }

  function flushWatch() {
    Object.keys(pending).forEach(function (id) {
      var p = pending[id]; delete pending[id];
      clearTimeout(p.timer);
      enqueue({ name: "watch", a: [id, p.rec] });
    });
  }
  function queueWatch(id, rec) {
    if (!state.reconciled) { state.earlyMut = true; markDirty(); return; }
    if (!state.ok) { markDirty(); return; }
    var p = pending[id];
    if (p) { p.rec = rec; return; }
    pending[id] = { rec: rec, timer: setTimeout(function () {
      var q = pending[id]; delete pending[id];
      if (q) enqueue({ name: "watch", a: [id, q.rec] });
    }, WATCH_DELAY_MS) };
  }

  api.record = function (name, args) {
    if (!ops[name]) return;
    var a = plain(args);
    if (name === "watch") { queueWatch(a[0], a[1]); return; }
    if (!state.reconciled) { state.earlyMut = true; markDirty(); return; }   // still loading: the whole local state gets pushed
    enqueue({ name: name, a: a });
  };
  api.flush = function () { flushWatch(); return chain.then(function () { /* drained */ }); };
  api.available = function () { return state.ok; };
  api.ready = function () { return readyP || Promise.resolve(false); };

  /* try again when the browser comes back online / the tab is shown and the last attempt failed */
  function retry() {
    if (state.ok || !state.reconciled || (readyP && state.connecting)) return;
    state.connecting = true;
    readyP = connect().then(function (ok) { state.connecting = false; return ok; });
  }
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushWatch(); else retry();
  });
  window.addEventListener("pagehide", flushWatch);

  readyP = connect();
  window.AQ = window.AQ || {};
  AQ.api = api;
})();
