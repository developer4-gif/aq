/* AQ Learning - "Smart arrange" magic: the glass button + the click choreography (smartmagic.css has the looks).

   One Smart arrange click runs this sequence (the real run itself - POST / poll - stays in smart.js; this file only drives visuals
   from it and tells smart.js when to reveal):
     charge   >= 3 s, and until the run is ready: the sparkle spins up, a purple/pink glow gathers under the glass and small
              silver / purple motes are pulled into the button (one fixed canvas, a pooled handful of particles).
     burst    a shock ring + particles leave the button (+ the global silver click spark), the button pops, and the playlist's
              video rows glide to the recommended order (FLIP, staggered, ~600 ms), the moved rows glow briefly.
     reveal   when the glide is done smart.js shows the panel and the toast ("Videos arranged for ...", Undo).
   A cached result still shows the whole 3 s. An error skips the burst (calm: smart.js shows the error + Retry).
   Nothing runs unless a sequence is active; the rAF loop and the canvas go away when it ends, when the user leaves the playlist
   or when the button is gone. prefers-reduced-motion: no spin / motes / burst / glide - the 3 s is skipped and the order jumps.

   API (used by smart.js):
     AQ.smartmagic.button(pid, iconNode, onClick)  -> <button class="wbtn smart-wbtn"> (AQ.water liquid glass; click -> onClick)
     AQ.smartmagic.paint(pid, btn)                 re-apply the sequence look to a (re-created) button
     AQ.smartmagic.begin(pid, cb)                  the user started a run. cb = { reorder(flip) -> {state, ms, ...}, reveal(res), abort(), paint() }
     AQ.smartmagic.finish(pid, ok)                 the run ended (ok = a usable result is in); burst once the 3 s have passed
     AQ.smartmagic.abort(pid)                      the user left: drop everything, no reorder
     AQ.smartmagic.phase(pid)                      "" | "charge" | "burst"
     AQ.smartmagic.flip(fn) -> ms                  run fn() (a store reorder that re-renders the page) and glide the video rows
                                                   from where they were to where they are now */
(function () {
  "use strict";
  var AQ = window.AQ = window.AQ || {};

  var MIN_MS = 3000, FLIP_MS = 600, STAGGER_MS = 40, EASE = "cubic-bezier(.2,.7,.2,1)";
  var TAU = Math.PI * 2, MAX_PARTS = 96;
  var COLORS = ["201,204,209", "255,255,255", "167,139,250", "244,114,182"];   // silver, white, purple, pink (rgb; alpha per frame)

  var seqs = {};        // pid -> the running sequence
  var regs = {};        // pid -> buttons created for it (only connected ones are kept)
  var fx = null;        // { canvas, ctx, dpr, w, h }
  var pool = [], ring = [];

  function reduced() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ease(t) { var k = 1 - t; return 1 - k * k * k; }
  function pageId() {
    var m = /^#\/playlist\/([a-z0-9-]{1,48})(?:\/notes\/[A-Za-z0-9_-]{11})?\/?$/.exec(location.hash || "");
    return m ? m[1] : null;
  }

  /* ---------- the button ---------- */
  function current(pid) {
    var list = regs[pid] = (regs[pid] || []).filter(function (b) { return b.isConnected; });
    return list.length ? list[list.length - 1] : null;
  }
  function shown(b) { return !!(b && b.isConnected && b.getClientRects().length); }

  function button(pid, iconNode, onClick) {
    var b = AQ.water.button("Smart arrange", { iconNode: iconNode, cls: "smart-wbtn", onActivate: function () { onClick(); } });
    b.setAttribute("data-act", "smart");
    var list = regs[pid] = (regs[pid] || []).filter(function (x) { return x.isConnected; });
    list.push(b);
    if (list.length > 6) list.shift();
    return b;
  }

  /** Classes + custom properties of one button for the current phase (cheap: only changed values are written). */
  function paint(pid, b) {
    var s = seqs[pid], ph = s ? s.phase : "";
    b.classList.toggle("is-charging", ph === "charge");
    b.classList.toggle("is-burst", ph === "burst");
    if (s) {
      b.style.setProperty("--ch", s.ch.toFixed(3));
      b.style.setProperty("--sp", (s.spin % 360).toFixed(1));
      b.style.setProperty("--bf", s.bf.toFixed(3));
      b._m = true;
    } else if (b._m) {
      b.style.removeProperty("--ch"); b.style.removeProperty("--sp"); b.style.removeProperty("--bf");
      b._m = false;
    }
  }
  function paintAll(s) {
    var list = regs[s.pid] || [];
    for (var i = 0; i < list.length; i++) if (list[i].isConnected) paint(s.pid, list[i]);
  }

  /* ---------- FLIP: glide the video rows to their new places ---------- */
  function rowRects(list) {
    var out = {};
    Array.prototype.forEach.call(list.children, function (li) { out[li.getAttribute("data-vid")] = li.getBoundingClientRect(); });
    return out;
  }
  function listEl() { return document.querySelector("#view .vlist"); }

  function flip(fn, lead) {                         // lead: ms to wait before the first row moves (the page is scrolling the list into view)
    var list = listEl(), first = list && !reduced() ? rowRects(list) : null;
    fn();                                           // the store reorder: the page re-renders (synchronously, new nodes)
    if (!first) return 0;
    list = listEl();
    if (!list || typeof list.animate !== "function") return 0;                  // old browser: the rows simply jump
    var moved = [];
    Array.prototype.forEach.call(list.children, function (li) {
      var f = first[li.getAttribute("data-vid")];
      if (!f) return;
      var l = li.getBoundingClientRect(), dx = f.left - l.left, dy = f.top - l.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      moved.push({ li: li, dx: dx, dy: dy });
    });
    if (!moved.length) return 0;
    var step = Math.min(STAGGER_MS, 360 / Math.max(1, moved.length - 1));
    moved.forEach(function (m, k) {
      var delay = Math.round(k * step) + (lead || 0);
      m.li.style.setProperty("--d", delay + "ms");
      m.li.classList.add("smart-moved");            // brief highlight once it has landed (CSS, delayed by --d)
      m.li.animate([{ transform: "translate(" + m.dx + "px," + m.dy + "px)" }, { transform: "none" }],
                   { duration: FLIP_MS, delay: delay, easing: EASE, fill: "backwards" });
    });
    return (lead || 0) + FLIP_MS + Math.round((moved.length - 1) * step);
  }

  /* ---------- canvas: motes + burst ---------- */
  function ensureFx() {
    if (fx && fx.canvas.isConnected) return fx;
    if (!document.body) return null;
    var c = document.createElement("canvas");
    c.className = "smart-fx"; c.setAttribute("aria-hidden", "true");
    var ctx = c.getContext("2d");
    if (!ctx) return null;
    document.body.appendChild(c);
    fx = { canvas: c, ctx: ctx, dpr: 1, w: 0, h: 0 };
    return fx;
  }
  function sizeFx() {
    var d = Math.min(window.devicePixelRatio || 1, 2), w = window.innerWidth, h = window.innerHeight;
    if (d === fx.dpr && w === fx.w && h === fx.h && fx.canvas.width) return;
    fx.dpr = d; fx.w = w; fx.h = h;
    fx.canvas.width = Math.round(w * d); fx.canvas.height = Math.round(h * d);
  }
  function dropFx() {
    if (fx && fx.canvas.parentNode) fx.canvas.parentNode.removeChild(fx.canvas);
    fx = null;
  }
  for (var pi = 0; pi < MAX_PARTS; pi++) pool.push({ on: false, kind: 0, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, a0: 0, w: 0, d0: 0, age: 0, life: 1, size: 1, col: 0 });

  function grab() {
    for (var i = 0; i < pool.length; i++) if (!pool[i].on) return pool[i];
    return null;
  }
  function spawnMote(s, strength) {
    var p = grab();
    if (!p) return;
    p.on = true; p.kind = 0; p.age = 0; p.life = 0.9 + Math.random() * 0.7;
    p.a0 = Math.random() * TAU; p.w = (Math.random() < 0.5 ? -1 : 1) * (1.4 + Math.random() * 1.8);
    p.d0 = 55 + Math.random() * (50 + 40 * strength);
    p.size = 1 + Math.random() * 1.3;
    p.col = Math.random() < 0.55 ? 0 : Math.random() < 0.6 ? 2 : 3;
    p.px = p.py = NaN;
  }
  function spawnBurst(r) {
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2, n = 30;
    for (var i = 0; i < n; i++) {
      var p = grab();
      if (!p) break;
      var a = Math.random() * TAU, sp = 160 + Math.random() * 300;
      p.on = true; p.kind = 1; p.age = 0; p.life = 0.55 + Math.random() * 0.5;
      p.x = cx + Math.cos(a) * r.width * 0.42; p.y = cy + Math.sin(a) * r.height * 0.42;     // leave from the rim of the pill
      p.px = p.x; p.py = p.y;
      p.vx = Math.cos(a) * sp * 1.15; p.vy = Math.sin(a) * sp * 0.85;
      p.size = 1.2 + Math.random() * 1.6;
      p.col = Math.random() < 0.4 ? 1 : Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? 2 : 3;
    }
    ring.length = 0;
    ring.push({ t0: performance.now(), cx: cx, cy: cy, hw: r.width / 2, hh: r.height / 2, col: "255,255,255", delay: 0 });
    ring.push({ t0: performance.now(), cx: cx, cy: cy, hw: r.width / 2, hh: r.height / 2, col: "196,160,255", delay: 110 });
  }
  function anyAlive() {
    for (var i = 0; i < pool.length; i++) if (pool[i].on) return true;
    return ring.length > 0;
  }
  function clearFx() {
    for (var i = 0; i < pool.length; i++) pool[i].on = false;
    ring.length = 0;
  }

  function drawFx(s, now, dt, r) {
    if (!fx || !fx.canvas.isConnected) return;
    sizeFx();
    var ctx = fx.ctx;
    ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
    ctx.clearRect(0, 0, fx.w, fx.h);
    ctx.lineCap = "round";
    var cx = r ? r.left + r.width / 2 : 0, cy = r ? r.top + r.height / 2 : 0, hw = r ? r.width / 2 : 0, hh = r ? r.height / 2 : 0;
    var damp = Math.exp(-3.2 * dt);
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (!p.on) continue;
      p.age += dt;
      var k = p.age / p.life, al;
      if (k >= 1 || (p.kind === 0 && !r)) { p.on = false; continue; }
      if (p.kind === 0) {                           // a mote spirals in toward the pill and fades as it lands
        var d = p.d0 * Math.pow(1 - k, 1.7), a = p.a0 + p.w * p.age;
        p.x = cx + Math.cos(a) * (hw * 0.95 + d); p.y = cy + Math.sin(a) * (hh * 1.05 + d * 0.7);
        al = Math.pow(Math.sin(k * Math.PI), 0.7) * (0.35 + 0.55 * s.ch);
      } else {                                      // a burst particle flies out and slows down
        p.vx *= damp; p.vy *= damp; p.x += p.vx * dt; p.y += p.vy * dt;
        al = Math.pow(1 - k, 1.4) * 0.95;
      }
      if (p.px !== p.px) { p.px = p.x; p.py = p.y; }  // first frame of a mote: no trail yet
      var tl = Math.sqrt((p.x - p.px) * (p.x - p.px) + (p.y - p.py) * (p.y - p.py));
      if (tl > 9) { p.px = p.x - (p.x - p.px) / tl * 9; p.py = p.y - (p.y - p.py) / tl * 9; }   // short comet tails, whatever the frame rate
      ctx.strokeStyle = "rgba(" + COLORS[p.col] + "," + al.toFixed(3) + ")";
      ctx.lineWidth = p.size * (p.kind ? 1 - k * 0.5 : 1);
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
      p.px = p.x; p.py = p.y;
    }
    for (var j = ring.length - 1; j >= 0; j--) {    // shock rings: a soft ellipse expanding off the pill
      var g = ring[j], pr = (now - g.t0 - g.delay) / 650;
      if (pr >= 1) { ring.splice(j, 1); continue; }
      if (pr < 0) continue;
      var e = ease(pr);
      ctx.strokeStyle = "rgba(" + g.col + "," + (0.55 * Math.pow(1 - pr, 1.5)).toFixed(3) + ")";
      ctx.lineWidth = 0.6 + 2.2 * (1 - pr);
      ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.hw + 6 + e * 150, g.hh + 6 + e * 110, 0, 0, TAU); ctx.stroke();
    }
  }

  /* ---------- the sequence ---------- */
  function stopLoop(s) {
    if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; }
  }
  function end(s) {                                 // the sequence is over (or dropped): nothing may stay behind
    stopLoop(s);
    if (seqs[s.pid] === s) delete seqs[s.pid];
    s.phase = "";
    paintAll(s);
    if (!Object.keys(seqs).length) { clearFx(); dropFx(); }
    try { s.cb.paint(); } catch (e) { if (window.console) console.error(e); }   // label back to "Smart arrange"
  }
  function alive(s) {
    return pageId() === s.pid && !!current(s.pid);
  }
  function refocus(s) {                             // a re-render drops focus: give it back to the (new) button
    var b = current(s.pid);
    if (s.focus && b && (document.activeElement === document.body || !document.activeElement)) b.focus({ preventScroll: true });
  }

  /** The learning-path panel sits above the list, so the rows can be far below the fold: bring them into view as the burst starts. */
  function scrollToList() {
    var list = listEl(), row = list && list.firstElementChild;
    if (!row) return 0;
    var top = row.getBoundingClientRect().top;
    if (top < window.innerHeight * 0.55 && top > 70) return 0;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - 130), behavior: reduced() ? "auto" : "smooth" });
    return reduced() ? 0 : 380;
  }

  function burst(s, now) {
    s.phase = "burst"; s.tb = now;
    var res = { state: "none", ms: 0 };
    try { s.cb.paint(); } catch (e) { if (window.console) console.error(e); }
    try { res = s.cb.reorder(function (fn) { return flip(fn, scrollToList()); }) || res; } catch (e) { if (window.console) console.error(e); }   // (scrolls only when rows really move)
    s.res = res;
    refocus(s);
    var b = current(s.pid), r = shown(b) ? b.getBoundingClientRect() : null;
    if (r && !reduced()) {
      ensureFx();
      spawnBurst(r);
      if (AQ.clickspark && AQ.clickspark.spark) AQ.clickspark.spark(r.left + r.width / 2, r.top + r.height / 2);
      if (b.animate) b.animate([{ scale: "1" }, { scale: "1.1", offset: 0.28 }, { scale: "1" }], { duration: 520, easing: EASE });
    }
    s.bf = 1;
    s.revealAt = now + (res.state === "moved" ? res.ms + 140 : 520);
    paintAll(s);
  }
  function reveal(s) {
    if (s.revealed) return;
    s.revealed = true;
    try { s.cb.reveal(s.res || { state: "none" }); } catch (e) { if (window.console) console.error(e); }
    refocus(s);
  }

  function tick(now) {
    var s = this;
    s.raf = 0;
    if (seqs[s.pid] !== s) return;
    if (!alive(s)) { abort(s.pid); return; }
    var dt = clamp((now - s.last) / 1000 || 0.016, 0.001, 0.05); s.last = now;
    var t = now - s.t0, b = current(s.pid), r = shown(b) ? b.getBoundingClientRect() : null;
    var ae = document.activeElement;
    if (ae && ae !== document.body) s.focus = !!(b && b.contains(ae)) || (ae.closest && !!ae.closest(".smart-wbtn"));

    if (s.phase === "charge") {
      s.ch = ease(clamp(t / MIN_MS, 0, 1));
      var breath = t > MIN_MS ? 0.06 * Math.sin((t - MIN_MS) / 240) : 0;
      s.spin += (50 + 820 * s.ch * s.ch) * dt;
      if (r && ensureFx()) {
        s.acc += (7 + 46 * s.ch) * dt;              // motes per second grow while the glow gathers
        while (s.acc >= 1) { s.acc -= 1; spawnMote(s, s.ch); }
      }
      s.ch = clamp(s.ch + breath, 0, 1.06);
      if (s.ok === true && t >= MIN_MS) burst(s, now);
    } else {
      s.bf = Math.max(0, 1 - (now - s.tb) / 520);
      s.ch = Math.max(0, s.ch - dt * 1.8);
      s.spin += 700 * dt * s.ch;
      if (!s.revealed && now >= s.revealAt) reveal(s);
    }
    paintAll(s);
    if (fx) drawFx(s, now, dt, r);
    if (s.phase === "burst" && s.revealed && s.ch <= 0.001 && s.bf <= 0 && !anyAlive()) { end(s); return; }
    s.raf = requestAnimationFrame(s.step);
  }

  function begin(pid, cb) {
    if (seqs[pid]) return false;
    var s = seqs[pid] = { pid: pid, cb: cb, phase: "charge", t0: performance.now(), last: performance.now(), ok: undefined, ch: 0, bf: 0, spin: 0, acc: 0,
                          tb: 0, revealAt: 0, revealed: false, res: null, focus: false, raf: 0, step: null };
    s.step = tick.bind(s);
    if (reduced()) { s.ch = 1; paintAll(s); return true; }   // static glow, no loop
    paintAll(s);
    s.raf = requestAnimationFrame(s.step);
    return true;
  }

  function finish(pid, ok) {
    var s = seqs[pid];
    if (!s || s.ok !== undefined) return;
    s.ok = !!ok;
    if (!ok) {                                      // error: calm, no burst - smart.js shows the message + Retry
      s.revealed = true;
      try { s.cb.reveal({ state: "error" }); } catch (e) { if (window.console) console.error(e); }
      end(s);
      return;
    }
    if (reduced()) {                                // no 3 s, no glide: the order simply changes
      s.phase = "burst"; s.res = { state: "none", ms: 0 };
      try { s.res = s.cb.reorder(flip) || s.res; } catch (e) { if (window.console) console.error(e); }
      reveal(s);
      end(s);
    }
  }

  function abort(pid) {
    var s = seqs[pid];
    if (!s) return;
    stopLoop(s);
    var done = s.revealed;
    s.revealed = true;
    if (!done) { try { s.cb.abort(); } catch (e) { if (window.console) console.error(e); } }
    end(s);
  }

  AQ.smartmagic = {
    button: button, paint: paint, begin: begin, finish: finish, abort: abort, flip: flip,
    phase: function (pid) { return seqs[pid] ? seqs[pid].phase : ""; }
  };
})();
