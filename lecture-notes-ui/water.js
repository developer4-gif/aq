/* AQ Learning - "liquid glass" button (Apple iOS 26 style).

   Material: a thick clear lens over the dark page. The page behind it is refracted through an SVG
   feDisplacementMap that is driven by a displacement map generated at runtime (canvas -> data URL, sized to the
   button), with a slight per-channel (chromatic) offset, applied with backdrop-filter: url(#id). Chromium/Edge
   only; other browsers fall back to a frosted blur + the same highlights.
   Hover:  the lens swells with a spring (overshoot), the specular rim and a soft highlight follow the pointer,
           the body stretches toward it and wobbles like a viscous drop (damped springs, not noise).
   Click:  the rim brightens briefly and the refraction swells a touch (jelly press: the button never shrinks); the form
           opens immediately and the global click spark (clickspark.js) is the click effect.
   Idle:   no work. The spring loop stops as soon as everything has settled, even while the pointer rests on it;
           the button rect is cached (re-read only after scroll/resize or on enter).
   Reduced motion: static glass, no animation, the action runs immediately.

   AQ.water.button(label, { icon: "plus", onActivate: fn }) -> <button> */
(function () {
  "use strict";
  var u = AQ.util, el = u.el;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SVGNS = "http://www.w3.org/2000/svg";
  var ua = navigator.userAgent || "";
  var CAN_REFRACT = /\b(Chrome|Chromium|Edg)\//.test(ua) && !/Firefox\//.test(ua);   // SVG url() in backdrop-filter

  /* shared geometry epoch: cached button rects are re-read after any scroll / resize (one listener for all buttons) */
  var epoch = 0;
  function bump() { epoch++; }
  window.addEventListener("scroll", bump, { passive: true, capture: true });
  window.addEventListener("resize", bump, { passive: true });

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---------- damped spring (semi-implicit Euler, sub-stepped) ---------- */
  function Spring(x, k, c, eps) { this.x = x; this.v = 0; this.t = x; this.k = k; this.c = c; this.e = eps || 0.0015; }
  Spring.prototype.step = function (dt) {
    this.v += (this.k * (this.t - this.x) - this.c * this.v) * dt;
    this.x += this.v * dt;
  };
  Spring.prototype.settled = function () { return Math.abs(this.v) < this.e * 12 && Math.abs(this.t - this.x) < this.e; };

  /* ---------- shared SVG defs: one lens filter per button ---------- */
  var defs = null;
  var registry = [];
  function getDefs() {
    if (defs && defs.isConnected) return defs;
    var svg = svgEl("svg", { "aria-hidden": "true", width: "0", height: "0", focusable: "false" });
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    defs = svgEl("defs", {});
    svg.appendChild(defs);
    document.body.appendChild(svg);

    return defs;
  }

  /* Displacement map for a pill of w x h CSS px (drawn at 2x). RG encode the per-pixel offset, 128 = none.
     Offset(px) = toward the inside along the edge normal, growing steeply across the bevel (the glass rim
     bends the page), plus a mild uniform magnification toward the centre (the flat lens body). */
  var SMAX = 48;   // px that a fully encoded channel value stands for (the filter's `scale` multiplies this)
  function buildMap(w, h) {
    var S = 2, cw = Math.round(w * S), ch = Math.round(h * S);
    var c = document.createElement("canvas"); c.width = cw; c.height = ch;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(cw, ch), d = img.data;
    var r = ch / 2, bevel = r * 0.9, EDGE = 21, KMAG = 0.11;
    for (var y = 0; y < ch; y++) {
      for (var x = 0; x < cw; x++) {
        var px = x + 0.5, py = y + 0.5;
        var qx = clamp(px, r, cw - r), vx = px - qx, vy = py - r;
        var dist = Math.sqrt(vx * vx + vy * vy), din = r - dist;
        var dx = 0, dy = 0;
        if (din > 0) {
          var t = 1 - clamp(din / bevel, 0, 1);
          var m = Math.pow(t, 2.2) * EDGE;
          var nx = dist > 0.001 ? vx / dist : 0, ny = dist > 0.001 ? vy / dist : 0;
          dx = -nx * m - (px - cw / 2) / S * KMAG;
          dy = -ny * m - (py - ch / 2) / S * KMAG;
        }
        var i = (y * cw + x) * 4;
        d[i] = Math.round(128 + 127 * clamp(dx / SMAX, -1, 1));
        d[i + 1] = Math.round(128 + 127 * clamp(dy / SMAX, -1, 1));
        d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }

  var filterSeq = 0;
  function makeLens() {
    var id = "aq-glass-" + (++filterSeq);
    var f = svgEl("filter", { id: id, filterUnits: "userSpaceOnUse", x: "0", y: "0", width: "10", height: "10", "color-interpolation-filters": "sRGB" });
    var image = svgEl("feImage", { x: "0", y: "0", width: "10", height: "10", preserveAspectRatio: "none", result: "map" });
    f.appendChild(image);
    var disp = [];
    [["R", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"], ["G", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1"], ["B", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1"]].forEach(function (ch) {
      f.appendChild(disp[disp.length] = svgEl("feDisplacementMap", { "in": "SourceGraphic", in2: "map", scale: "0", xChannelSelector: "R", yChannelSelector: "G", result: "d" + ch[0] }));
      f.appendChild(svgEl("feColorMatrix", { "in": "d" + ch[0], type: "matrix", values: ch[1], result: "c" + ch[0] }));
    });
    f.appendChild(svgEl("feBlend", { "in": "cR", in2: "cG", mode: "screen", result: "rg" }));
    f.appendChild(svgEl("feBlend", { "in": "rg", in2: "cB", mode: "screen" }));
    getDefs().appendChild(f);
    var rec = { id: id, node: f, image: image, disp: disp, born: Date.now(), btn: null };
    registry.push(rec);
    return rec;
  }
  function sweep() {   // drop lenses of buttons that left the DOM (the screen is re-rendered on every route)
    var now = Date.now();
    registry = registry.filter(function (r) {
      if (r.btn && !r.btn.isConnected && now - r.born > 3000) { r.node.remove(); return false; }
      return true;
    });
  }
  // per-channel strength: blue bends a touch more than red -> slight chromatic fringe on the rim
  var CH = [0.9, 1.0, 1.11];
  function setLens(rec, k) {
    if (rec.k != null && Math.abs(rec.k - k) < 0.004) return;   // skip no-op SVG attribute writes (each one re-runs the backdrop filter)
    rec.k = k;
    for (var i = 0; i < 3; i++) rec.disp[i].setAttribute("scale", (SMAX * CH[i] * k).toFixed(2));
  }

  /* ---------- the button ---------- */
  function button(label, opts) {
    opts = opts || {};
    sweep();
    var btn = el("button", "wbtn");
    btn.type = "button";
    var glass = el("span", "wbtn__glass"), spot = el("span", "wbtn__spot"), rim = el("span", "wbtn__rim");
    var face = el("span", "wbtn__face");
    if (opts.icon) face.appendChild(u.icon(opts.icon));
    face.appendChild(el("span", "wbtn__label", label));
    [glass, spot, rim, face].forEach(function (n) { btn.appendChild(n); });
    function activate() { opts.onActivate && opts.onActivate(btn); }

    /* lens (refraction) - needs the real size, so it is (re)built when the button is laid out */
    var lens = null, lensK = 1;
    if (CAN_REFRACT && typeof ResizeObserver === "function") {
      var lw = 0, lh = 0;
      new ResizeObserver(function () {
        var w = btn.offsetWidth, h = btn.offsetHeight;
        if (!w || !h || (w === lw && h === lh)) return;
        lw = w; lh = h;
        if (!lens) { lens = makeLens(); lens.btn = btn; }
        lens.node.setAttribute("width", w); lens.node.setAttribute("height", h);
        lens.image.setAttribute("width", w); lens.image.setAttribute("height", h);
        lens.image.setAttribute("href", buildMap(w, h));
        setLens(lens, lensK);
        var v = "url(#" + lens.id + ") blur(0.6px) saturate(1.55) brightness(1.14) contrast(1.05)";
        glass.style.webkitBackdropFilter = v; glass.style.backdropFilter = v;
      }).observe(btn);
    }

    if (reduced) {   // static glass, no motion, immediate action
      btn.addEventListener("click", activate);
      return btn;
    }

    /* ----- state ----- */
    var sx = new Spring(1, 230, 12), sy = new Spring(1, 230, 12);      // jelly scale (zeta ~0.4: visible overshoot)
    var tx = new Spring(0, 170, 15), ty = new Spring(0, 170, 15);      // pull toward the pointer
    var sk = new Spring(0, 190, 8, 0.002);                              // viscous shear wobble (deg)
    var hv = new Spring(0, 140, 18, 0.002);                             // hover amount (drives highlight)
    var lx = new Spring(-0.7, 80, 13, 0.002), ly = new Spring(-0.7, 80, 13, 0.002);   // light direction (rim)
    var mx = new Spring(0, 260, 28, 0.05), my = new Spring(0, 260, 28, 0.05);         // highlight position (px)
    var di = new Spring(1, 220, 17, 0.003);                             // refraction strength
    var fl = new Spring(0, 70, 17, 0.003);                              // rim brighten on click (~critically damped: no flicker)
    var springs = [sx, sy, tx, ty, sk, hv, lx, ly, mx, my, di, fl];
    var hovering = false, pressed = false, nx = 0, ny = 0, lastX = null;
    var rafId = 0, lastT = 0;

    /* The layout rect, cached (no per-frame layout reads). Re-read only on enter or after scroll/resize, and
       de-transformed (the button's own hover scale/pull must not feed back into the pointer maths). */
    var rc = null, rcEpoch = -1;
    function baseRect() {
      if (!rc || rcEpoch !== epoch) {
        var r = btn.getBoundingClientRect(), w = btn.offsetWidth, h = btn.offsetHeight;
        rc = { left: r.left + r.width / 2 - tx.x - w / 2, top: r.top + r.height / 2 - ty.x - h / 2, width: w, height: h };
        rcEpoch = epoch;
      }
      return rc;
    }

    function onPointer(e, enter) {
      if (enter) rc = null;
      var r = baseRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var ex = e.clientX - cx, ey = e.clientY - cy;
      nx = clamp(ex / (r.width / 2), -1.2, 1.2); ny = clamp(ey / (r.height / 2), -1.2, 1.2);
      tx.t = nx * 5; ty.t = ny * 3;
      mx.t = e.clientX - r.left; my.t = e.clientY - r.top;
      if (enter) { mx.x = mx.t; my.x = my.t; }
      var len = Math.sqrt(ex * ex + ey * ey);
      if (len > 5) { lx.t = ex / len; ly.t = ey / len; }
      if (lastX != null && !enter) sk.v += clamp(e.clientX - lastX, -40, 40) * 1.5;   // drag the body: it wobbles
      lastX = e.clientX;
    }
    function targets() {
      var base = hovering ? 1.065 : 1;
      if (pressed) { sx.t = base; sy.t = base; di.t = 1.35; }   // pressed: the lens deepens, the button does NOT shrink
      else { sx.t = base * (1 + 0.03 * Math.abs(nx)); sy.t = base * (1 - 0.02 * Math.abs(nx)); di.t = hovering ? 1.2 : 1; }
      hv.t = hovering ? 1 : 0;
      if (!hovering) { tx.t = 0; ty.t = 0; }
    }

    /* ----- animation loop ----- */
    function apply() {
      var skew = clamp(sk.x, -7, 7);
      btn.style.transform = "translate3d(" + tx.x.toFixed(2) + "px," + ty.x.toFixed(2) + "px,0) skewX(" + skew.toFixed(2) + "deg) scale(" + sx.x.toFixed(4) + "," + sy.x.toFixed(4) + ")";
      btn.style.setProperty("--hv", clamp(hv.x, 0, 1).toFixed(3));
      btn.style.setProperty("--fl", clamp(fl.x, 0, 1).toFixed(3));
      btn.style.setProperty("--mx", mx.x.toFixed(1) + "px");
      btn.style.setProperty("--my", my.x.toFixed(1) + "px");
      btn.style.setProperty("--la", (Math.atan2(lx.x, -ly.x) * 180 / Math.PI).toFixed(1));
      lensK = clamp(di.x, 0.5, 2.4);
      if (lens) setLens(lens, lensK);
    }
    function tick(now) {
      rafId = 0;
      var dt = Math.min((now - lastT) / 1000 || 0.016, 0.034); lastT = now;
      targets();
      var n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
      for (var i = 0; i < n; i++) {
        sx.step(h); sy.step(h); tx.step(h); ty.step(h); sk.step(h); hv.step(h); lx.step(h); ly.step(h); mx.step(h); my.step(h); di.step(h); fl.step(h);
      }
      apply();
      var alive = false;
      for (var j = 0; !alive && j < springs.length; j++) if (!springs[j].settled()) alive = true;
      if (alive) rafId = requestAnimationFrame(tick);   // otherwise the loop sleeps (even while the pointer rests on the button)
      else if (!hovering && !pressed) btn.style.transform = "";
    }
    function run() { if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(tick); } }

    /* ----- events ----- */
    btn.addEventListener("pointerenter", function (e) {
      hovering = true; onPointer(e, true); lastX = e.clientX;
      sx.v += 1.2; sy.v -= 0.9;   // a little kick: the lens bulges toward you
      run();
    });
    btn.addEventListener("pointermove", function (e) { if (!hovering) return; onPointer(e, false); run(); });
    btn.addEventListener("pointerleave", function () {
      hovering = false; pressed = false; nx = 0; ny = 0; lastX = null;
      lx.t = -0.7; ly.t = -0.7; sk.v += 6; run();
    });
    btn.addEventListener("pointerdown", function (e) {
      pressed = true; hovering = true; onPointer(e, false); run();
    });
    function release() { if (pressed) { pressed = false; run(); } }
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("focus", function () {
      if (btn.matches(":focus-visible")) { hovering = true; nx = 0; ny = 0; mx.t = btn.offsetWidth / 2; my.t = btn.offsetHeight / 2; run(); }
    });
    btn.addEventListener("blur", function () { hovering = false; pressed = false; run(); });
    btn.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { pressed = true; run(); } });
    btn.addEventListener("keyup", function (e) { if (e.key === "Enter" || e.key === " ") release(); });

    btn.addEventListener("click", function () {
      fl.x = 0.5; fl.v = 0;                // brief soft rim brighten (the button itself is unchanged)
      di.x = Math.max(di.x, 1.45);         // refraction swells a touch, then settles
      run();
      activate();                          // the global click spark (clickspark.js) is the click effect
    });
    return btn;
  }

  window.AQ = window.AQ || {};
  AQ.water = { button: button };
})();
