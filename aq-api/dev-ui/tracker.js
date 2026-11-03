/* AQ tracker page: polls /dev/api/* every 2 s (incremental with ?since=); History / Stats / Service logs tabs read the
   persistent endpoints on demand. All data is written with textContent. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_ROWS = 1000, POLL_MS = 2000;
  const st = { paused: false, reqSince: 0, evSince: 0, reqs: [], evs: [], tab: "requests", includeDev: false };

  function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; }
  function row(cells, cls) { const tr = el("tr", null, cls); for (const c of cells) tr.appendChild(c instanceof Node ? c : el("td", c ?? "")); return tr; }
  const time = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "");
  const statusCls = (s) => (s === 0 ? "s-fail" : s >= 500 ? "s-5xx" : s >= 400 ? "s-4xx" : s >= 300 ? "s-3xx" : "s-2xx");
  async function get(p) { const r = await fetch(p, { cache: "no-store" }); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }

  function renderRequests() {
    const layer = $("f-layer").value, status = $("f-status").value, text = $("f-text").value.trim().toLowerCase();
    const body = $("req-body"), frag = document.createDocumentFragment();
    for (let i = st.reqs.length - 1; i >= 0; i--) {
      const r = st.reqs[i];
      if (layer && r.layer !== layer) continue;
      if (status && String(r.status)[0] !== status && !(status === "0" && r.status === 0)) continue;
      if (text && !(r.path + " " + r.method).toLowerCase().includes(text)) continue;
      frag.appendChild(row([r.seq, time(r.ts), el("td", r.layer, "l-" + r.layer), r.method, r.path, el("td", r.status, statusCls(r.status)), r.ms], statusCls(r.status)));
    }
    body.replaceChildren(frag);
  }
  function renderEvents() {
    const frag = document.createDocumentFragment();
    for (let i = st.evs.length - 1; i >= 0; i--) {
      const e = st.evs[i];
      frag.appendChild(row([e.seq, time(e.ts), e.kind, e.jobId ? e.jobId.slice(0, 8) : "", e.videoId || e.playlistId || "", (e.from || "∅") + " → " + e.to, e.stage, e.pct + "%"], "st-" + e.to));
    }
    $("ev-body").replaceChildren(frag);
  }
  function renderJobs(items) {
    const frag = document.createDocumentFragment();
    for (const j of items) {
      frag.appendChild(row([j.kind, j.id ? j.id.slice(0, 8) : "", j.videoId || j.playlistId || "", el("td", j.state, "st-" + j.state), j.stage, j.pct + "%",
        [j.provider, j.model].filter(Boolean).join(" / "), time(j.startedAt), j.durationMs != null ? (j.durationMs / 1000).toFixed(1) + " s" : "", j.error || ""]));
    }
    $("jobs-body").replaceChildren(frag);
  }
  function renderOverview(o) {
    const a = o.services.api, w = o.services.worker, c = o.counts;
    $("svc-api").textContent = `ok · up ${a.uptimeSec}s · pid ${a.pid} · ${a.rssMb} MB · ${a.node}`;
    $("svc-worker").textContent = w.ok ? `ok · ${w.latencyMs} ms` : `down (${w.error || "?"})`;
    $("svc-worker").className = w.ok ? "ok" : "bad";
    const fmt = (obj) => Object.entries(obj).map(([k, v]) => k + " " + v).join(", ");
    $("counts").textContent = `${c.playlists} playlists, ${c.videos} videos · notes: ${fmt(c.notes)} · smart: ${fmt(c.smart)}`;
    $("err-body").replaceChildren(...o.recentErrors.slice().reverse().map((e) => row([time(e.ts), e.path, el("td", e.status, statusCls(e.status))])));
  }

  async function tick() {
    if (st.paused) return;
    try {
      const [rq, ev, ov] = await Promise.all([
        get(`/dev/api/requests?since=${st.reqSince}&limit=500${st.includeDev ? "&include_dev=1" : ""}`),
        get(`/dev/api/events?since=${st.evSince}`),
        get("/dev/api/overview")
      ]);
      if (rq.last < st.reqSince || ev.last < st.evSince) { st.reqs = []; st.evs = []; }   // server restarted
      st.reqs.push(...rq.items); st.reqs = st.reqs.slice(-MAX_ROWS);
      st.evs.push(...ev.items); st.evs = st.evs.slice(-MAX_ROWS);
      st.reqSince = rq.items.length ? rq.items[rq.items.length - 1].seq : rq.last;
      st.evSince = ev.last;
      renderOverview(ov);
      if (rq.items.length) renderRequests();
      if (ev.items.length) renderEvents();
      if (st.tab === "jobs") renderJobs((await get("/dev/api/jobs")).items);
      $("status").textContent = "live · " + new Date().toLocaleTimeString();
      $("status").className = "tr-status ok";
    } catch (e) {
      $("status").textContent = "error: " + e.message;
      $("status").className = "tr-status bad";
    }
  }

  /* ---------- History (persistent JSONL, one day at a time) ---------- */
  const PAGE = 100;
  const hist = { offset: 0, total: 0, daysLoaded: false };
  const HIST_FILTERS = {
    requests: { layer: [["", "all layers"], "ui", "api", "worker"], status: [["", "all statuses"], ["2", "2xx"], ["3", "3xx"], ["4", "4xx"], ["5", "5xx"], ["0", "failed (0)"]],
      head: ["#", "time", "layer", "method", "path", "status", "ms"] },
    events: { layer: [["", "all kinds"], "notes", "smart"], status: [["", "any new state"], "queued", "running", "ready", "error", "none"],
      head: ["#", "time", "kind", "job", "video / playlist", "from → to", "stage", "pct"] }
  };
  function fillSelect(sel, opts) {
    sel.replaceChildren(...opts.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; const op = el("option", t); op.value = v; return op; }));
  }
  function histParams(extra = {}) {
    const p = new URLSearchParams({ type: $("h-type").value, date: $("h-date").value, q: $("h-q").value.trim(), layer: $("h-layer").value, status: $("h-status").value, ...extra });
    for (const [k, v] of [...p]) if (v === "") p.delete(k);
    return p;
  }
  async function loadDays() {
    try {
      const d = await get("/dev/api/history/days");
      const opts = d.items.length ? d.items.map((x) => [x.date, `${x.date} · ${x.requests} req · ${x.events} ev`]) : [[new Date().toISOString().slice(0, 10), "today (empty)"]];
      for (const id of ["h-date", "s-date"]) { const keep = $(id).value; fillSelect($(id), opts); if (keep && opts.some((o) => o[0] === keep)) $(id).value = keep; }
      hist.daysLoaded = true;
      return true;
    } catch (e) {
      $("h-info").textContent = "history unavailable: " + e.message + " (persistent dev logs disabled?)";
      $("s-kpis").replaceChildren(el("p", "stats unavailable: " + e.message, "tr-note"));
      return false;
    }
  }
  function setHistType() {
    const f = HIST_FILTERS[$("h-type").value];
    fillSelect($("h-layer"), f.layer); fillSelect($("h-status"), f.status);
    $("h-head").replaceChildren(row(f.head.map((h) => el("th", h))));
  }
  async function loadHistory() {
    if (!hist.daysLoaded && !(await loadDays())) return;
    const type = $("h-type").value;
    try {
      const d = await get("/dev/api/history?" + histParams({ limit: String(PAGE), offset: String(hist.offset) }));
      hist.total = d.total;
      const frag = document.createDocumentFragment();
      for (const r of d.items) {
        if (type === "requests") frag.appendChild(row([r.seq, new Date(r.ts).toLocaleTimeString(), el("td", r.layer, "l-" + r.layer), r.method, r.path, el("td", r.status, statusCls(r.status)), r.ms], statusCls(r.status)));
        else frag.appendChild(row([r.seq, new Date(r.ts).toLocaleTimeString(), r.kind, r.jobId ? r.jobId.slice(0, 8) : "", r.videoId || r.playlistId || "", (r.from || "∅") + " → " + r.to, r.stage, r.pct + "%"], "st-" + r.to));
      }
      $("h-body").replaceChildren(frag);
      const end = Math.min(d.total, hist.offset + d.items.length);
      $("h-info").textContent = `${d.total} matching ${type} on ${d.date} (newest first)`;
      $("h-page").textContent = d.total ? `${hist.offset + 1}–${end} of ${d.total}` : "no entries";
      $("h-prev").disabled = hist.offset === 0;
      $("h-next").disabled = end >= d.total;
    } catch (e) { $("h-info").textContent = "error: " + e.message; }
  }
  function exportHistory(format) {
    const a = el("a"); a.href = "/dev/api/export?" + histParams({ format }); a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- Stats ---------- */
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text != null) e.textContent = String(text); return e; }
  function drawChart(hours) {
    const svg = $("s-chart"), W = 720, H = 200, L = 36, B = 20, T = 10, bw = (W - L - 4) / 24;
    const max = Math.max(1, ...hours.map((h) => h.count));
    const parts = [svgEl("line", { x1: L, y1: H - B, x2: W, y2: H - B, class: "axis" }), svgEl("line", { x1: L, y1: T, x2: L, y2: H - B, class: "axis" }),
      svgEl("text", { x: L - 4, y: T + 8, "text-anchor": "end" }, max), svgEl("text", { x: L - 4, y: H - B, "text-anchor": "end" }, 0)];
    for (const h of hours) {
      const x = L + 2 + h.hour * bw, ph = H - B - T, hgt = (h.count / max) * ph, eh = (h.errors / max) * ph;
      const bar = svgEl("rect", { x: x + 1, y: H - B - hgt, width: Math.max(1, bw - 2), height: hgt, class: "bar" });
      bar.appendChild(svgEl("title", {}, `${String(h.hour).padStart(2, "0")}:00 UTC · ${h.count} requests · ${h.errors} errors`));
      parts.push(bar);
      if (h.errors) parts.push(svgEl("rect", { x: x + 1, y: H - B - eh, width: Math.max(1, bw - 2), height: eh, class: "bar-err" }));
      if (h.hour % 3 === 0) parts.push(svgEl("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }, String(h.hour).padStart(2, "0")));
    }
    svg.replaceChildren(...parts);
  }
  async function loadStats() {
    if (!hist.daysLoaded && !(await loadDays())) return;
    try {
      const p = new URLSearchParams({ date: $("s-date").value }); if ($("s-layer").value) p.set("layer", $("s-layer").value);
      const s = await get("/dev/api/stats?" + p);
      const kpi = (label, value) => { const c = el("div", null, "tr-card"); c.append(el("h2", label), el("p", value, "tr-kpi")); return c; };
      $("s-kpis").replaceChildren(kpi("Requests", s.total), kpi("Errors", `${s.errors} (${(s.errorRate * 100).toFixed(1)}%)`),
        kpi("p50 / p95", s.total ? `${s.p50} / ${s.p95} ms` : "-"), kpi("Slowest", s.max != null ? s.max + " ms" : "-"));
      drawChart(s.hours);
      $("s-body").replaceChildren(...s.paths.map((x) => row([el("td", x.layer, "l-" + x.layer), x.method, x.path, x.count, el("td", x.errors, x.errors ? "bad" : ""),
        (x.errorRate * 100).toFixed(1) + "%", x.p50, x.p95, x.max])));
    } catch (e) { $("s-kpis").replaceChildren(el("p", "error: " + e.message, "tr-note")); }
  }

  /* ---------- Service logs ---------- */
  const logs = { paused: false, data: null };
  const level = (l) => (/\b(ERROR|CRITICAL|FATAL)\b|Traceback|Exception|\s5\d\d\s/i.test(l) ? "lv-error" : /\bWARN(ING)?\b|\s4\d\d\s/i.test(l) ? "lv-warn" : /\bDEBUG\b/i.test(l) ? "lv-debug" : "lv-info");
  function renderLogs() {
    const d = logs.data; if (!d) return;
    const s = d.streams[$("l-stream").value], q = $("l-q").value.trim().toLowerCase(), out = $("l-out");
    if (!s) { out.replaceChildren(); $("l-info").textContent = `no ${$("l-stream").value} log for ${d.service} (${d.run} run) — start the app with start-all.ps1 to capture console output in .run\\`; return; }
    const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
    const frag = document.createDocumentFragment();
    for (const l of s.lines) if (!q || l.toLowerCase().includes(q)) frag.appendChild(el("span", l || " ", level(l)));
    out.replaceChildren(frag);
    if (stick) out.scrollTop = out.scrollHeight;
    $("l-info").textContent = `${d.service} · ${d.run} run · ${s.lines.length} lines · ${(s.size / 1024).toFixed(1)} KB · modified ${new Date(s.mtime).toLocaleString()} · secrets masked`;
  }
  async function loadLogs() {
    try {
      const p = new URLSearchParams({ tail: $("l-tail").value }); if ($("l-run").value === "prev") p.set("run", "prev");
      logs.data = await get(`/dev/api/logs/${$("l-svc").value}?` + p);
      renderLogs();
    } catch (e) { $("l-info").textContent = "error: " + e.message + " (service log capture not configured?)"; }
  }
  setInterval(() => { if (st.tab === "logs" && !logs.paused && $("l-auto").checked) loadLogs(); }, 3000);

  function showTab(name) {
    st.tab = name;
    for (const b of document.querySelectorAll(".tr-tabs button")) b.classList.toggle("active", b.dataset.tab === name);
    for (const s of document.querySelectorAll(".tr-tab")) s.hidden = s.id !== "tab-" + name;
    if (name === "jobs") get("/dev/api/jobs").then((d) => renderJobs(d.items)).catch(() => {});
    if (name === "history") loadHistory();
    if (name === "stats") loadStats();
    if (name === "logs") loadLogs();
  }
  function wireExtraTabs() {
    setHistType();
    $("h-type").addEventListener("change", () => { setHistType(); hist.offset = 0; loadHistory(); });
    for (const id of ["h-date", "h-layer", "h-status"]) $(id).addEventListener("change", () => { hist.offset = 0; loadHistory(); });
    $("h-go").addEventListener("click", () => { hist.offset = 0; loadDays().then(loadHistory); });
    $("h-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { hist.offset = 0; loadHistory(); } });
    $("h-prev").addEventListener("click", () => { hist.offset = Math.max(0, hist.offset - PAGE); loadHistory(); });
    $("h-next").addEventListener("click", () => { hist.offset += PAGE; loadHistory(); });
    $("h-csv").addEventListener("click", () => exportHistory("csv"));
    $("h-jsonl").addEventListener("click", () => exportHistory("jsonl"));
    for (const id of ["s-date", "s-layer"]) $(id).addEventListener("change", loadStats);
    $("s-go").addEventListener("click", () => loadDays().then(loadStats));
    for (const id of ["l-svc", "l-run", "l-tail"]) $(id).addEventListener("change", loadLogs);
    $("l-stream").addEventListener("change", renderLogs);
    $("l-q").addEventListener("input", renderLogs);
    $("l-pause").addEventListener("click", () => { logs.paused = !logs.paused; $("l-pause").textContent = logs.paused ? "Resume" : "Pause"; if (!logs.paused) loadLogs(); });
  }

  document.addEventListener("DOMContentLoaded", () => {
    for (const b of document.querySelectorAll(".tr-tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
    for (const id of ["f-layer", "f-status", "f-text"]) $(id).addEventListener("input", renderRequests);
    wireExtraTabs();
    $("f-dev").addEventListener("change", () => { st.includeDev = $("f-dev").checked; st.reqs = []; st.reqSince = 0; tick(); });
    $("pause").addEventListener("click", () => {
      st.paused = !st.paused;
      $("pause").textContent = st.paused ? "Resume" : "Pause";
      $("status").textContent = st.paused ? "paused" : "resuming...";
      if (!st.paused) tick();
    });
    tick();
    setInterval(tick, POLL_MS);
  });
})();
