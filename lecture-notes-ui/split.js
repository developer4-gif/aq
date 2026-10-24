/* AQ Learning - split view on the playlist detail screen (Agent C2).

   Route: #/playlist/<id>/notes/<videoId>. When a video's notes are opened, the notes panel slides in from the right while the
   video list shrinks to a compact left nav (a horizontal strip under 900px). Close / Esc / browser Back reverses it.
   The list element is the SAME node in both states, so the list <-> nav morph is a FLIP animation (transform + opacity only).

   API (used by app.js):
     AQ.split.shell({playlist, list, hide:[elements], openId}) -> element to append in place of the bare list
     AQ.split.open(video)   open or switch the notes panel (pushes a history entry the first time)
     AQ.split.close()       close it (history.back() when we pushed the entry)
     AQ.split.reset()       tear down before another screen renders
     AQ.split.owns()        true while the current hash belongs to the live shell (app.js then skips its own re-render)
   Uses AQ.notesView.mount(container, video, {onClose}) (C3), AQ.notesJobs.status/subscribe (C1); all guarded. */
(function () {
  "use strict";
  var AQ = window.AQ = window.AQ || {};
  var u = AQ.util, S = AQ.store, el = u.el;
  var DUR = 460, EASE = "cubic-bezier(.2,.7,.2,1)";
  var cur = null;          // the live shell state
  var pushed = false;      // did we push the notes history entry (so Close can go Back)?

  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function canAnimate(node) { return !reduced() && node && typeof node.animate === "function"; }
  function viewEl() { return document.getElementById("view"); }

  function parse() {
    var m = /^#\/playlist\/([a-z0-9-]{1,48})(?:\/notes\/([A-Za-z0-9_-]{11}))?\/?$/.exec(location.hash || "");
    return m ? { pid: m[1], vid: m[2] || null } : null;
  }
  function owns() {
    var r = parse();
    return !!(cur && cur.root.isConnected && r && r.pid === cur.pid);
  }
  function findVideo(pid, vid) {
    var p = S.get(pid);
    if (!p || !vid) return null;
    for (var i = 0; i < p.videos.length; i++) if (p.videos[i].id === vid) return p.videos[i];
    return null;
  }
  function rowOf(st, vid) { return st.ol.querySelector('[data-vid="' + vid + '"]'); }
  function say(text) { var l = document.getElementById("live"); if (l) { l.textContent = ""; setTimeout(function () { l.textContent = text; }, 30); } }

  /* ---------- per-video notes state dot + watched tick ---------- */
  function stateOf(id) {
    var j = AQ.notesJobs, s = null;
    try { s = j && typeof j.status === "function" ? j.status(id) : null; } catch (e) { s = null; }
    var t = String((s && (s.state || s.status)) || (typeof s === "string" ? s : "none")).toLowerCase();
    if (t === "ready" || t === "done") return "ready";
    if (t === "queued" || t === "running" || t === "preparing" || t === "pending" || t === "starting") return "running";
    if (t === "error" || t === "failed") return "error";
    return "none";
  }
  var STATE_TEXT = { ready: "Notes ready", running: "Notes in progress", error: "Notes failed", none: "No notes yet" };

  function decorate(st) {
    Array.prototype.forEach.call(st.ol.children, function (li) {
      if (li.querySelector(".vrow__state")) return;
      var box = el("span", "vrow__state");
      var dot = el("span", "sdot"); dot.setAttribute("data-dot", "");
      var txt = el("span", "sr"); txt.setAttribute("data-dot-text", "");
      var tick = el("span", "swatch"); tick.setAttribute("aria-hidden", "true"); tick.title = "Watched"; tick.hidden = true;
      box.appendChild(dot); box.appendChild(txt); box.appendChild(tick);
      li.appendChild(box);
    });
    paintDots(st);
  }
  function paintDots(st) {
    Array.prototype.forEach.call(st.ol.children, function (li) {
      var id = li.getAttribute("data-vid"), s = stateOf(id);
      var dot = li.querySelector("[data-dot]"), txt = li.querySelector("[data-dot-text]"), tick = li.querySelector(".swatch");
      if (dot) { dot.setAttribute("data-state", s); dot.title = STATE_TEXT[s]; }
      if (txt) txt.textContent = STATE_TEXT[s];
      if (tick) { var w = false; try { w = !!(S.isWatched && S.isWatched(id)); } catch (e) { w = false; } tick.hidden = !w; }
    });
  }

  /* ---------- FLIP helpers ---------- */
  function measure(st) {
    var out = {};
    Array.prototype.forEach.call(st.ol.children, function (li) {
      var th = li.querySelector(".vrow__thumb");
      out[li.getAttribute("data-vid")] = { row: li.getBoundingClientRect(), thumb: th ? th.getBoundingClientRect() : null };
    });
    return out;
  }
  function visible(r) { return r.bottom > -80 && r.top < window.innerHeight + 80 && r.right > -80 && r.left < window.innerWidth + 80; }

  function play(st, first, last) {
    var opts = { duration: DUR, easing: EASE };
    Array.prototype.forEach.call(st.ol.children, function (li) {
      var id = li.getAttribute("data-vid"), f = first[id], l = last[id];
      if (!f || !l || (!visible(f.row) && !visible(l.row))) return;
      var dx = f.row.left - l.row.left, dy = f.row.top - l.row.top;
      li.animate([{ transform: "translate(" + dx + "px," + dy + "px)", opacity: .35 }, { transform: "none", opacity: 1 }], opts);
      var th = li.querySelector(".vrow__thumb");
      if (th && f.thumb && l.thumb && l.thumb.width) {
        var tx = (f.thumb.left - f.row.left) - (l.thumb.left - l.row.left);
        var ty = (f.thumb.top - f.row.top) - (l.thumb.top - l.row.top);
        var s = f.thumb.width / l.thumb.width;
        th.animate([{ transformOrigin: "0 0", transform: "translate(" + tx + "px," + ty + "px) scale(" + s + ")" },
                    { transformOrigin: "0 0", transform: "none" }], opts);
      }
      var inner = li.querySelectorAll(".vrow__info, .vrow__state");
      Array.prototype.forEach.call(inner, function (n) {
        n.animate([{ opacity: 0 }, { opacity: 0, offset: .35 }, { opacity: 1 }], opts);
      });
    });
  }
  function cancelAnims(st) {
    if (st.ol.getAnimations) st.ol.getAnimations({ subtree: true }).forEach(function (a) { try { a.cancel(); } catch (e) { /* ignore */ } });
  }

  /** Fade a fixed clone of the header away while the real one is hidden. */
  function ghostOf(node) {
    if (!canAnimate(node) || node.hidden) return;
    var r = node.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var g = node.cloneNode(true);
    Array.prototype.forEach.call(g.querySelectorAll("[id]"), function (n) { n.removeAttribute("id"); });
    Array.prototype.forEach.call(g.querySelectorAll("a, button, input, [tabindex]"), function (n) { n.setAttribute("tabindex", "-1"); });
    g.setAttribute("aria-hidden", "true");
    g.style.cssText = "position:fixed;margin:0;z-index:5;pointer-events:none;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
    document.body.appendChild(g);
    var a = g.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }], { duration: 240, easing: "ease-out", fill: "forwards" });
    a.onfinish = a.oncancel = function () { if (g.parentNode) g.parentNode.removeChild(g); };
  }

  /* ---------- the notes panel (content comes from C3's AQ.notesView) ---------- */
  function makeSwap(st, v) {
    var box = el("div", "spanel__swap");
    var mounted = null;
    function onClose() { close(); }
    try {
      if (AQ.notesView && typeof AQ.notesView.mount === "function") mounted = AQ.notesView.mount(box, v, { onClose: onClose });
    } catch (e) { mounted = null; box.textContent = ""; }
    if (!mounted && !box.firstChild) {
      var card = el("div", "spanel__fallback");
      card.appendChild(el("p", "eyebrow", "Lecture notes"));
      var h = el("h2", "spanel__ftitle", v.title);
      card.appendChild(h);
      card.appendChild(el("p", "muted", "The notes viewer is not available. You can still generate the notes here."));
      if (AQ.noteButton) { try { card.appendChild(AQ.noteButton(v, { onView: function () {} })); } catch (e) { /* ignore */ } }
      box.appendChild(card);
    }
    if (!box.querySelector(".nview__close, [data-close-notes]")) {
      var x = el("button", "spanel__close"); x.type = "button"; x.setAttribute("data-close-notes", "");
      x.setAttribute("aria-label", "Close notes"); x.textContent = "×";
      x.addEventListener("click", onClose);
      box.appendChild(x);
    }
    var sw = { el: box, vid: v.id, destroy: function () {
      if (mounted && typeof mounted.destroy === "function") { try { mounted.destroy(); } catch (e) { /* ignore */ } }
      mounted = null;
      if (box.parentNode) box.parentNode.removeChild(box);
    } };
    st.swaps.push(sw);
    return sw;
  }
  function dropSwap(st, sw) {
    sw.destroy();
    var i = st.swaps.indexOf(sw); if (i >= 0) st.swaps.splice(i, 1);
  }
  function headingOf(sw) {
    var h = sw.el.querySelector("h1, h2, h3") || sw.el;
    if (!h.hasAttribute("tabindex")) h.tabIndex = -1;
    return h;
  }

  /* ---------- list <-> nav mode ---------- */
  function navMode(st, on) {
    st.ol.classList.toggle("is-nav", on);
    st.root.classList.toggle("is-open", on);
    var v = viewEl(); if (v) v.classList.toggle("wrap--split", on);
    Array.prototype.forEach.call(st.ol.children, function (li) {
      li.draggable = !on;
      var th = li.querySelector(".vrow__thumb"), t = li.querySelector(".vrow__title");
      if (th && t) th.setAttribute("aria-label", (on ? "Open notes: " : "Watch: ") + t.textContent);
      if (!on) li.removeAttribute("aria-current");
    });
  }
  function markCurrent(st, vid) {
    Array.prototype.forEach.call(st.ol.children, function (li) {
      if (li.getAttribute("data-vid") === vid) li.setAttribute("aria-current", "true"); else li.removeAttribute("aria-current");
    });
  }
  function centerCurrent(st, vid) {
    var li = rowOf(st, vid); if (!li) return;
    var r = li.getBoundingClientRect(), pr = st.ol.getBoundingClientRect();
    if (st.ol.scrollHeight > st.ol.clientHeight) st.ol.scrollTop += r.top - pr.top - (pr.height - r.height) / 2;
    if (st.ol.scrollWidth > st.ol.clientWidth) st.ol.scrollLeft += r.left - pr.left - (pr.width - r.width) / 2;
  }
  function setHidden(st, hidden) { st.hide.forEach(function (n) { if (n) n.hidden = hidden; }); }

  /* ---------- open / close / switch ---------- */
  function openSplit(vid, animate) {
    var st = cur, v = findVideo(st.pid, vid);
    if (!v) return;
    animate = animate && canAnimate(st.root);
    flush(st);
    var first = null;
    if (animate) { cancelAnims(st); first = measure(st); st.hide.forEach(ghostOf); }
    setHidden(st, true);
    navMode(st, true);
    markCurrent(st, vid);
    st.vid = vid;
    var panel = el("section", "spanel");
    panel.setAttribute("aria-label", "Lecture notes: " + v.title);
    var sw = makeSwap(st, v);
    panel.appendChild(sw.el);
    st.panel = panel; st.swap = sw;
    st.root.appendChild(panel);
    if (animate) window.scrollTo(0, 0);
    centerCurrent(st, vid);
    if (animate) {
      play(st, first, measure(st));
      panel.animate([{ opacity: 0, transform: "translateX(" + Math.min(window.innerWidth * .4, 520) + "px)" }, { opacity: 1, transform: "none" }],
        { duration: DUR, easing: EASE });
      headingOf(sw).focus({ preventScroll: true });
      say("Notes: " + v.title);
    }
  }

  function closeSplit(animate) {
    var st = cur, vid = st.vid, panel = st.panel, sw = st.swap;
    if (!vid) return;
    animate = animate && canAnimate(st.root);
    flush(st);
    var first = null;
    if (animate) { cancelAnims(st); first = measure(st); }
    // the panel leaves the layout but stays visible while it slides out to the right
    if (panel) {
      if (animate) {
        var r = panel.getBoundingClientRect();
        panel.style.cssText = "position:fixed;margin:0;z-index:20;pointer-events:none;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
        panel.classList.add("is-leaving");
        st.leaving.push(panel);
        var a = panel.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(" + Math.min(window.innerWidth * .4, 520) + "px)" }],
          { duration: DUR, easing: EASE, fill: "forwards" });
        a.onfinish = a.oncancel = function () { removeLeaving(st, panel, sw); };
      } else removeLeaving(st, panel, sw);
    }
    st.panel = null; st.swap = null; st.vid = null; pushed = false;
    navMode(st, false);
    setHidden(st, false);
    var btn = rowOf(st, vid) && rowOf(st, vid).querySelector('[data-act="notes"]');
    if (btn && btn.focus) btn.focus();
    if (animate) {
      play(st, first, measure(st));
      st.hide.forEach(function (n) {
        if (n && n.animate) n.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 120, easing: EASE, fill: "backwards" });
      });
    }
  }
  function removeLeaving(st, panel, sw) {
    if (sw) dropSwap(st, sw);
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    var i = st.leaving.indexOf(panel); if (i >= 0) st.leaving.splice(i, 1);
  }
  /** finish any panel still sliding out (a quick re-open) and old crossfade layers */
  function flush(st) {
    st.leaving.slice().forEach(function (p) { p.getAnimations().forEach(function (a) { a.cancel(); }); if (p.parentNode) p.parentNode.removeChild(p); });
    st.leaving = [];
    st.swaps.slice().forEach(function (sw) { if (sw !== st.swap && !sw.el.parentNode) dropSwap(st, sw); });
  }

  function switchSplit(vid) {
    var st = cur, v = findVideo(st.pid, vid);
    if (!v || !st.panel) return;
    var old = st.swap, sw = makeSwap(st, v), animate = canAnimate(st.panel);
    st.vid = vid; st.swap = sw;
    markCurrent(st, vid);
    st.panel.setAttribute("aria-label", "Lecture notes: " + v.title);
    st.panel.appendChild(sw.el);
    centerCurrent(st, vid);
    if (animate) {
      sw.el.animate([{ opacity: 0, transform: "translateX(28px)" }, { opacity: 1, transform: "none" }], { duration: DUR, easing: EASE });
      var a = old.el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-28px)" }], { duration: 320, easing: "ease-in", fill: "forwards" });
      old.el.style.pointerEvents = "none";
      a.onfinish = a.oncancel = function () { dropSwap(st, old); };
    } else dropSwap(st, old);
    say("Notes: " + v.title);
  }

  function sync() {
    var st = cur;
    if (!st || !st.root.isConnected) return;
    var r = parse();
    var want = r && r.pid === st.pid && r.vid && findVideo(st.pid, r.vid) ? r.vid : null;
    if (want === st.vid) return;
    if (!want) closeSplit(true);
    else if (!st.vid) openSplit(want, true);
    else switchSplit(want);
  }

  /* ---------- public ---------- */
  function open(video) {
    var st = cur;
    if (!st || !st.root.isConnected || !video) return;
    if (st.vid === video.id) { if (st.swap) headingOf(st.swap).focus({ preventScroll: true }); return; }
    var url = "#/playlist/" + st.pid + "/notes/" + video.id;
    if (st.vid) history.replaceState(null, "", url);
    else { pushed = true; history.pushState(null, "", url); }
    sync();
  }
  function close() {
    var st = cur;
    if (!st || !st.vid) return;
    if (pushed) { history.back(); return; }          // hashchange -> sync() runs the closing animation
    history.replaceState(null, "", "#/playlist/" + st.pid);
    sync();
  }

  function reset() {
    var st = cur; cur = null;
    if (!st) return;
    if (st.unsub) { try { st.unsub(); } catch (e) { /* ignore */ } }
    st.swaps.slice().forEach(function (sw) { sw.destroy(); });
    st.swaps = [];
    var v = viewEl(); if (v) v.classList.remove("wrap--split");
  }

  function shell(o) {
    var p = o.playlist, prev = cur;
    reset();
    if (!prev || prev.pid !== p.id) pushed = false;
    var root = el("div", "split");
    var nav = el("div", "snav");
    var head = el("div", "snav__head");
    head.appendChild(el("p", "snav__name", p.name));
    head.appendChild(el("p", "snav__count muted", u.statsText(p)));
    nav.appendChild(head);
    nav.appendChild(o.list);
    root.appendChild(nav);
    var st = cur = { pid: p.id, root: root, ol: o.list, hide: o.hide || [], vid: null, panel: null, swap: null, swaps: [], leaving: [], unsub: null };
    decorate(st);
    if (AQ.notesJobs && typeof AQ.notesJobs.subscribe === "function") {
      st.unsub = AQ.notesJobs.subscribe(function () { if (cur === st && st.root.isConnected) paintDots(st); });
    }
    // clicks in nav mode open that video's notes instead of the row's normal action
    o.list.addEventListener("click", function (e) {
      if (!st.vid) return;
      var li = e.target.closest && e.target.closest(".vrow");
      if (!li) return;
      e.stopPropagation(); e.preventDefault();
      var v = findVideo(st.pid, li.getAttribute("data-vid"));
      if (v) open(v);
    }, true);
    if (o.openId && findVideo(p.id, o.openId)) openSplit(o.openId, false);
    else if (o.openId) { try { history.replaceState(null, "", "#/playlist/" + p.id); } catch (e) { /* ignore */ } }
    return root;
  }

  window.addEventListener("hashchange", function () { if (owns()) sync(); });
  window.addEventListener("popstate", function () { if (owns()) sync(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented || !cur || !cur.vid) return;
    if (AQ.dialog && AQ.dialog.isOpen && AQ.dialog.isOpen()) return;
    close();
  });

  AQ.split = { shell: shell, open: open, close: close, reset: reset, owns: owns };
})();
