/* AQ Learning - bottom navigation bar with a sliding "liquid glass" lens.
   AQ.navbar.mount(container, { items, active, onSelect }) -> { setActive(id), destroy() }
   AQ.navbar.DEFAULT_ITEMS: dashboard / ai / goals.
   Page tip: add class `has-navbar` to <body> to reserve bottom space (see navbar.css). */
window.AQ = window.AQ || {};
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  /* ---------- icons (createElementNS, no innerHTML) ---------- */
  var ICON_DEFS = {
    dashboard: [
      ["rect", { x: 3.5, y: 3.5, width: 7, height: 7, rx: 2 }],
      ["rect", { x: 13.5, y: 3.5, width: 7, height: 7, rx: 2 }],
      ["rect", { x: 3.5, y: 13.5, width: 7, height: 7, rx: 2 }],
      ["rect", { x: 13.5, y: 13.5, width: 7, height: 7, rx: 2 }]
    ],
    ai: [
      ["path", { d: "M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z", fill: "currentColor" }],
      ["path", { d: "M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z", fill: "currentColor" }]
    ],
    playlists: [
      ["rect", { x: 3.5, y: 4, width: 13, height: 3, rx: 1.5 }],
      ["rect", { x: 3.5, y: 10.5, width: 13, height: 3, rx: 1.5 }],
      ["rect", { x: 3.5, y: 17, width: 8, height: 3, rx: 1.5 }],
      ["path", { d: "M15 16.2v4.6l4-2.3z", fill: "currentColor" }]
    ],
    goals: [
      ["circle", { cx: 12, cy: 12, r: 8.5 }],
      ["circle", { cx: 12, cy: 12, r: 4.5 }],
      ["circle", { cx: 12, cy: 12, r: 1.2, fill: "currentColor" }]
    ]
  };

  function makeIcon(name) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "nb-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    (ICON_DEFS[name] || ICON_DEFS.dashboard).forEach(function (def) {
      var n = document.createElementNS(SVG_NS, def[0]);
      Object.keys(def[1]).forEach(function (k) { n.setAttribute(k, def[1][k]); });
      svg.appendChild(n);
    });
    return svg;
  }

  var DEFAULT_ITEMS = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "ai", label: "AI", icon: "ai" },
    { id: "playlists", label: "Playlists", icon: "playlists" }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildRow(items, isClone) {
    var row = el("div", "nb-row");
    var nodes = items.map(function (it) {
      var b = el(isClone ? "span" : "button", "nb-tab");
      if (!isClone) {
        b.type = "button";
        b.setAttribute("role", "tab");
        b.id = "nb-tab-" + it.id + "-" + Math.random().toString(36).slice(2, 7);
        b.setAttribute("aria-label", it.label);
      }
      b.appendChild(makeIcon(it.icon));
      var lab = el("span", "nb-label", it.label);
      if (!isClone) lab.setAttribute("aria-hidden", "true");
      b.appendChild(lab);
      row.appendChild(b);
      return b;
    });
    return { row: row, nodes: nodes };
  }

  /* ---------- mount ---------- */
  function mount(container, opts) {
    opts = opts || {};
    var items = (opts.items && opts.items.length ? opts.items : DEFAULT_ITEMS).slice();
    var onSelect = typeof opts.onSelect === "function" ? opts.onSelect : function () {};
    var index = Math.max(0, items.findIndex(function (it) { return it.id === opts.active; }));
    var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

    var root = el("nav", "nb-bar nb-settled");
    root.setAttribute("aria-label", "Main");
    var pill = el("div", "nb-pill");
    var real = buildRow(items, false);
    real.row.setAttribute("role", "tablist");
    real.row.setAttribute("aria-orientation", "horizontal");
    pill.appendChild(real.row);

    var lens = el("div", "nb-lens");
    lens.setAttribute("aria-hidden", "true");
    var view = el("div", "nb-lens-view");            // clipped circle
    var cloneWrap = el("div", "nb-lens-clone");       // magnified copy of the pill
    var clone = buildRow(items, true);
    cloneWrap.appendChild(clone.row);
    view.appendChild(cloneWrap);
    lens.appendChild(view);
    lens.appendChild(el("div", "nb-lens-caps"));
    lens.appendChild(el("div", "nb-lens-rim"));
    pill.appendChild(lens);
    root.appendChild(pill);
    container.appendChild(root);

    /* geometry */
    var g = { w: 0, h: 0, d: 0, centers: [] };
    function measure() {
      g.w = pill.clientWidth; g.h = pill.clientHeight;
      g.d = lens.offsetWidth;
      g.centers = real.nodes.map(function (n) { return n.offsetLeft + n.offsetWidth / 2; });
      cloneWrap.style.width = g.w + "px";
      cloneWrap.style.height = g.h + "px";
    }
    function targetFor(i) {
      var c = g.centers[i] || 0;
      var push = 0;                         // end items drift past the pill edge
      if (i === 0 && items.length > 1) c -= push;
      if (i === items.length - 1 && items.length > 1) c += push;
      return c;
    }

    /* spring state */
    var x = 0, v = 0, target = 0, raf = 0, last = 0, dragging = false, alive = true;
    var K = 190, C = 19;                              // soft, gliding spring with a gentle overshoot
    var sp = 0;                                       // smoothed speed -> fluid stretch, no jitter

    function render() {
      var raw = Math.min(Math.abs(v) / 1800, 1);
      sp += (raw - sp) * 0.25;
      var speed = sp;
      var sx = 1 + speed * 0.28, sy = 1 - speed * 0.16;
      var left = x - g.d / 2, top = (g.h - g.d) / 2;
      lens.style.transform = "translate3d(" + left.toFixed(2) + "px," + top.toFixed(2) + "px,0) scale(" +
        sx.toFixed(3) + "," + sy.toFixed(3) + ")";
      // magnified clone: align pill copy under the lens, scale around lens centre
      var mag = 1.16 + speed * 0.14;
      cloneWrap.style.transformOrigin = (x).toFixed(2) + "px " + (g.h / 2) + "px";
      cloneWrap.style.transform = "translate3d(" + (-left).toFixed(2) + "px," + (-top).toFixed(2) + "px,0) scale(" +
        (mag / sx).toFixed(3) + "," + (mag / sy).toFixed(3) + ")";
    }

    function step(t) {
      raf = 0;
      if (!alive) return;
      var dt = Math.min((t - (last || t)) / 1000, 1 / 30) || 1 / 60;
      last = t;
      if (!dragging) {
        // sub-step for stability
        for (var s = 0; s < 4; s++) {
          var h = dt / 4;
          var a = -K * (x - target) - C * v;
          v += a * h; x += v * h;
        }
      }
      render();
      if (dragging || Math.abs(x - target) > 0.3 || Math.abs(v) > 4 || sp > 0.01) {
        raf = requestAnimationFrame(step);
      } else {
        x = target; v = 0; sp = 0; render(); last = 0;
        root.classList.add("nb-settled");
      }
    }
    function kick() {
      if (mq && mq.matches) { x = target; v = 0; render(); root.classList.add("nb-settled"); return; }
      root.classList.remove("nb-settled");
      if (!raf) raf = requestAnimationFrame(step);
    }

    function paint() {
      real.nodes.forEach(function (n, i) {
        var on = i === index;
        n.classList.toggle("nb-active", on);
        n.setAttribute("aria-selected", on ? "true" : "false");
        n.tabIndex = on || (index < 0 && i === 0) ? 0 : -1;
      });
      root.classList.toggle("nb-none", index < 0);
      clone.nodes.forEach(function (n, i) { n.classList.toggle("nb-active", i === index); });
    }

    function go(i, fire, focus) {
      if (i < 0 || i >= items.length) return;
      var changed = i !== index;
      index = i; paint();
      target = targetFor(i); kick();
      if (focus) real.nodes[i].focus();
      if (fire && changed) onSelect(items[i].id);
    }

    /* events */
    real.nodes.forEach(function (n, i) {
      n.addEventListener("click", function () { if (!suppressClick) go(i, true); });
    });
    real.row.addEventListener("keydown", function (e) {
      var i = index, k = e.key;
      if (k === "ArrowRight") i = (index + 1) % items.length;
      else if (k === "ArrowLeft") i = (index - 1 + items.length) % items.length;
      else if (k === "Home") i = 0;
      else if (k === "End") i = items.length - 1;
      else return;
      e.preventDefault(); go(i, true, true);
    });

    // pointer drag (start on the lens area)
    var startX = 0, startLensX = 0, moved = false, suppressClick = false, pid = null;
    function nearest(px) {
      var best = 0, bd = Infinity;
      g.centers.forEach(function (c, i) { var d = Math.abs(c - px); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    function onDown(e) {
      if (e.button !== 0 || index < 0) return;
      var r = pill.getBoundingClientRect();
      var px = e.clientX - r.left;
      if (Math.abs(px - x) > g.d / 2) return;       // only grab the lens itself
      pid = e.pointerId; startX = e.clientX; startLensX = x; moved = false;
    }
    function onMove(e) {
      if (pid !== e.pointerId) return;
      var dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) { moved = true; dragging = true; try { pill.setPointerCapture(pid); } catch (_) {} kick(); }
      var nx = Math.max(g.centers[0] - g.d * 0.2, Math.min(g.centers[g.centers.length - 1] + g.d * 0.2, startLensX + dx));
      var now = performance.now();
      v = (nx - x) / Math.max((now - (onMove.t || now)) / 1000, 1 / 120) * 0.5;
      onMove.t = now; x = nx;
      if (mq && mq.matches) render();
    }
    function onUp(e) {
      if (pid !== e.pointerId) return;
      pid = null;
      if (!moved) return;
      dragging = false; suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      var i = nearest(x);
      if (i === index) { target = targetFor(i); kick(); } else go(i, true);
    }
    pill.addEventListener("pointerdown", onDown);
    pill.addEventListener("pointermove", onMove);
    pill.addEventListener("pointerup", onUp);
    pill.addEventListener("pointercancel", onUp);

    function relayout() { measure(); target = targetFor(index); x = target; v = 0; render(); }
    var ro = window.ResizeObserver ? new ResizeObserver(relayout) : null;
    if (ro) ro.observe(pill); else window.addEventListener("resize", relayout);

    paint(); relayout();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (alive) relayout(); });

    return {
      setActive: function (id) {
        var i = id == null ? -1 : items.findIndex(function (it) { return it.id === id; });
        root.classList.toggle("nb-none", i < 0);
        if (i >= 0) go(i, false);
        else { index = -1; paint(); }        // null / unknown id: hide lens, dim all icons
      },
      destroy: function () {
        alive = false;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener("resize", relayout);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  AQ.navbar = { mount: mount, DEFAULT_ITEMS: DEFAULT_ITEMS };
})();
