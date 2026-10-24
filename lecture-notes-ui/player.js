/* AQ Learning - player dialog: a youtube-nocookie embed (validated 11-char id) with previous/next through a queue.
   The YouTube IFrame Player API (loaded once) reports the real playback position, which is saved per video in
   AQ.store (`aq.watch.v1`); opening a video that was left half-way resumes there.

   AQ.player.open({ queue: [video, ...], index: 0, opener, restore })
     opener  = element to refocus on close; restore = function returning the element to refocus when the opener was
     re-rendered meanwhile (the watch state change re-renders the page behind the dialog when the player closes). */
(function () {
  "use strict";
  var u = AQ.util, S = AQ.store, el = u.el;

  /* ---------- IFrame API loader (once; retried on the next open if it failed) ---------- */
  var apiState = 0, apiWaiters = [];      // 0 idle, 1 loading, 2 ready
  function flushApi(ok) {
    var w = apiWaiters; apiWaiters = [];
    w.forEach(function (x) { try { (ok ? x.ok : x.fail)(); } catch (e) { /* ignore */ } });
  }
  function loadApi(ok, fail) {
    if (window.YT && window.YT.Player) { ok(); return; }
    apiWaiters.push({ ok: ok, fail: fail });
    if (apiState === 1) return;
    apiState = 1;
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      apiState = 2;
      if (typeof prev === "function") { try { prev(); } catch (e) { /* ignore */ } }
      flushApi(true);
    };
    var s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.async = true;
    function failed() { if (apiState === 1) { apiState = 0; if (s.parentNode) s.parentNode.removeChild(s); flushApi(false); } }
    s.onerror = failed;
    setTimeout(failed, 12000);
    document.head.appendChild(s);
  }

  function embedSrc(id, start) {
    return "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?rel=0&autoplay=1&playsinline=1&enablejsapi=1" +
      "&origin=" + encodeURIComponent(location.origin) + (start > 0 ? "&start=" + start : "");
  }

  function open(opts) {
    var queue = (opts.queue || []).filter(function (v) { return v && u.ID_RE.test(v.id); });
    if (!queue.length) return null;
    var i = Math.max(0, Math.min(opts.index || 0, queue.length - 1));
    var cur = null;                       // {id, yt, timer, ended, sawPlay, learned, gen}
    var gen = 0;

    /* ----- tracking ----- */
    function sample(c) {
      if (!c || !c.yt || typeof c.yt.getCurrentTime !== "function") return;
      var state, t, dur;
      try { state = c.yt.getPlayerState(); t = c.yt.getCurrentTime(); dur = c.yt.getDuration(); } catch (e) { return; }
      if (dur > 0 && !c.learned) { c.learned = true; S.learnDuration(c.id, dur); }
      if (state === 1) c.sawPlay = true;
      if (state === 0) {                                   // ended
        if (!c.ended) { c.ended = true; S.watchSave(c.id, { ended: true, dur: dur > 0 ? dur : null }); S.notify(); }
      } else if (state === 1 || state === 2 || (state === 3 && c.sawPlay)) {
        c.ended = false;
        S.watchSave(c.id, { pos: t, dur: dur > 0 ? dur : null });
      }
    }
    function tick() { sample(cur); }

    /* Backup tracking without the IFrame API wrapper: ask the embed to "listen" and read the infoDelivery
       messages it posts back (currentTime / duration / playerState). Works even when YT.Player never
       becomes ready (e.g. API blocked, or host mismatch), so resume positions are always saved. */
    function directTrack(frame, c, myGen) {
      var tries = 0, heard = false;
      function hello() {
        if (cur !== c || myGen !== gen || heard || tries++ > 20) return;
        try { frame.contentWindow.postMessage(JSON.stringify({ event: "listening", id: c.id, channel: "widget" }), "*"); } catch (e) { /* ignore */ }
        setTimeout(hello, 1000);
      }
      function onMsg(e) {
        if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin) || e.source !== frame.contentWindow) return;
        if (cur !== c) { window.removeEventListener("message", onMsg); return; }
        var data; try { data = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (x) { return; }
        if (!data || !data.info) return;
        heard = true;
        var info = data.info;
        if (typeof info.duration === "number" && info.duration > 0) {
          c.dur = info.duration;
          if (!c.learned) { c.learned = true; S.learnDuration(c.id, info.duration); }
        }
        if (typeof info.playerState === "number") {
          c.state = info.playerState;
          if (info.playerState === 1) c.sawPlay = true;
          if (info.playerState === 0 && !c.ended) { c.ended = true; S.watchSave(c.id, { ended: true, dur: c.dur || null }); S.notify(); }
        }
        if (typeof info.currentTime === "number" && info.currentTime > 0 && !c.ended && (c.sawPlay || c.state === 2)) {
          S.watchSave(c.id, { pos: info.currentTime, dur: c.dur || null });
        }
      }
      window.addEventListener("message", onMsg);
      frame.addEventListener("load", hello);
    }
    function teardown() {
      gen++;
      var c = cur; cur = null;
      if (!c) return;
      clearInterval(c.timer);
      try { sample(c); } catch (e) { /* ignore */ }
      try { if (c.yt && c.yt.destroy) c.yt.destroy(); } catch (e) { /* ignore */ }
    }
    // dialog.js clears the iframe before calling onClose, so save in capture phase on Esc / backdrop / close button
    function early(e) {
      if (e.type === "keydown" && e.key !== "Escape") return;
      if (e.type === "click" && !(e.target.closest && e.target.closest("[data-close]"))) return;
      tick();
    }
    var modalEl = document.getElementById("modal");
    document.addEventListener("keydown", early, true);
    if (modalEl) modalEl.addEventListener("click", early, true);
    window.addEventListener("pagehide", tick);

    var d = AQ.dialog.open({
      kind: "Watch", title: "", opener: opts.opener, restore: opts.restore, wide: true,
      onClose: function () {
        document.removeEventListener("keydown", early, true);
        if (modalEl) modalEl.removeEventListener("click", early, true);
        window.removeEventListener("pagehide", tick);
        teardown();
        S.notify();                       // progress changed: refresh cards / rows (before focus is restored)
      }
    });

    function go(delta, role) {
      var next = Math.max(0, Math.min(i + delta, queue.length - 1));
      if (next === i) return;
      teardown(); S.notify();
      i = next; render(role);
    }

    function render(focusRole) {
      var v = queue[i];
      var info = S.watchInfo(v.id, u.parseDuration(v.duration));
      var start = info.state === "partial" ? Math.floor(info.pos) : 0;
      d.body.textContent = "";
      d.setTitle(v.title || ("YouTube video " + v.id));
      d.setKind("Watch");

      var myGen = ++gen;
      var wrap = el("div", "embed");
      var f = document.createElement("iframe");
      f.src = embedSrc(v.id, start);
      f.title = "YouTube player: " + (v.title || v.id);
      f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
      f.allowFullscreen = true;
      f.referrerPolicy = "strict-origin-when-cross-origin";
      wrap.appendChild(f); d.body.appendChild(wrap);

      var c = { id: v.id, yt: null, timer: 0, ended: false, sawPlay: false, learned: false };
      cur = c;
      directTrack(f, c, myGen);
      loadApi(function () {
        if (cur !== c || myGen !== gen) return;
        try {
          // the embed is served from youtube-nocookie.com: without `host` the API ignores its messages,
          // so onReady / getCurrentTime never work and no position is saved
          c.yt = new window.YT.Player(f, { host: "https://www.youtube-nocookie.com", events: {
            onReady: function () { if (cur === c) { tick(); c.timer = setInterval(tick, 1000); } },
            onStateChange: function () { if (cur === c) tick(); }
          } });
        } catch (e) { c.yt = null; }
      }, function () { /* API unavailable (offline / blocked): the plain embed still plays, just without saved progress */ });

      var row = el("div", "modal__row modal__row--player");
      var prev = u.button("Previous", { cls: "btn btn--ghost btn--sm", icon: "prev" });
      var next = u.button("Next", { cls: "btn btn--ghost btn--sm", icon: "next" });
      prev.dataset.role = "prev"; next.dataset.role = "next";
      prev.disabled = i === 0; next.disabled = i === queue.length - 1;
      prev.addEventListener("click", function () { go(-1, "prev"); });
      next.addEventListener("click", function () { go(1, "next"); });
      if (queue.length > 1) {
        row.appendChild(prev);
        var pos = el("span", "modal__pos", (i + 1) + " of " + queue.length);
        pos.setAttribute("aria-live", "polite");
        row.appendChild(pos);
        row.appendChild(next);
      }
      if (start > 0) row.appendChild(el("span", "modal__resume", "Resumed at " + S.clock(start)));
      row.appendChild(el("span", "modal__spacer"));

      var yt = el("a", "btn btn--ghost btn--sm");
      yt.appendChild(u.icon("external")); yt.appendChild(el("span", null, "Open on YouTube"));
      yt.href = u.watchUrl(v.id); yt.target = "_blank"; yt.rel = "noopener noreferrer";
      row.appendChild(yt);
      d.body.appendChild(row);

      var target = focusRole && d.body.querySelector('[data-role="' + focusRole + '"]:not([disabled])');
      (target || d.element).focus();
    }

    render();
    return d;
  }

  AQ.player = { open: open };
})();
