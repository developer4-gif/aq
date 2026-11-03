/* AQ Learning - developer "how it works" scene.
   Hand-written 3D: points are rotated (yaw/pitch orbit camera), perspective-projected and drawn with Canvas 2D,
   painter-sorted by depth. No libraries, no inline script, all API data goes through textContent. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("scene");
  const ctx = canvas.getContext("2d");
  const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrowMQ = window.matchMedia("(max-width: 760px)");

  // ------------------------------------------------------------------ layers & nodes
  const LAYERS = [
    { id: "client", name: "Client (browser)", z: -330, color: "#e9e9e9" },
    { id: "server", name: "Server - aq-api :5180", z: -110, color: "#b8c4d6" },
    { id: "worker", name: "Worker - Flask :5055", z: 110, color: "#c9b8d6" },
    { id: "external", name: "External services", z: 330, color: "#d6c9b0" },
  ];
  const L = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

  const NODES = [
    { id: "user", layer: "client", x: -170, y: 215, label: "User", kind: "Person",
      desc: "The learner. Opens the app, builds playlists, clicks Generate notes or Smart arrange.",
      files: [], port: "-", io: ["In: rendered pages, notes, PDFs", "Out: clicks, playlist edits, YouTube links"] },
    { id: "ui", layer: "client", x: 150, y: 215, label: "Browser UI", kind: "Vanilla JS app",
      desc: "Single-page UI served by aq-api. app.js drives playlists, the player and notes; smart.js / smartmagic.js drive Smart arrange; water.js is the visual effect layer. It polls job status while notes or smart runs are in progress.",
      files: ["lecture-notes-ui/index.html", "lecture-notes-ui/app.js", "lecture-notes-ui/smart.js", "lecture-notes-ui/smartmagic.js", "lecture-notes-ui/water.js", "lecture-notes-ui/styles.css"],
      port: "loaded from 127.0.0.1:5180", io: ["In: JSON from /api/v1/*, notes HTML/PDF", "Out: fetch() calls to /api/v1/*"] },
    { id: "api", layer: "server", x: -30, y: 220, label: "aq-api", sub: "Express 5", kind: "Node server", health: "api",
      desc: "Express 5 app. Security headers, host guard, CORS, then /api/v1 routes (playlists, progress, notes, smart, misc). Serves the UI as static files and proxies heavy work to the Python worker. Job rows in SQLite are refreshed from the worker on poll (throttled).",
      files: ["aq-api/src/app.js", "aq-api/src/server.js", "aq-api/src/routes/*.js", "aq-api/src/notes-service.js", "aq-api/src/smart-service.js", "aq-api/src/pyclient.js", "aq-api/src/repo.js"],
      port: "127.0.0.1:5180", io: ["In: HTTP from the UI", "Out: SQL to SQLite, HTTP to the worker /api/*"] },
    { id: "db", layer: "server", x: 250, y: 220, label: "SQLite", sub: "node:sqlite", kind: "Database",
      desc: "Embedded database via node:sqlite. Stores playlists, videos, progress, notes_jobs (queued/running/done/error/expired, stage, pct) and smart runs.",
      files: ["aq-api/src/db.js", "aq-api/sql/001_init.sql", "aq-api/sql/002_smart_runs.sql"],
      port: "file (in-process)", io: ["In: queries from repo / services", "Out: rows"] },
    { id: "worker", layer: "worker", x: -40, y: 10, label: "Python worker", sub: "Flask", kind: "Job server", health: "worker",
      desc: "Flask server. POST /api/jobs starts a notes job in a background thread, POST /api/smart starts a Smart run; GET /api/jobs/<id> and /api/smart/<id> report status, stage and pct. Serves notes.html / notes.pdf / notes.json.",
      files: ["lecture-notes-ai/backend/app/server.py"], port: "127.0.0.1:5055",
      io: ["In: job requests from aq-api", "Out: job status JSON, notes HTML/PDF"] },
    { id: "transcript", layer: "worker", x: -320, y: -140, label: "Transcript", sub: "ingest", kind: "notes_engine stage",
      desc: "Fetches captions with youtube-transcript-api, falls back to yt-dlp, and to Groq Whisper speech-to-text when no captions exist. Results are cached. Stage 'transcript' (0-25%).",
      files: ["notes_engine/ingest.py", "notes_engine/cache.py"], port: "-", io: ["In: video id", "Out: timed transcript segments + meta"] },
    { id: "digest", layer: "worker", x: -170, y: -140, label: "Digest", kind: "LLM stage",
      desc: "Long transcripts are chunked; each chunk is digested by the LLM into a compact summary with a word budget.",
      files: ["notes_engine/llm.py (_digest_chunks)", "notes_engine/prompts.py (digest_messages)"], port: "-", io: ["In: transcript chunks", "Out: digests"] },
    { id: "compose", layer: "worker", x: -20, y: -140, label: "Compose", kind: "LLM stage",
      desc: "Builds the outline / sections from the digests (or directly from short transcripts), in batches with coverage checks.",
      files: ["notes_engine/llm.py (_compose_batch, _compose_covered)", "notes_engine/prompts.py"], port: "-", io: ["In: digests", "Out: outline + key terms"] },
    { id: "final", layer: "worker", x: 130, y: -140, label: "Final", kind: "LLM stage",
      desc: "Writes the final notebook content from the outline and terms (compose_final_messages).",
      files: ["notes_engine/prompts.py (compose_final_messages)", "notes_engine/llm.py"], port: "-", io: ["In: outline, terms", "Out: raw notes JSON"] },
    { id: "validate", layer: "worker", x: 280, y: -140, label: "Validate", kind: "Code check",
      desc: "validate_notes() checks and repairs the LLM output against the notes schema and the transcript.",
      files: ["notes_engine/notes_schema.py"], port: "-", io: ["In: raw notes", "Out: clean notes dict"] },
    { id: "render", layer: "worker", x: 300, y: 30, label: "HTML / PDF", sub: "render", kind: "Renderer",
      desc: "render_html() draws the hand-drawn notebook (SVG diagrams); render_pdf() prints it. Stage 'pdf' (85-100%).",
      files: ["notes_engine/pdf.py", "notes_engine/__init__.py (render_notes)", "notes_engine/templates/"], port: "-", io: ["In: notes dict", "Out: notes.html, notes.pdf"] },
    { id: "profiler", layer: "worker", x: -300, y: 160, label: "Profiler", sub: "agent 1", kind: "Smart agent",
      desc: "Agent 1 reads transcript excerpts (start, middle, end windows) and states what each video teaches, with quoted evidence.",
      files: ["notes_engine/smart_playlist.py (_ask_profiles)"], port: "-", io: ["In: excerpts + goal", "Out: profiles"] },
    { id: "sequencer", layer: "worker", x: -140, y: 160, label: "Sequencer", sub: "agent 2", kind: "Smart agent",
      desc: "Agent 2 reads the profiles and the learner goal and proposes the watch order.",
      files: ["notes_engine/smart_playlist.py"], port: "-", io: ["In: profiles + goal", "Out: proposed order"] },
    { id: "gap", layer: "worker", x: 20, y: 160, label: "Gap analyst", sub: "agent 3", kind: "Smart agent",
      desc: "Agent 3 reports covered and missing areas and what to add.",
      files: ["notes_engine/smart_playlist.py"], port: "-", io: ["In: profiles + goal", "Out: coverage + gaps"] },
    { id: "verify", layer: "worker", x: 180, y: 160, label: "Code checks", kind: "Verification",
      desc: "The agents only propose. Plain code verifies quotes really appear in the transcript and every video id exists exactly once, then assembles the result.",
      files: ["notes_engine/smart_playlist.py (_is_grounded, _clean_videos)", "docs/smart-playlist-contract.md"], port: "-", io: ["In: agent proposals", "Out: verified smart result"] },
    { id: "youtube", layer: "external", x: -260, y: 0, label: "YouTube", sub: "captions / yt-dlp", kind: "External",
      desc: "Caption tracks via youtube-transcript-api, media/captions via yt-dlp. Groq Whisper transcribes audio when captions are missing.",
      files: ["notes_engine/ingest.py"], port: "HTTPS", io: ["In: video id", "Out: captions / audio"] },
    { id: "llm", layer: "external", x: 40, y: 0, label: "LLM provider", sub: "gemini / groq / xai / hf", kind: "External",
      desc: "Pluggable providers selected per job: Gemini, Groq, xAI, Hugging Face, or Colab. Listed by GET /api/providers on the worker.",
      files: ["notes_engine/llm.py"], port: "HTTPS", io: ["In: chat messages", "Out: JSON text"] },
    { id: "colab", layer: "external", x: 290, y: 20, label: "Colab Qwen", sub: "cloudflared", kind: "Optional provider",
      desc: "Optional self-hosted Qwen model in a Google Colab notebook, exposed through a cloudflared tunnel. The worker reads COLAB_LLM_URL; the link changes every Colab session.",
      files: ["notes_engine/llm.py (colab provider)"], port: "https://*.trycloudflare.com", io: ["In: chat messages", "Out: completions"] },
  ];
  const N = Object.fromEntries(NODES.map((n) => [n.id, n]));
  NODES.forEach((n) => { n.z = L[n.layer].z; n.color = L[n.layer].color; n.glow = 0; n.status = null; });

  const EDGE_LIST = [
    ["user", "ui"], ["ui", "api"], ["api", "db"], ["api", "worker"],
    ["worker", "transcript"], ["transcript", "youtube"], ["transcript", "digest"], ["digest", "compose"], ["compose", "final"],
    ["final", "validate"], ["validate", "render"], ["render", "worker"],
    ["digest", "llm"], ["compose", "llm"], ["final", "llm"], ["llm", "colab"],
    ["transcript", "profiler"], ["profiler", "llm"], ["profiler", "sequencer"], ["profiler", "gap"],
    ["sequencer", "llm"], ["gap", "llm"], ["sequencer", "verify"], ["gap", "verify"], ["verify", "worker"],
  ];
  const ekey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  const EDGES = new Map(EDGE_LIST.map(([a, b]) => [ekey(a, b), { a, b, glow: 0 }]));

  // ------------------------------------------------------------------ flows
  const S = (from, to, cap) => ({ from, to, cap });
  const FLOWS = [
    { id: "open", name: "1. Open app & playlists", steps: [
      S("user", "ui", "User opens http://127.0.0.1:5180 in the browser."),
      S("ui", "api", "Browser loads index.html, app.js, styles.css: aq-api serves them with express.static under a strict CSP."),
      S("ui", "api", "app.js calls GET /api/v1/me and GET /api/v1/playlists."),
      S("api", "db", "repo.js reads playlists, videos and progress from SQLite (node:sqlite)."),
      S("api", "ui", "JSON comes back; the UI renders the playlist grid and the player."),
      S("ui", "api", "Watching updates progress: PUT /api/v1/progress/:videoId."),
      S("api", "db", "Progress row is upserted in SQLite."),
    ] },
    { id: "notes", name: "2. Generate notes", steps: [
      S("user", "ui", "User clicks Generate notes on a video."),
      S("ui", "api", "POST /api/v1/notes/:videoId (rate-limited by heavyLimiter)."),
      S("api", "db", "notes-service checks for a live job; otherwise inserts a notes_jobs row (queued)."),
      S("api", "worker", "pyclient.js POSTs /api/jobs to the Flask worker; the job id is stored on the row."),
      S("worker", "transcript", "Worker thread starts: stage 'transcript', pct 1."),
      S("transcript", "youtube", "Captions via youtube-transcript-api, then yt-dlp, then Groq Whisper as fallback."),
      S("transcript", "digest", "Stage 'notes' (25%+): the transcript is chunked."),
      S("digest", "llm", "Each chunk is digested by the selected LLM provider."),
      S("digest", "compose", "Digests feed the compose step."),
      S("compose", "llm", "LLM builds the outline / sections in batches with coverage checks."),
      S("compose", "final", "Outline and key terms go to the final writer."),
      S("final", "llm", "LLM writes the final notebook JSON."),
      S("final", "validate", "validate_notes() checks and repairs it against the schema and transcript."),
      S("validate", "render", "Stage 'pdf' (85%+): render_html() draws the notebook, render_pdf() prints it."),
      S("render", "worker", "Job is marked done, pct 100: 'Your notebook is ready.'"),
      S("ui", "api", "Meanwhile the UI polls GET /api/v1/notes/:videoId."),
      S("api", "worker", "notes-service refreshes the row from GET /api/jobs/<id> (throttled by pollMinMs)."),
      S("api", "db", "Row updated: running -> done (state 'ready')."),
      S("api", "ui", "UI shows the notes: GET /api/v1/notes/:videoId/html and /pdf are proxied from the worker."),
    ] },
    { id: "smart", name: "3. Smart arrange", steps: [
      S("user", "ui", "User opens Smart arrange on a playlist and enters a goal."),
      S("ui", "api", "POST /api/v1/playlists/:id/smart."),
      S("api", "db", "smart-service records a smart run (002_smart_runs.sql)."),
      S("api", "worker", "POST /api/smart to the worker with the videos and goal."),
      S("worker", "transcript", "Stage 'transcripts': excerpts are fetched for every video."),
      S("transcript", "youtube", "Start, middle and end windows of each transcript (cached)."),
      S("transcript", "profiler", "Excerpts go to Agent 1."),
      S("profiler", "llm", "Profiler: what each video teaches, with quoted evidence."),
      S("profiler", "sequencer", "Compact profiles go to Agent 2."),
      S("sequencer", "llm", "Sequencer proposes the watch order."),
      S("profiler", "gap", "Profiles also go to Agent 3."),
      S("gap", "llm", "Gap analyst lists covered and missing areas."),
      S("sequencer", "verify", "Proposed order goes to the code checks."),
      S("gap", "verify", "Gap report goes to the code checks."),
      S("verify", "worker", "Quotes must appear in the transcript; every video id exactly once. Result stored on the job."),
      S("ui", "api", "UI polls GET /api/v1/playlists/:id/smart."),
      S("api", "worker", "smart-service reads GET /api/smart/<id>."),
      S("api", "db", "Run state saved (ready / error)."),
      S("api", "ui", "smart.js / smartmagic.js animate the new order and show the gaps."),
    ] },
    { id: "colab", name: "4. Colab Qwen provider", steps: [
      S("user", "ui", "User picks the Colab provider for a notes job."),
      S("ui", "api", "POST /api/v1/notes/:videoId with the provider choice."),
      S("api", "worker", "Job is forwarded to the worker."),
      S("worker", "transcript", "Transcript stage as usual."),
      S("transcript", "digest", "LLM stages start."),
      S("digest", "llm", "llm.py resolves the 'colab' provider."),
      S("llm", "colab", "Requests go to COLAB_LLM_URL, a cloudflared tunnel into the Colab notebook running Qwen."),
      S("colab", "llm", "Completions come back over the tunnel. The URL changes every Colab session, so it must be updated."),
      S("final", "validate", "Output is validated exactly like other providers."),
      S("validate", "render", "Rendered to HTML / PDF."),
    ] },
  ];

  // ------------------------------------------------------------------ camera
  const cam = { yaw: -0.32, pitch: 0.2, dist: 1500, tYaw: -0.32, tPitch: 0.2, tDist: 1500 };
  const resetCam = () => { cam.tYaw = narrowMQ.matches ? -0.12 : -0.32; cam.tPitch = narrowMQ.matches ? 0.12 : 0.2; cam.tDist = narrowMQ.matches ? 1150 : 1450; };
  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function project(x, y, z) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
    const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const depth = z2 + cam.dist;
    const f = Math.min(W, H * 1.4) * 1.05;
    const s = f / Math.max(depth, 50);
    return { x: W / 2 + x1 * s, y: H / 2 - 30 + y1 * s, s, d: depth };
  }

  // ------------------------------------------------------------------ playback
  const sel = $("flowSel");
  FLOWS.forEach((f) => { const o = document.createElement("option"); o.value = f.id; o.textContent = f.name; sel.appendChild(o); });
  let flow = FLOWS[0], step = -1, playing = false, stepT = 0;
  const packets = [];   // {a,b,t,speed,live}
  const STEP_MS = 2300;

  function setCaption() {
    $("stepN").textContent = step < 0 ? "" : (step + 1) + "/" + flow.steps.length;
    $("stepText").textContent = step < 0 ? "Press Play or Step to walk through \"" + flow.name.slice(3) + "\"." : flow.steps[step].cap;
  }
  function edgeOf(a, b) { return EDGES.get(ekey(a, b)); }
  function fire(a, b, live) {
    const e = edgeOf(a, b); if (!e) return;
    e.glow = 1; N[b].glow = Math.max(N[b].glow, live ? 0.7 : 1);
    if (!reduceMQ.matches) packets.push({ a, b, t: 0, speed: live ? 1.6 : 0.9, live });
    if (packets.length > 120) packets.splice(0, packets.length - 120);
  }
  function goStep(i) {
    step = (i + flow.steps.length) % flow.steps.length;
    const s = flow.steps[step];
    fire(s.from, s.to, false);
    N[s.from].glow = Math.max(N[s.from].glow, 0.6);
    stepT = 0; setCaption();
  }
  function setPlaying(p) { playing = p; $("playBtn").setAttribute("aria-pressed", String(p)); $("playBtn").textContent = p ? "Pause" : "Play"; if (p && step < 0) goStep(0); }
  sel.addEventListener("change", () => { flow = FLOWS.find((f) => f.id === sel.value) || FLOWS[0]; step = -1; packets.length = 0; setCaption(); });
  $("playBtn").addEventListener("click", () => setPlaying(!playing));
  $("nextBtn").addEventListener("click", () => { setPlaying(false); goStep(step + 1); });
  $("prevBtn").addEventListener("click", () => { setPlaying(false); goStep(step < 0 ? flow.steps.length - 1 : step - 1); });
  $("resetBtn").addEventListener("click", resetCam);

  // ------------------------------------------------------------------ side panel
  const side = $("side");
  let selected = null;
  function addDt(dl, label, value) {
    const dt = document.createElement("dt"); dt.textContent = label; dl.appendChild(dt);
    const dd = document.createElement("dd");
    if (Array.isArray(value)) {
      if (!value.length) dd.textContent = "-";
      else { const ul = document.createElement("ul"); value.forEach((v) => { const li = document.createElement("li"); const c = document.createElement("code"); c.textContent = v; li.appendChild(c); ul.appendChild(li); }); dd.appendChild(ul); }
    } else dd.textContent = value;
    dl.appendChild(dd);
  }
  function showNode(n) {
    selected = n ? n.id : null;
    const dl = $("sDl"); dl.textContent = "";
    if (!n) {
      $("sKind").textContent = "Overview"; $("sTitle").textContent = "How AQ Learning works";
      $("sDesc").textContent = "Four layers, front to back: the browser client, the Node aq-api server with SQLite, the Python worker with notes_engine, and external services. Pick a flow and press Play, or click any node.";
      if (narrowMQ.matches) side.hidden = true;
      return;
    }
    side.hidden = false;
    $("sKind").textContent = n.kind + " - " + L[n.layer].name;
    $("sTitle").textContent = n.label;
    $("sDesc").textContent = n.desc;
    addDt(dl, "Implemented in", n.files);
    addDt(dl, "Port / address", n.port);
    addDt(dl, "Inputs / outputs", n.io);
    const links = [];
    EDGES.forEach((e) => { if (e.a === n.id) links.push(N[e.b].label); else if (e.b === n.id) links.push(N[e.a].label); });
    addDt(dl, "Connected to", links.join(", "));
    if (n.health && live.on) addDt(dl, "Live status", n.statusText || "unknown");
  }
  $("closeBtn").addEventListener("click", () => showNode(null));

  // ------------------------------------------------------------------ input: orbit, zoom, pick
  let drag = null, hits = [];
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw: cam.tYaw, pitch: cam.tPitch, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) { canvas.style.cursor = pick(e) ? "pointer" : ""; return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; canvas.classList.add("dragging"); }
    cam.tYaw = drag.yaw - dx * 0.006;
    cam.tPitch = Math.max(-1.2, Math.min(1.2, drag.pitch + dy * 0.006));
  });
  canvas.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved) { const n = pick(e); showNode(n); }
    drag = null; canvas.classList.remove("dragging");
  });
  canvas.addEventListener("pointercancel", () => { drag = null; canvas.classList.remove("dragging"); });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); cam.tDist = Math.max(700, Math.min(3200, cam.tDist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: false });
  function pick(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.n; }
    return null;
  }
  window.addEventListener("keydown", (e) => {
    if (e.target && /SELECT|INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") cam.tYaw += 0.1; else if (e.key === "ArrowRight") cam.tYaw -= 0.1;
    else if (e.key === "ArrowUp") cam.tPitch = Math.min(1.2, cam.tPitch + 0.1); else if (e.key === "ArrowDown") cam.tPitch = Math.max(-1.2, cam.tPitch - 0.1);
  });

  // ------------------------------------------------------------------ drawing
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function hexA(hex, a) { const v = parseInt(hex.slice(1), 16); return "rgba(" + (v >> 16) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")"; }
  const FONT = getComputedStyle(document.body).fontFamily;

  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    const narrow = narrowMQ.matches;
    // layer planes (back to front)
    const planes = LAYERS.map((l) => {
      const c = [[-430, -250], [430, -250], [430, 250], [-430, 250]].map(([x, y]) => project(x, y, l.z));
      return { l, c, d: project(0, 0, l.z).d };
    }).sort((p, q) => q.d - p.d);
    planes.forEach(({ l, c }) => {
      ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = hexA(l.color, 0.025); ctx.fill();
      ctx.strokeStyle = hexA(l.color, 0.16); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = hexA(l.color, 0.55); ctx.font = "500 " + Math.max(9, Math.min(12, 11 * c[0].s * 1.4)) + "px " + FONT;
      ctx.fillText(l.name.toUpperCase(), c[0].x + 8, c[0].y + 16);
    });
    // nodes projection
    const P = {}; NODES.forEach((n) => { P[n.id] = project(n.x, n.y, n.z); });
    // edges
    EDGES.forEach((e) => {
      const a = P[e.a], b = P[e.b];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(255,255,255," + (0.12 + e.glow * 0.7) + ")";
      ctx.lineWidth = 1 + e.glow * 2; ctx.stroke();
      e.glow = Math.max(0, e.glow - dt / 1800);
    });
    // packets
    for (let i = packets.length - 1; i >= 0; i--) {
      const k = packets[i]; k.t += dt / 1000 * k.speed;
      if (k.t >= 1) { packets.splice(i, 1); continue; }
      const a = P[k.a], b = P[k.b], t = k.t;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, r = Math.max(2.5, 6 * a.s * 1.4);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      g.addColorStop(0, k.live ? "rgba(155,231,176,.9)" : "rgba(255,255,255,.95)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    }
    // nodes, far to near
    hits = [];
    const order = NODES.slice().sort((p, q) => P[q.id].d - P[p.id].d);
    order.forEach((n) => {
      const p = P[n.id], sc = p.s * (narrow ? 1.15 : 1.4);
      const fs = Math.max(9, Math.min(16, 13 * sc));
      ctx.font = "600 " + fs + "px " + FONT;
      const tw = ctx.measureText(n.label).width;
      const showSub = n.sub && !narrow && sc > 0.75;
      const w = tw + 22 * sc + 16, h = (showSub ? 40 : 28) * Math.max(0.7, sc);
      const x = p.x - w / 2, y = p.y - h / 2;
      const isSel = selected === n.id;
      if (n.glow > 0.01) { ctx.shadowColor = hexA(n.color, 0.9); ctx.shadowBlur = 24 * n.glow; }
      rrect(x, y, w, h, 8 * Math.max(0.7, sc));
      ctx.fillStyle = "rgba(14,14,14,.94)"; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = isSel ? "#ffffff" : hexA(n.color, 0.35 + n.glow * 0.6); ctx.lineWidth = isSel ? 2 : 1; ctx.stroke();
      // health dot
      if (n.status) { ctx.fillStyle = n.status === "ok" ? "#9be7b0" : "#ff8a8a"; ctx.beginPath(); ctx.arc(x + w - 7, y + 7, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = "#f4f4f4"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(n.label, p.x, showSub ? p.y - fs * 0.45 : p.y);
      if (showSub) { ctx.font = Math.max(8, fs * 0.72) + "px " + FONT; ctx.fillStyle = "#9a9a9a"; ctx.fillText(n.sub, p.x, p.y + fs * 0.65); }
      ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
      if (n.badge) { ctx.font = "600 10px " + FONT; ctx.fillStyle = "#f3d38a"; ctx.fillText(n.badge, x, y - 5); }
      hits.push({ n, x, y, w, h });
      n.glow = Math.max(0, n.glow - dt / 1600);
    });
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    const k = reduceMQ.matches ? 1 : 1 - Math.pow(0.001, dt / 1000 * 1.2);
    cam.yaw += (cam.tYaw - cam.yaw) * k; cam.pitch += (cam.tPitch - cam.pitch) * k; cam.dist += (cam.tDist - cam.dist) * k;
    if (playing) { stepT += dt; if (stepT >= STEP_MS) goStep(step + 1); }
    if (W && H) draw(dt);
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ live mode
  const live = { on: false, timer: 0, reqSeq: null, evSeq: null, ok: false };
  const logBox = $("log");
  function setLiveStatus(cls, text) {
    const pill = $("liveStatus"); pill.textContent = "";
    const d = document.createElement("span"); d.className = "dot" + (cls ? " " + cls : ""); pill.appendChild(d);
    const t = document.createElement("span"); t.textContent = text; pill.appendChild(t);
  }
  function logLine(text) {
    logBox.hidden = false;
    const d = document.createElement("div"); d.textContent = text; logBox.insertBefore(d, logBox.firstChild);
    while (logBox.childNodes.length > 40) logBox.removeChild(logBox.lastChild);
  }
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  const REQ_EDGES = { ui: [["user", "ui"], ["ui", "api"]], api: [["ui", "api"], ["api", "db"]], worker: [["api", "worker"]] };
  function onRequest(it) {
    const route = REQ_EDGES[it.layer]; if (!route) return;
    route.forEach(([a, b]) => fire(a, b, true));
    if (it.status >= 500 || it.status === 0) N[it.layer === "worker" ? "worker" : "api"].glow = 1;
    logLine(String(it.method || "") + " " + String(it.path || "") + " " + String(it.status || "") + " " + String(it.ms != null ? it.ms + "ms" : ""));
  }
  function stageEdges(kind, stage, to) {
    const s = String(stage || "").toLowerCase(), t = String(to || "").toLowerCase();
    if (t === "ready" || t === "done") return [["render", "worker"], ["api", "db"], ["api", "ui"]];
    if (t === "error") return [["api", "db"]];
    if (t === "queued") return [["ui", "api"], ["api", "db"], ["api", "worker"]];
    if (s.includes("transcript")) return [["worker", "transcript"], ["transcript", "youtube"]];
    if (kind === "smart") {
      if (s.includes("profil")) return [["transcript", "profiler"], ["profiler", "llm"]];
      if (s.includes("sequen") || s.includes("order")) return [["profiler", "sequencer"], ["sequencer", "llm"]];
      if (s.includes("gap")) return [["profiler", "gap"], ["gap", "llm"]];
      if (s.includes("verif") || s.includes("check")) return [["sequencer", "verify"], ["gap", "verify"]];
      return [["api", "worker"]];
    }
    if (s.includes("pdf") || s.includes("render")) return [["validate", "render"]];
    if (s.includes("notes") || s.includes("digest") || s.includes("compose")) return [["digest", "llm"], ["compose", "llm"], ["final", "llm"]];
    return [["api", "worker"]];
  }
  function onEvent(ev) {
    stageEdges(ev.kind, ev.stage, ev.to).forEach(([a, b]) => fire(a, b, true));
    logLine(String(ev.kind || "") + " " + String(ev.videoId || ev.playlistId || "") + " " + String(ev.from || "") + " -> " + String(ev.to || "") + " " + String(ev.stage || "") + " " + (ev.pct != null ? ev.pct + "%" : ""));
  }
  function setHealth(o) {
    const sv = (o && o.services) || {};
    const a = sv.api || {}, w = sv.worker || {};
    N.api.status = a.ok ? "ok" : "bad";
    N.api.statusText = a.ok ? "up " + Math.round(a.uptimeSec || 0) + " s, pid " + a.pid + ", " + a.rssMb + " MB, node " + a.node : "down";
    N.worker.status = w.ok ? "ok" : "bad";
    N.worker.statusText = w.ok ? "ok, " + w.latencyMs + " ms" : "down" + (w.error ? ": " + w.error : "");
    const c = (o && o.counts) || {}, nn = c.notes || {}, sm = c.smart || {};
    N.worker.badge = (nn.running || sm.running) ? "running: " + ((nn.running || 0) + (sm.running || 0)) : "";
    N.db.badge = c.videos != null ? (c.playlists || 0) + " playlists / " + c.videos + " videos" : "";
    if (selected === "api" || selected === "worker") showNode(N[selected]);
  }
  function clearHealth() { ["api", "worker", "db"].forEach((id) => { N[id].status = null; N[id].badge = ""; }); }
  async function poll() {
    try {
      const o = await getJSON("/dev/api/overview");
      setHealth(o);
      const rq = await getJSON("/dev/api/requests?since=" + (live.reqSeq == null ? 0 : live.reqSeq));
      const ev = await getJSON("/dev/api/events?since=" + (live.evSeq == null ? 0 : live.evSeq));
      if ((live.reqSeq != null && rq.last != null && rq.last < live.reqSeq) || (live.evSeq != null && ev.last != null && ev.last < live.evSeq)) { live.reqSeq = live.evSeq = null; }   // server restarted
      const first = live.reqSeq == null;
      const ri = Array.isArray(rq.items) ? rq.items : [], ei = Array.isArray(ev.items) ? ev.items : [];
      if (!first) { ri.forEach(onRequest); ei.forEach(onEvent); }   // skip the backlog on the first poll
      live.reqSeq = rq.last != null ? rq.last : (ri.length ? ri[ri.length - 1].seq : live.reqSeq || 0);
      live.evSeq = ev.last != null ? ev.last : (ei.length ? ei[ei.length - 1].seq : live.evSeq || 0);
      const ok = N.api.status === "ok" && N.worker.status === "ok";
      setLiveStatus(ok ? "ok" : "warn", ok ? "live - api and worker up" : "live - worker " + (N.worker.status === "ok" ? "up" : "down"));
      live.ok = true;
    } catch (_e) {
      live.ok = false; live.reqSeq = null; live.evSeq = null; clearHealth();
      setLiveStatus("bad", "live data unavailable - demo mode still works");
    }
    if (live.on) live.timer = setTimeout(poll, 2000);
  }
  $("liveBtn").addEventListener("click", () => {
    live.on = !live.on;
    $("liveBtn").setAttribute("aria-pressed", String(live.on));
    clearTimeout(live.timer);
    if (live.on) { setLiveStatus("", "connecting..."); poll(); }
    else { clearHealth(); live.reqSeq = live.evSeq = null; setLiveStatus("", "demo mode"); logBox.hidden = true; }
  });
  document.addEventListener("visibilitychange", () => { if (live.on && !document.hidden) { clearTimeout(live.timer); poll(); } });

  // ------------------------------------------------------------------ start
  window.addEventListener("resize", resize);
  narrowMQ.addEventListener("change", () => { resetCam(); if (narrowMQ.matches && !selected) side.hidden = true; else if (!narrowMQ.matches) side.hidden = false; });
  if (narrowMQ.matches) side.hidden = true;
  resize(); resetCam(); cam.yaw = cam.tYaw; cam.pitch = cam.tPitch; cam.dist = cam.tDist;
  setCaption();
  if (/[?&]live=1/.test(location.search)) $("liveBtn").click();
  if (/[?&]play=1/.test(location.search)) { const m = /[?&]flow=(\w+)/.exec(location.search); if (m) { sel.value = m[1]; sel.dispatchEvent(new Event("change")); } setPlaying(true); }
  requestAnimationFrame(frame);
})();
