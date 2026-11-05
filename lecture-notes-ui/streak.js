/* AQ Learning - daily streak tracker.
   AQ.streak      : activity data + stats (no DOM). localStorage key `aq.activity.v1`:
                    { days: { "YYYY-MM-DD": { count, kinds: {watch, notes, ...}, minutes } }, freezes }
                    Dates are LOCAL calendar days. Works in memory if storage is unavailable.
   AQ.streakView  : mount(container) -> { destroy() } renders the streak card (classes prefixed `stk-`). */
window.AQ = window.AQ || {};
(function (AQ) {
  "use strict";

  var KEY = "aq.activity.v1";
  var DAY = 86400000;
  var data = { days: {}, freezes: 0 };
  var storageOk = true;
  var listeners = [];

  /* ---------- local-date helpers ---------- */
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function keyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dateOf(k) { var p = k.split("-"); return new Date(+p[0], p[1] - 1, +p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function today() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function dayIdx(d) { return (d.getDay() + 6) % 7; } /* Mon = 0 */
  var KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ---------- persistence ---------- */
  function sanitize(raw) {
    var out = { days: {}, freezes: 0 };
    if (!raw || typeof raw !== "object") return out;
    out.freezes = Math.max(0, Math.floor(+raw.freezes || 0));
    var days = raw.days && typeof raw.days === "object" ? raw.days : {};
    Object.keys(days).forEach(function (k) {
      var v = days[k];
      if (!KEY_RE.test(k) || !v) return;
      var c = Math.floor(+v.count || 0);
      if (c < 1) return;
      var kinds = {};
      if (v.kinds && typeof v.kinds === "object") Object.keys(v.kinds).forEach(function (n) {
        var x = Math.floor(+v.kinds[n] || 0); if (x > 0) kinds[String(n).slice(0, 24)] = x;
      });
      out.days[k] = { count: c, kinds: kinds, minutes: Math.max(0, +v.minutes || 0) };
    });
    return out;
  }
  function load() {
    try { var s = localStorage.getItem(KEY); if (s) data = sanitize(JSON.parse(s)); }
    catch (e) { storageOk = false; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); storageOk = true; }
    catch (e) { storageOk = false; }
  }
  function emit(evt) {
    listeners.slice().forEach(function (fn) { try { fn(evt || {}); } catch (e) { /* isolate listeners */ } });
  }

  /* ---------- API ---------- */
  /** Log activity for today. kind: "watch" | "notes" | "playlist" | ...; amount defaults to 1.
      opts.minutes adds study minutes. Returns today's entry. */
  function record(kind, amount, opts) {
    var n = Math.max(1, Math.floor(+amount || 1));
    var k = keyOf(today());
    var d = data.days[k];
    var first = !d;
    if (!d) d = data.days[k] = { count: 0, kinds: {}, minutes: 0 };
    kind = String(kind || "other").slice(0, 24);
    d.count += n;
    d.kinds[kind] = (d.kinds[kind] || 0) + n;
    if (opts && +opts.minutes > 0) d.minutes += +opts.minutes;
    save();
    emit({ type: "record", kind: kind, first: first, date: k });
    return { date: k, count: d.count, kinds: d.kinds, minutes: d.minutes };
  }

  function count(k) { var d = data.days[k]; return d ? d.count : 0; }
  function runEnding(d) { var n = 0; while (count(keyOf(d)) > 0) { n++; d = addDays(d, -1); } return n; }

  function stats() {
    var t = today(), tk = keyOf(t);
    var keys = Object.keys(data.days).sort();
    var longest = 0, run = 0, prev = null, total = 0, best = null, minutes = 0;
    keys.forEach(function (k) {
      var d = dateOf(k), c = data.days[k].count;
      run = prev && keyOf(addDays(prev, 1)) === k ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = d; total += c; minutes += data.days[k].minutes || 0;
      if (!best || c > best.count) best = { date: k, count: c };
    });
    var todayCount = count(tk);
    var current = todayCount > 0 ? runEnding(t) : runEnding(addDays(t, -1));
    var monday = addDays(t, -dayIdx(t));
    var week = [], weekTotal = 0, lastWeekTotal = 0;
    for (var i = 0; i < 7; i++) {
      var wk = keyOf(addDays(monday, i)), c = count(wk);
      week.push({ date: wk, count: c, future: addDays(monday, i) > t });
      weekTotal += c; lastWeekTotal += count(keyOf(addDays(monday, i - 7)));
    }
    var midnight = addDays(t, 1).getTime();
    return {
      current: current, longest: longest, total: total, activeDays: keys.length, minutes: minutes,
      today: todayCount, todayKey: tk, bestDay: best,
      state: todayCount > 0 ? "done" : current > 0 ? "at-risk" : "idle", /* at-risk = keep it alive */
      hoursLeft: Math.max(0, Math.ceil((midnight - Date.now()) / 3600000)),
      week: week, weekTotal: weekTotal, lastWeekTotal: lastWeekTotal,
      weekActive: week.filter(function (w) { return w.count > 0; }).length,
      freezes: data.freezes, storageOk: storageOk
    };
  }

  /** Copy of the day map: { "YYYY-MM-DD": { count, kinds, minutes } } */
  function days() { return JSON.parse(JSON.stringify(data.days)); }

  function subscribe(fn) {
    if (typeof fn !== "function") return function () {};
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  /** Dev helper: ~8 months of bursty, realistic history ending with a live streak. */
  function seedDemo() {
    var t = today(), out = {}, on = true, kinds = ["watch", "notes", "playlist"];
    for (var i = 240; i >= 1; i--) {
      var d = addDays(t, -i), wkend = dayIdx(d) >= 5;
      if (i <= 23) on = true; /* recent unbroken run */
      else on = Math.random() < (on ? (wkend ? 0.78 : 0.9) : 0.35);
      if (!on) continue;
      var c = 1 + Math.floor(Math.pow(Math.random(), 1.8) * (wkend ? 12 : 8));
      var k = {}; for (var j = 0; j < c; j++) { var n = kinds[j % 3 === 0 ? 0 : Math.floor(Math.random() * 3)]; k[n] = (k[n] || 0) + 1; }
      out[keyOf(d)] = { count: c, kinds: k, minutes: c * (8 + Math.floor(Math.random() * 18)) };
    }
    data = { days: out, freezes: 2 };
    save();
    emit({ type: "seed" });
  }

  load();
  window.addEventListener("storage", function (e) { if (e.key === KEY) { load(); emit({ type: "sync" }); } });
  try { if (/[?&]demo=streak\b/.test(location.search)) seedDemo(); } catch (e) { /* no location */ }

  AQ.streak = {
    KEY: KEY, record: record, stats: stats, days: days, subscribe: subscribe, seedDemo: seedDemo,
    keyOf: keyOf, storageOk: function () { return storageOk; }
  };

  /* =================================================================== view */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MILESTONES = [
    { n: 7, name: "Spark", sub: "1 week" },
    { n: 30, name: "Blaze", sub: "1 month" },
    { n: 100, name: "Inferno", sub: "100 days" },
    { n: 365, name: "Supernova", sub: "1 year" }
  ];
  var WEEKS = 52, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function el(tag, cls, text) { return AQ.util && AQ.util.el ? AQ.util.el(tag, cls, text) : (function () {
    var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; })(); }
  function svg(tag, attrs) { var n = document.createElementNS(SVG_NS, tag); for (var a in attrs) n.setAttribute(a, attrs[a]); return n; }
  function level(c) { return c <= 0 ? 0 : c === 1 ? 1 : c <= 3 ? 2 : c <= 6 ? 3 : 4; }
  function tier(n) { return n >= 100 ? 4 : n >= 30 ? 3 : n >= 7 ? 2 : n >= 1 ? 1 : 0; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function fmtDate(d) {
    try { return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
    catch (e) { return WD[dayIdx(d)] + ", " + MON[d.getMonth()] + " " + d.getDate(); }
  }
  function reducedMotion() { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } }

  function flame(t) {
    var s = svg("svg", { viewBox: "0 0 64 80", "aria-hidden": "true", focusable: "false", "class": "stk-flame stk-tier-" + t });
    var defs = svg("defs", {});
    var g = svg("linearGradient", { id: "stk-fg-" + t, x1: "0", y1: "1", x2: "0", y2: "0" });
    g.appendChild(svg("stop", { offset: "0", "class": "stk-flame__s0" }));
    g.appendChild(svg("stop", { offset: "1", "class": "stk-flame__s1" }));
    defs.appendChild(g); s.appendChild(defs);
    s.appendChild(svg("ellipse", { cx: "32", cy: "74", rx: "18", ry: "4", "class": "stk-flame__glow" }));
    s.appendChild(svg("path", { "class": "stk-flame__outer", fill: "url(#stk-fg-" + t + ")",
      d: "M32 4C36 18 52 26 52 48a20 20 0 01-40 0c0-9 4-15 9-20 0 7 3 11 7 12-3-12 2-26 4-36z" }));
    s.appendChild(svg("path", { "class": "stk-flame__inner",
      d: "M32 34c3 7 11 10 11 19a11 11 0 01-22 0c0-5 3-8 6-10 0 4 2 6 4 6-1-6 0-11 1-15z" }));
    s.appendChild(svg("path", { "class": "stk-flame__core", d: "M32 50c2 3 5 5 5 9a5 5 0 01-10 0c0-3 3-5 5-9z" }));
    return s;
  }

  function mount(container) {
    var ui = { tab: "year", monthOff: 0, focusKey: null };
    var root = el("section", "stk");
    root.setAttribute("aria-label", "Daily streak");
    var tip = el("div", "stk-tip"); tip.setAttribute("role", "tooltip"); tip.id = "stk-tip-" + Math.random().toString(36).slice(2, 8);
    container.appendChild(root);

    function render() {
      var st = stats(), dm = data.days;
      var hadFocus = root.contains(document.activeElement) && document.activeElement.dataset.key;
      root.textContent = "";
      root.className = "stk stk--" + st.state + " stk-tier-" + tier(st.current);

      /* hero */
      var hero = el("div", "stk-hero");
      var fl = el("div", "stk-flamewrap"); fl.appendChild(flame(tier(st.current)));
      var num = el("div", "stk-hero__main");
      var big = el("div", "stk-big");
      big.appendChild(el("span", "stk-big__n", String(st.current)));
      big.appendChild(el("span", "stk-big__u", st.current === 1 ? "day streak" : "day streak"));
      num.appendChild(big);
      var msg = st.state === "done" ? (st.current >= st.longest && st.current > 1 ? "Personal best - you're on fire." : "Done for today. See you tomorrow.")
        : st.state === "at-risk" ? "Keep it alive - " + plural(st.hoursLeft, "hour") + " left today."
        : st.longest ? "Start a new streak today." : "Watch or take notes to light your first flame.";
      num.appendChild(el("p", "stk-msg", msg));
      if (st.current > 0 && st.current >= st.longest && st.current > 1) num.appendChild(el("span", "stk-pb", "Best ever"));
      hero.appendChild(fl); hero.appendChild(num);
      root.appendChild(hero);

      /* stat row */
      var row = el("dl", "stk-stats");
      [["Longest", plural(st.longest, "day")], ["Active days", String(st.activeDays)],
       ["Activities", String(st.total)], ["This week", st.weekTotal + (st.lastWeekTotal ? " " + (st.weekTotal >= st.lastWeekTotal ? "↑" : "↓") : "")]
      ].forEach(function (p) { var d = el("div", "stk-stat"); d.appendChild(el("dt", null, p[0])); d.appendChild(el("dd", null, p[1])); row.appendChild(d); });
      root.appendChild(row);

      /* this week dots */
      var wk = el("div", "stk-week"); wk.setAttribute("aria-label", "This week: " + st.weekActive + " of 7 days active");
      st.week.forEach(function (w, i) {
        var c = el("div", "stk-dot" + (w.count ? " is-on" : "") + (w.future ? " is-future" : "") + (w.date === st.todayKey ? " is-today" : ""));
        c.appendChild(el("span", "stk-dot__b")); c.appendChild(el("span", "stk-dot__l", WD[i].charAt(0)));
        c.title = WD[i] + ": " + plural(w.count, "activity").replace("activitys", "activities");
        wk.appendChild(c);
      });
      root.appendChild(wk);

      /* tabs */
      var tabs = el("div", "stk-tabs"); tabs.setAttribute("role", "tablist");
      [["year", "Year"], ["month", "Month"]].forEach(function (t) {
        var b = el("button", "stk-tab", t[1]); b.type = "button"; b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(ui.tab === t[0]));
        b.addEventListener("click", function () { ui.tab = t[0]; render(); root.querySelector(".stk-tab[aria-selected=true]").focus(); });
        tabs.appendChild(b);
      });
      root.appendChild(tabs);
      var panel = el("div", "stk-panel"); panel.setAttribute("role", "tabpanel");
      panel.appendChild(ui.tab === "year" ? heatmap(dm, st) : monthView(dm, st));
      root.appendChild(panel);

      /* badges */
      var bs = el("ul", "stk-badges"); bs.setAttribute("aria-label", "Milestones");
      var next = null;
      MILESTONES.forEach(function (m) {
        var on = st.longest >= m.n;
        if (!on && !next) next = m;
        var li = el("li", "stk-badge" + (on ? " is-on" : ""));
        var med = el("span", "stk-badge__m", String(m.n));
        li.appendChild(med); li.appendChild(el("span", "stk-badge__t", m.name)); li.appendChild(el("span", "stk-badge__s", on ? "Unlocked" : m.sub));
        li.setAttribute("aria-label", m.name + ", " + m.n + "-day streak, " + (on ? "unlocked" : "locked"));
        if (!on && m === next) {
          var bar = el("span", "stk-badge__bar"), fill = el("i");
          fill.style.width = Math.round(Math.min(1, st.current / m.n) * 100) + "%";
          bar.appendChild(fill); li.appendChild(bar);
        }
        bs.appendChild(li);
      });
      root.appendChild(bs);
      root.appendChild(tip);

      if (hadFocus) { var f = root.querySelector('[data-key="' + hadFocus + '"]'); if (f) f.focus(); }
    }

    /* ---------- heatmap ---------- */
    function heatmap(dm, st) {
      var t = today(), start = addDays(t, -dayIdx(t) - (WEEKS - 1) * 7);
      var wrap = el("div", "stk-heat");
      var labels = el("div", "stk-heat__days");
      WD.forEach(function (w, i) { labels.appendChild(el("span", null, i % 2 === 0 && i < 6 ? w : "")); });
      var scroll = el("div", "stk-heat__scroll");
      var months = el("div", "stk-heat__months");
      var grid = el("div", "stk-heat__grid");
      grid.setAttribute("role", "grid"); grid.setAttribute("aria-label", "Activity over the last year. Use arrow keys to move between days.");
      var cells = [], lastMonth = -1, focusKey = ui.focusKey || st.todayKey;
      for (var w = 0; w < WEEKS; w++) {
        for (var i = 0; i < 7; i++) {
          var d = addDays(start, w * 7 + i), k = keyOf(d);
          if (i === 0 && d.getMonth() !== lastMonth && (w < WEEKS - 2)) {
            var ml = el("span", null, MON[d.getMonth()]); ml.style.left = (w * 14) + "px"; months.appendChild(ml);
            lastMonth = d.getMonth();
          } else if (i === 0) lastMonth = d.getMonth();
          var c = el("span", "stk-cell");
          if (d > t) { c.className += " is-future"; grid.appendChild(c); continue; }
          var n = dm[k] ? dm[k].count : 0;
          c.className += " l" + level(n) + (k === st.todayKey ? " is-today" : "");
          c.dataset.key = k; c.dataset.idx = String(cells.length);
          c.setAttribute("role", "gridcell");
          c.setAttribute("aria-label", (n ? plural(n, "activity").replace("activitys", "activities") : "No activity") + " on " + fmtDate(d));
          c.tabIndex = k === focusKey ? 0 : -1;
          cells.push(c); grid.appendChild(c);
        }
      }
      if (!grid.querySelector('[tabindex="0"]') && cells.length) cells[cells.length - 1].tabIndex = 0;
      function show(c) {
        if (!c || !c.dataset.key) return;
        tip.textContent = c.getAttribute("aria-label");
        var r = c.getBoundingClientRect(), R = root.getBoundingClientRect();
        tip.classList.add("is-on");
        var x = r.left - R.left + r.width / 2, tw = tip.offsetWidth;
        tip.style.left = Math.max(tw / 2 + 4, Math.min(R.width - tw / 2 - 4, x)) + "px";
        tip.style.top = (r.top - R.top - 8) + "px";
        c.setAttribute("aria-describedby", tip.id);
      }
      function hide() { tip.classList.remove("is-on"); }
      grid.addEventListener("mouseover", function (e) { show(e.target.closest(".stk-cell")); });
      grid.addEventListener("mouseleave", hide);
      grid.addEventListener("focusin", function (e) { ui.focusKey = e.target.dataset.key; show(e.target); });
      grid.addEventListener("focusout", hide);
      scroll.addEventListener("scroll", hide, { passive: true });
      grid.addEventListener("keydown", function (e) {
        var cur = e.target.dataset.idx; if (cur == null) return;
        var step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, Home: -1e9, End: 1e9 }[e.key];
        if (step == null) return;
        e.preventDefault();
        var j = Math.max(0, Math.min(cells.length - 1, +cur + step));
        e.target.tabIndex = -1; cells[j].tabIndex = 0; cells[j].focus();
      });
      scroll.appendChild(months); scroll.appendChild(grid);
      wrap.appendChild(labels); wrap.appendChild(scroll);
      var legend = el("div", "stk-legend");
      legend.appendChild(el("span", "stk-legend__best", st.bestDay ? "Best day: " + st.bestDay.count + " on " + fmtDate(dateOf(st.bestDay.date)) : ""));
      var lv = el("span", "stk-legend__lv"); lv.appendChild(el("span", null, "Less"));
      for (var l = 0; l < 5; l++) lv.appendChild(el("i", "stk-cell l" + l));
      lv.appendChild(el("span", null, "More")); legend.appendChild(lv);
      var box = el("div"); box.appendChild(wrap); box.appendChild(legend);
      requestAnimationFrame(function () { scroll.scrollLeft = scroll.scrollWidth; });
      return box;
    }

    /* ---------- month calendar ---------- */
    function monthView(dm, st) {
      var t = today(), first = new Date(t.getFullYear(), t.getMonth() + ui.monthOff, 1);
      var dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      var box = el("div", "stk-month");
      var head = el("div", "stk-month__head");
      function nav(dir, label, glyph, disabled) {
        var b = el("button", "stk-nav", glyph); b.type = "button"; b.setAttribute("aria-label", label); b.disabled = disabled;
        b.addEventListener("click", function () { ui.monthOff += dir; render(); var nb = root.querySelectorAll(".stk-nav")[dir < 0 ? 0 : 1]; if (nb && !nb.disabled) nb.focus(); });
        return b;
      }
      var active = 0;
      for (var a = 1; a <= dim; a++) if (dm[keyOf(new Date(first.getFullYear(), first.getMonth(), a))]) active++;
      var title = el("div", "stk-month__title");
      title.appendChild(el("strong", null, MON[first.getMonth()] + " " + first.getFullYear()));
      title.appendChild(el("span", null, active + " / " + dim + " days"));
      title.setAttribute("aria-live", "polite");
      head.appendChild(nav(-1, "Previous month", "‹", ui.monthOff <= -24));
      head.appendChild(title);
      head.appendChild(nav(1, "Next month", "›", ui.monthOff >= 0));
      box.appendChild(head);
      var cal = el("div", "stk-cal");
      WD.forEach(function (w) { cal.appendChild(el("span", "stk-cal__wd", w.charAt(0))); });
      for (var p = 0; p < dayIdx(first); p++) cal.appendChild(el("span", "stk-cal__pad"));
      for (var i = 1; i <= dim; i++) {
        var d = new Date(first.getFullYear(), first.getMonth(), i), k = keyOf(d), n = dm[k] ? dm[k].count : 0;
        var prevOn = i > 1 && dm[keyOf(addDays(d, -1))] && dayIdx(d) !== 0;
        var nextOn = i < dim && dm[keyOf(addDays(d, 1))] && dayIdx(d) !== 6;
        var c = el("span", "stk-cal__d" + (n ? " is-on" : "") + (prevOn && n ? " join-l" : "") + (nextOn && n ? " join-r" : "") +
          (k === st.todayKey ? " is-today" : "") + (d > t ? " is-future" : ""), String(i));
        c.title = (n ? plural(n, "activity").replace("activitys", "activities") : "No activity") + " on " + fmtDate(d);
        cal.appendChild(c);
      }
      box.appendChild(cal);
      return box;
    }

    /* ---------- celebration ---------- */
    function burst() {
      if (reducedMotion()) { root.classList.add("stk-pop-static"); setTimeout(function () { root.classList.remove("stk-pop-static"); }, 1200); return; }
      var host = root.querySelector(".stk-flamewrap"); if (!host) return;
      var b = el("div", "stk-burst");
      for (var i = 0; i < 16; i++) {
        var p = el("i");
        p.style.setProperty("--a", (i * 22.5 + Math.random() * 10) + "deg");
        p.style.setProperty("--r", (38 + Math.random() * 30) + "px");
        p.style.setProperty("--d", (Math.random() * 120) + "ms");
        b.appendChild(p);
      }
      host.appendChild(b);
      root.classList.add("stk-pop");
      setTimeout(function () { b.remove(); root.classList.remove("stk-pop"); }, 1100);
    }

    render();
    var unsub = subscribe(function (e) { render(); if (e.type === "record" && e.first) burst(); });
    /* re-render after midnight so "today" rolls over */
    var dayTimer = setInterval(function () { if (root.dataset.day !== keyOf(today())) { root.dataset.day = keyOf(today()); render(); } }, 60000);
    root.dataset.day = keyOf(today());

    return { destroy: function () { unsub(); clearInterval(dayTimer); root.remove(); } };
  }

  AQ.streakView = { mount: mount };
})(window.AQ);
