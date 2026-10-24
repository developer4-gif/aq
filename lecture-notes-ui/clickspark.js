/* AQ Learning - click spark (vanilla take on React Bits <ClickSpark />).
   A press anywhere useful sends ~8 thin silver lines radiating a short way from the pointer, ease-out, ~420ms.
   One fixed, click-through canvas is created lazily, drawn only while sparks are alive (rAF stops, canvas clears
   and hides when idle). Skipped for text fields, selects, iframes, anything inside [data-no-spark] and
   under prefers-reduced-motion.
   API:  AQ.clickspark.exclude(selector)   opt a CSS selector out (also: data-no-spark attribute)
         AQ.clickspark.spark(x, y)         fire one from code (client px; viewport centre when omitted)
         AQ.clickspark.configure({count, duration, reach, inner, length, width, alpha}) */
(function () {
  "use strict";

  var cfg = { count: 8, duration: 420, inner: 5, reach: 20, length: 9, width: 1.25, alpha: 0.6 };
  var COLORS = ["rgba(255,255,255,", "rgba(201,204,209,"];   // white + soft silver (alpha appended per frame)
  var MAX_BURSTS = 6, MAX_SPARKS = 16, TAU = Math.PI * 2;
  var excludes = ["input", "textarea", "select", "iframe", "[contenteditable]:not([contenteditable=false])",
                  "[data-no-spark]", ".cspark-off"];
  var selector = excludes.join(",");

  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  // Fixed pool: no per-frame (or per-click) allocations.
  var pool = [], i, j;
  for (i = 0; i < MAX_BURSTS; i++) {
    var b = { on: false, x: 0, y: 0, t0: 0, ang: new Float32Array(MAX_SPARKS), reach: new Float32Array(MAX_SPARKS) };
    pool.push(b);
  }

  var canvas = null, ctx = null, dpr = 1, vw = 0, vh = 0, raf = 0, lastPress = { t: -1e9, x: 0, y: 0 };

  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
  }

  function ensureCanvas() {
    if (canvas && canvas.isConnected) {
      if (vw !== window.innerWidth || vh !== window.innerHeight || dpr !== Math.min(window.devicePixelRatio || 1, 2)) sizeCanvas();
      return true;
    }
    if (!document.body) return false;
    canvas = document.createElement("canvas");
    canvas.id = "clickspark";
    canvas.className = "cspark";
    canvas.setAttribute("aria-hidden", "true");
    ctx = canvas.getContext("2d");
    if (!ctx) { canvas = null; return false; }
    sizeCanvas();
    document.body.appendChild(canvas);
    return true;
  }

  function easeOut(t) { var u = 1 - t; return 1 - u * u * u; }

  function frame(now) {
    raf = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.lineCap = "round";
    ctx.lineWidth = cfg.width;
    var alive = 0, n = Math.min(cfg.count, MAX_SPARKS);
    for (var bi = 0; bi < pool.length; bi++) {
      var bu = pool[bi];
      if (!bu.on) continue;
      var p = (now - bu.t0) / cfg.duration;
      if (p >= 1) { bu.on = false; continue; }
      if (p < 0) p = 0;
      alive++;
      var e = easeOut(p);
      var head = cfg.inner + cfg.reach * e;                 // leading end, travels inner -> inner+reach
      var tail = head - cfg.length * (1 - p * 0.85) ;       // trailing end follows; line shortens as it flies
      if (tail < cfg.inner * e) tail = cfg.inner * e;
      var a = cfg.alpha * Math.pow(1 - p, 1.4);
      for (var s = 0; s < n; s++) {
        var ang = bu.ang[s], c = Math.cos(ang), sn = Math.sin(ang), k = bu.reach[s];
        ctx.strokeStyle = COLORS[s & 1] + a.toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(bu.x + c * tail * k, bu.y + sn * tail * k);
        ctx.lineTo(bu.x + c * head * k, bu.y + sn * head * k);
        ctx.stroke();
      }
    }
    if (alive) raf = requestAnimationFrame(frame);
    else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = "none"; }
  }

  function spawn(x, y) {
    if (reduce.matches || !isFinite(x) || !isFinite(y) || !ensureCanvas()) return;
    var bu = null, oldest = pool[0];
    for (i = 0; i < pool.length; i++) {
      if (!pool[i].on) { bu = pool[i]; break; }
      if (pool[i].t0 < oldest.t0) oldest = pool[i];
    }
    if (!bu) bu = oldest;                                  // cap: recycle the oldest burst
    var n = Math.min(cfg.count, MAX_SPARKS), rot = Math.random() * TAU, step = TAU / n;
    for (j = 0; j < n; j++) {
      bu.ang[j] = rot + step * j + (Math.random() - 0.5) * step * 0.35;
      bu.reach[j] = 0.85 + Math.random() * 0.3;
    }
    bu.x = x; bu.y = y; bu.t0 = performance.now(); bu.on = true;
    canvas.style.display = "block";
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function blocked(target) {
    if (!(target instanceof Element)) return false;
    try { return !!target.closest(selector); } catch (err) { return false; }
  }

  // Mouse/pen: on press (feels instant). Touch + keyboard: on the click that follows (a scroll sends no click).
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch" || (e.button !== undefined && e.button !== 0) || blocked(e.target)) return;
    lastPress.t = performance.now(); lastPress.x = e.clientX; lastPress.y = e.clientY;
    spawn(e.clientX, e.clientY);
  }, true);

  document.addEventListener("click", function (e) {
    if (blocked(e.target)) return;
    if (!e.detail && !e.clientX && !e.clientY) {            // keyboard-activated: burst from the control's centre
      var t = e.target;
      if (!(t instanceof Element) || t === document.body || t === document.documentElement) return;
      var r = t.getBoundingClientRect();
      if (r.width && r.height) spawn(r.left + r.width / 2, r.top + r.height / 2);
      return;
    }
    if (performance.now() - lastPress.t < 700 && Math.abs(e.clientX - lastPress.x) < 12 && Math.abs(e.clientY - lastPress.y) < 12) return;
    spawn(e.clientX, e.clientY);                            // touch
  }, true);

  window.AQ = window.AQ || {};
  window.AQ.clickspark = {
    exclude: function (sel) {
      if (typeof sel !== "string" || !sel) return;
      try { document.createDocumentFragment().querySelector(sel); } catch (err) { return; }
      if (excludes.indexOf(sel) < 0) { excludes.push(sel); selector = excludes.join(","); }
    },
    spark: function (x, y) { spawn(x == null ? window.innerWidth / 2 : x, y == null ? window.innerHeight / 2 : y); },
    configure: function (o) { for (var key in o) if (key in cfg && typeof o[key] === "number") cfg[key] = o[key]; }
  };
})();
