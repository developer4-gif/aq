"""Smart playlist demo: three AI agents plus checks in plain code.

  Agent 1  Profiler   reads transcript excerpts   -> what each video teaches (with quoted evidence)
  Agent 2  Sequencer  reads the profiles + goal   -> the order to watch them in
  Agent 3  Gap analyst reads the profiles + goal  -> covered / missing areas and what to add

The agents only *propose*. Code then verifies: quotes must really appear in the transcript, every video id must
exist, the order must contain each video once, and suggested videos are real search results.

Usage (from lecture-notes-ai/):
  .venv\\Scripts\\python demo\\smart_playlist\\run_demo.py fetch
  .venv\\Scripts\\python demo\\smart_playlist\\run_demo.py agents --provider groq      (needs GROQ_API_KEY)
  .venv\\Scripts\\python demo\\smart_playlist\\run_demo.py agents --provider gemini    (needs GEMINI_API_KEY)
  .venv\\Scripts\\python demo\\smart_playlist\\run_demo.py prompt 1|2|3                (write a prompt to out/ to run it elsewhere)
  .venv\\Scripts\\python demo\\smart_playlist\\run_demo.py finish                      (verify, find videos, build report.html)
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent                      # lecture-notes-ai/
OUT = HERE / "out"
sys.path.insert(0, str(ROOT))
os.environ.setdefault("LNA_CACHE_DIR", str(ROOT / "backend" / ".cache"))

GOAL = "System Design Interview Prep"          # the playlist name IS the goal

# The playlist as the user saved it: deliberately in a poor order, with one video that does not belong.
PLAYLIST = [
    "wh98s0XhMmQ",   # Caching Pitfalls Every Developer Should Know
    "XP98YCr-iXQ",   # What is Database Sharding?
    "BHqjEjzAicA",   # CAP Theorem Simplified
    "U-G-mSd4KAE",   # Learn Python DECORATORS in 7 minutes
    "i7twT3x5yv8",   # System Design Interview: A Step-By-Step Guide
    "_gQaygjm_hg",   # Good APIs Vs Bad APIs
    "sCR3SAVdyCc",   # What is a Load Balancer?
    "_Ss42Vb1SU4",   # SQL vs. NoSQL Explained
]

WINDOW_CHARS = 1200      # how much transcript Agent 1 sees per video: start, middle and end windows
BATCH = 4                # videos per Agent 1 call (keeps each call small enough for free-tier limits)

# --------------------------------------------------------------------------------------------- prompts
SYS_1 = """You are the Profiler in a learning-playlist assistant. You read transcript excerpts of several videos and \
describe what each video actually teaches. Use ONLY what the excerpt says. Never add outside knowledge.

For every video return:
- level: beginner | intermediate | advanced (judge from the excerpt)
- summary: one plain sentence
- topics: 2 to 5 concepts the video teaches. Each topic has `name` (2-4 words) and `evidence`, a SHORT quote of at most \
12 words copied EXACTLY from the excerpt that proves the video covers it. If you cannot quote it, leave the topic out.
- prerequisites: up to 3 concepts a viewer should already know (short names, may be empty)
Return ONE JSON object only."""

USER_1 = """Goal of the playlist (for context only): "{goal}"

Return JSON: {{"profiles":[{{"video_id":"...","level":"...","summary":"...","topics":[{{"name":"...","evidence":"..."}}],"prerequisites":["..."]}}]}}
One profile per video, same order, same video_id.

VIDEOS:
{videos}"""

SYS_2 = """You are the Sequencer in a learning-playlist assistant. Given a learning goal and profiles of the videos a \
learner saved, decide the best order to watch them so that each video builds on the previous ones.

Rules:
- Foundations and overviews first, specialised or advanced material later. Respect each video's prerequisites.
- Put a video that does not serve the goal into `unplaced` with a reason, do not force it into the path.
- Every video_id appears exactly once, either in `order` or in `unplaced`. Use only the ids you are given.
- Each `reason` is one short sentence that refers to what the video teaches.
Return ONE JSON object only."""

USER_2 = """Goal: "{goal}"

Return JSON: {{"order":[{{"video_id":"...","reason":"..."}}],"unplaced":[{{"video_id":"...","reason":"..."}}],"path_summary":"one sentence"}}

VIDEO PROFILES:
{profiles}"""

SYS_3 = """You are the Gap Analyst in a learning-playlist assistant. The playlist name is the learner's GOAL. The saved \
videos are the topics they cover so far. Compare them with what someone pursuing that goal needs.

Rules:
- List 8 to 12 `areas` a learner needs for this goal, from fundamentals to more advanced.
- status: covered (a saved video teaches it), partial (touched on only briefly), missing (no saved video teaches it).
- For covered or partial, `covered_by` must list the video_ids that teach it. Cite only ids you are given, and only if \
that video's topics really include the area. Missing areas have an empty `covered_by`.
- priority: high | medium | low, how important the area is for the goal.
- `suggestions`: for the missing or partial areas with the highest priority (at most 6), give a `search_query` a person \
could type into YouTube to find a good short video on exactly that area, and `kind` (overview | deep-dive | practice).
- Videos that do not belong to the goal go in `off_goal` with a reason.
Return ONE JSON object only."""

USER_3 = """Goal: "{goal}"

Return JSON: {{"areas":[{{"area":"...","why":"one short sentence","status":"covered|partial|missing","covered_by":["video_id"],"priority":"high|medium|low"}}],"suggestions":[{{"topic":"...","reason":"...","search_query":"...","kind":"overview|deep-dive|practice"}}],"off_goal":[{{"video_id":"...","reason":"..."}}]}}

VIDEO PROFILES:
{profiles}"""


# --------------------------------------------------------------------------------------------- helpers
RUN = OUT / "runs" / "default"      # one folder per run (provider x attempt); set from --run in main()
_RUN_FILES = ("agent", "result", "usage", "run_meta", "prompt_", "report")   # files that belong to a run, the rest is shared


def _path(name: str) -> Path:
    return (RUN if name.startswith(_RUN_FILES) else OUT) / name


def _read(name: str):
    return json.loads(_path(name).read_text(encoding="utf-8-sig"))   # -sig: tolerate a BOM from Windows editors


def _write(name: str, obj) -> None:
    _path(name).parent.mkdir(parents=True, exist_ok=True)
    _path(name).write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def _mmss(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _excerpt(segments: list[dict]) -> str:
    """Start, middle and end windows of the transcript (all of it if it is short), with [mm:ss] markers."""
    text = " ".join(f"[{_mmss(s['start'])}] {s['text']}" for s in segments)
    if len(text) <= WINDOW_CHARS * 3:
        return text
    mid = len(text) // 2 - WINDOW_CHARS // 2
    return " ... ".join([text[:WINDOW_CHARS], text[mid:mid + WINDOW_CHARS], text[-WINDOW_CHARS:]])


def _norm(s: str) -> str:
    """Lower-case, drop [mm:ss] markers and punctuation, squeeze spaces: so a quote can be matched to the transcript."""
    s = re.sub(r"\[\d+:\d+\]", " ", s.lower())
    return " ".join(re.sub(r"[^a-z0-9 ]+", "", s).split())


def _is_grounded(quote: str, excerpt: str) -> bool:
    q = _norm(quote or "")
    return len(q.split()) >= 2 and q in _norm(excerpt)


def _fmt_dur(sec) -> str:
    sec = int(sec or 0)
    return f"{sec // 60}:{sec % 60:02d}"


# --------------------------------------------------------------------------------------------- stage: fetch
def cmd_fetch(_args) -> None:
    from notes_engine import ingest
    videos = []
    for i, vid in enumerate(PLAYLIST, 1):
        t = ingest.get_transcript(f"https://www.youtube.com/watch?v={vid}")
        words = sum(len(s["text"].split()) for s in t["segments"])
        videos.append({"id": vid, "position": i, "title": t["title"], "channel": t["channel"],
                       "duration_sec": t["duration_sec"], "words": words, "excerpt": _excerpt(t["segments"])})
        print(f"{i}. {vid}  {_fmt_dur(t['duration_sec'])}  {words} words  {t['title'][:60]}")
    _write("inputs.json", {"goal": GOAL, "videos": videos})
    print("saved out/inputs.json")


# --------------------------------------------------------------------------------------------- prompts per stage
def _compact_profiles(inputs: dict, profiles: dict) -> str:
    rows = []
    for v in inputs["videos"]:
        p = profiles.get(v["id"], {})
        rows.append({"video_id": v["id"], "title": v["title"], "length": _fmt_dur(v["duration_sec"]),
                     "level": p.get("level", "?"), "summary": p.get("summary", ""),
                     "topics": [t["name"] for t in p.get("topics", [])], "prerequisites": p.get("prerequisites", [])})
    return json.dumps(rows, ensure_ascii=False, indent=1)


def _grounded_profiles(inputs: dict, agent1: dict) -> tuple[dict, dict]:
    """Keep only topics whose quoted evidence really is in the transcript excerpt. Returns (profiles, stats)."""
    by_id = {v["id"]: v for v in inputs["videos"]}
    out, kept, total = {}, 0, 0
    for p in agent1.get("profiles", []):
        vid = p.get("video_id")
        if vid not in by_id:
            continue
        topics = []
        for t in p.get("topics", []) or []:
            total += 1
            if isinstance(t, dict) and _is_grounded(t.get("evidence", ""), by_id[vid]["excerpt"]):
                topics.append({"name": str(t.get("name", "")).strip(), "evidence": t["evidence"]})
                kept += 1
        level = p.get("level") if p.get("level") in ("beginner", "intermediate", "advanced") else "?"
        out[vid] = {"level": level, "summary": str(p.get("summary", "")).strip(),
                    "topics": topics, "prerequisites": [str(x) for x in (p.get("prerequisites") or [])][:3]}
    return out, {"topics_claimed": total, "topics_grounded": kept}


def build_prompts(stage: int, batch_index: int = 0, batch: int = BATCH) -> tuple[str, str]:
    inputs = _read("inputs.json")
    if stage == 1:
        vids = inputs["videos"][batch_index * batch:(batch_index + 1) * batch]
        body = "\n\n".join(f'--- video_id: {v["id"]}\ntitle: {v["title"]}\nchannel: {v["channel"]}\n'
                           f'length: {_fmt_dur(v["duration_sec"])}\nexcerpt: {v["excerpt"]}' for v in vids)
        return SYS_1, USER_1.format(goal=inputs["goal"], videos=body)
    profiles, _ = _grounded_profiles(inputs, _read("agent1.json"))
    compact = _compact_profiles(inputs, profiles)
    if stage == 2:
        return SYS_2, USER_2.format(goal=inputs["goal"], profiles=compact)
    return SYS_3, USER_3.format(goal=inputs["goal"], profiles=compact)


def cmd_prompt(args) -> None:
    RUN.mkdir(parents=True, exist_ok=True)
    if args.stage == 1:
        sysm = SYS_1
        user = USER_1.format(goal=_read("inputs.json")["goal"], videos="\n\n".join(
            f'--- video_id: {v["id"]}\ntitle: {v["title"]}\nchannel: {v["channel"]}\n'
            f'length: {_fmt_dur(v["duration_sec"])}\nexcerpt: {v["excerpt"]}' for v in _read("inputs.json")["videos"]))
    else:
        sysm, user = build_prompts(args.stage)
    (RUN / f"prompt_agent{args.stage}.txt").write_text(f"=== SYSTEM ===\n{sysm}\n\n=== USER ===\n{user}\n", encoding="utf-8")
    print(f"wrote {RUN / f'prompt_agent{args.stage}.txt'} ({len(sysm) + len(user)} characters)")


# --------------------------------------------------------------------------------------------- stage: agents (Groq / Gemini)
def cmd_agents(args) -> None:
    from notes_engine import PROVIDERS, ENV_KEYS
    from notes_engine.llm import _Client
    try:                                   # same file the app uses, so the key lives in one place
        from dotenv import load_dotenv
        load_dotenv(ROOT / "backend" / ".env", override=False)
    except ImportError:
        pass
    key = (os.environ.get(ENV_KEYS[args.provider]) or "").strip()
    if not key:
        sys.exit(f"Set {ENV_KEYS[args.provider]} in this terminal first (do not paste it into chat or a file).")
    model = args.model or PROVIDERS[args.provider]["default_model"]
    client = _Client(args.provider, key, model)

    # ---- usage ledger: real token counts from each provider response, real seconds around each HTTP call ----
    calls: list[dict] = []
    current = {"agent": 0, "label": ""}
    real_post = client._post

    def metered_post(url, headers, body):
        t = time.time()
        data = real_post(url, headers, body)
        u = data.get("usage") or {}                       # Groq / OpenAI-style
        g = data.get("usageMetadata") or {}               # Gemini
        reasoning = ((u.get("completion_tokens_details") or {}).get("reasoning_tokens")) or g.get("thoughtsTokenCount") or 0
        prompt_t = u.get("prompt_tokens", g.get("promptTokenCount", 0))
        out_t = u.get("completion_tokens", (g.get("candidatesTokenCount", 0) or 0) + (g.get("thoughtsTokenCount", 0) or 0))
        calls.append({"agent": current["agent"], "label": current["label"], "prompt_tokens": prompt_t,
                      "completion_tokens": out_t, "reasoning_tokens": reasoning,
                      "total_tokens": u.get("total_tokens", g.get("totalTokenCount", prompt_t + out_t)),
                      "api_seconds": round(time.time() - t, 2)})
        return data
    client._post = metered_post

    batch = args.batch or (2 if args.provider == "groq" else BATCH)   # Groq free tier: ~8k tokens per minute, keep calls small
    wall = {}
    run_start = time.time()
    all_videos = _read("inputs.json")["videos"]
    n_batches = -(-len(all_videos) // batch)
    profiles = []
    t0 = time.time()
    for b in range(n_batches):
        current.update(agent=1, label=f"profiler batch {b + 1}/{n_batches}")
        out = client.ask_json(build_prompts(1, b, batch), max_tokens=1000 * batch + 1200, temperature=0.1)
        profiles += out.get("profiles", [])
        print(f"agent 1: batch {b + 1}/{n_batches} done", flush=True)
    _write("agent1.json", {"profiles": profiles})
    wall[1] = time.time() - t0

    for stage, name in ((2, "agent2.json"), (3, "agent3.json")):
        t = time.time()
        current.update(agent=stage, label="sequencer" if stage == 2 else "gap analyst")
        _write(name, client.ask_json(build_prompts(stage), max_tokens=3500, temperature=0.1))
        wall[stage] = time.time() - t
        print(f"agent {stage} done in {wall[stage]:.1f} s", flush=True)

    total_wall = time.time() - run_start
    api_s = sum(c["api_seconds"] for c in calls)
    per_agent = {}
    for a in (1, 2, 3):
        rows = [c for c in calls if c["agent"] == a]
        per_agent[str(a)] = {"calls": len(rows), "prompt_tokens": sum(c["prompt_tokens"] for c in rows),
                             "completion_tokens": sum(c["completion_tokens"] for c in rows),
                             "reasoning_tokens": sum(c["reasoning_tokens"] for c in rows),
                             "total_tokens": sum(c["total_tokens"] for c in rows),
                             "api_seconds": round(sum(c["api_seconds"] for c in rows), 1),
                             "wall_seconds": round(wall[a], 1)}
    _write("usage.json", {"provider": args.provider, "model": model, "source": "provider API responses",
                          "calls": calls, "per_agent": per_agent,
                          "totals": {"calls": len(calls), "prompt_tokens": sum(c["prompt_tokens"] for c in calls),
                                     "completion_tokens": sum(c["completion_tokens"] for c in calls),
                                     "reasoning_tokens": sum(c["reasoning_tokens"] for c in calls),
                                     "total_tokens": sum(c["total_tokens"] for c in calls),
                                     "api_seconds": round(api_s, 1), "wall_seconds": round(total_wall, 1),
                                     "waiting_seconds": round(total_wall - api_s, 1)}})
    _write("run_meta.json", {"provider": args.provider, "model": model})
    print(f"done: {len(calls)} calls, {sum(c['total_tokens'] for c in calls)} tokens, {total_wall:.0f} s wall, {api_s:.0f} s in the API")


# --------------------------------------------------------------------------------------------- stage: finish
def _search_youtube(query: str, exclude: set[str], limit: int = 2) -> list[dict]:
    """Real YouTube search results via yt-dlp (no API key). Skips videos already in the playlist and very long ones."""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "yt_dlp", f"ytsearch8:{query}", "--flat-playlist", "--no-warnings",
             "--print", "%(id)s|%(duration)s|%(channel)s|%(title)s"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})   # titles contain emoji; Windows default is cp1252
    except Exception:  # noqa: BLE001
        return []
    found = []
    for line in (proc.stdout or "").splitlines():
        parts = line.split("|", 3)
        if len(parts) != 4 or parts[0] in exclude or not parts[1].replace(".0", "").isdigit():
            continue
        dur = int(float(parts[1]))
        if 120 <= dur <= 1500:
            found.append({"id": parts[0], "duration_sec": dur, "channel": parts[2], "title": parts[3],
                          "url": f"https://www.youtube.com/watch?v={parts[0]}"})
        if len(found) >= limit:
            break
    return found


def verify(inputs: dict, a1: dict, a2: dict, a3: dict) -> dict:
    """Turns raw agent answers into a safe result and records every correction in `checks`."""
    ids = [v["id"] for v in inputs["videos"]]
    known = set(ids)
    checks: list[str] = []

    profiles, stats = _grounded_profiles(inputs, a1)
    dropped = stats["topics_claimed"] - stats["topics_grounded"]
    checks.append(f"Agent 1: {stats['topics_grounded']} of {stats['topics_claimed']} claimed topics were backed by a quote "
                  f"found in the transcript" + (f"; {dropped} unsupported topic(s) removed." if dropped else "."))

    order, seen = [], set()
    for row in a2.get("order", []) or []:
        vid = row.get("video_id")
        if vid in known and vid not in seen:
            seen.add(vid)
            order.append({"video_id": vid, "reason": str(row.get("reason", "")).strip()})
    unplaced = []
    for row in a2.get("unplaced", []) or []:
        vid = row.get("video_id")
        if vid in known and vid not in seen:
            seen.add(vid)
            unplaced.append({"video_id": vid, "reason": str(row.get("reason", "")).strip()})
    lost = [v for v in ids if v not in seen]
    for vid in lost:
        order.append({"video_id": vid, "reason": "Not placed by the Sequencer, kept at the end."})
    checks.append("Agent 2: every video appears exactly once" + (f"; {len(lost)} missing video(s) re-added at the end." if lost else "."))

    areas, downgraded = [], 0
    for a in a3.get("areas", []) or []:
        status = a.get("status") if a.get("status") in ("covered", "partial", "missing") else "missing"
        cited = [v for v in (a.get("covered_by") or []) if v in known]
        if status in ("covered", "partial") and not cited:
            status, downgraded = "missing", downgraded + 1
        if status == "missing":
            cited = []
        areas.append({"area": str(a.get("area", "")).strip(), "why": str(a.get("why", "")).strip(), "status": status,
                      "covered_by": cited, "priority": a.get("priority") if a.get("priority") in ("high", "medium", "low") else "medium"})
    checks.append("Agent 3: every 'covered' claim cites a real video from the playlist"
                  + (f"; {downgraded} claim(s) without a valid citation were changed to 'missing'." if downgraded else "."))

    off_goal = [r for r in (a3.get("off_goal") or []) if r.get("video_id") in known]
    suggestions = []
    for s in (a3.get("suggestions") or [])[:6]:
        q = str(s.get("search_query", "")).strip()
        cands = _search_youtube(q, known) if q else []
        suggestions.append({"topic": str(s.get("topic", "")).strip(), "reason": str(s.get("reason", "")).strip(),
                            "kind": s.get("kind", ""), "search_query": q, "candidates": cands})
    n_real = sum(len(s["candidates"]) for s in suggestions)
    checks.append(f"Suggestions: {n_real} real YouTube candidates found for {len(suggestions)} suggested topics "
                  "(candidates are search results, not yet vetted against the transcript).")
    return {"goal": inputs["goal"], "profiles": profiles, "order": order, "unplaced": unplaced,
            "path_summary": str(a2.get("path_summary", "")).strip(), "areas": areas, "suggestions": suggestions,
            "off_goal": off_goal, "checks": checks,
            "stats": {"topics_claimed": stats["topics_claimed"], "topics_grounded": stats["topics_grounded"],
                      "videos_readded_to_order": len(lost), "areas_downgraded_to_missing": downgraded,
                      "suggestions": len(suggestions), "candidates_found": n_real}}


def _e(x) -> str:
    return html.escape(str(x))


def render(inputs: dict, res: dict, meta: dict) -> str:
    by_id = {v["id"]: v for v in inputs["videos"]}

    def vtitle(vid):  # a video as a clickable title
        v = by_id[vid]
        return f'<a href="https://www.youtube.com/watch?v={_e(vid)}" target="_blank" rel="noopener">{_e(v["title"])}</a>'

    placed = {r["video_id"]: i + 1 for i, r in enumerate(res["order"])}
    unplaced_ids = {r["video_id"] for r in res["unplaced"]}
    css = """
    :root{--bg:#f7f4ec;--ink:#1d2433;--mut:#5d6677;--card:#fff;--line:#e3ddcc;--ok:#1f7a4d;--warn:#b7791f;--bad:#b42318;--acc:#2b4ea2}
    @media(prefers-color-scheme:dark){:root{--bg:#14171f;--ink:#e8eaf0;--mut:#9aa3b5;--card:#1c212c;--line:#2d3444;--ok:#4cc38a;--warn:#e5b04a;--bad:#f07a6e;--acc:#7da2ff}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,Segoe UI,sans-serif}
    main{max-width:1000px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 4px}
    .sub{color:var(--mut);margin:0 0 14px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
    .row{display:flex;gap:14px;align-items:flex-start}.num{min-width:30px;height:30px;border-radius:50%;background:var(--acc);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
    .num.off{background:var(--mut)}a{color:var(--acc)}.chips span{display:inline-block;background:color-mix(in srgb,var(--acc) 12%,transparent);border-radius:99px;padding:1px 10px;margin:2px 4px 2px 0;font-size:13px}
    .tag{font-size:12px;font-weight:600;border-radius:5px;padding:1px 8px;color:#fff}.covered{background:var(--ok)}.partial{background:var(--warn)}.missing{background:var(--bad)}
    .muted{color:var(--mut);font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
    table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top;font-size:14px}
    .checks li{margin:4px 0}.pill{font-size:12px;color:var(--mut)}
    """
    h = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
         f"<title>Smart playlist demo</title><style>{css}</style></head><body><main>"]
    h.append(f"<h1>Smart playlist: {_e(res['goal'])}</h1>")
    h.append(f"<p class='sub'>Goal = playlist name. {len(by_id)} saved videos analysed from their real transcripts. "
             f"Model: <b>{_e(meta.get('model', 'unknown'))}</b> ({_e(meta.get('provider', ''))}).</p>")

    # --- before / after
    h.append("<h2>1. Your playlist vs. the suggested watch order</h2><p class='sub'>Agent 2 (Sequencer) orders by prerequisites: foundations first.</p><div class='grid'><div>")
    h.append("<div class='muted'>AS SAVED</div>")
    for v in inputs["videos"]:
        new = placed.get(v["id"])
        mark = f"→ #{new}" if new and v["id"] not in unplaced_ids else "→ not in path"
        h.append(f"<div class='card'><b>{v['position']}.</b> {vtitle(v['id'])}<div class='muted'>{_e(v['channel'])} · {_fmt_dur(v['duration_sec'])} · {mark}</div></div>")
    h.append("</div><div><div class='muted'>SUGGESTED ORDER</div>")
    for r in res["order"]:
        if r["video_id"] in unplaced_ids:
            continue
        v, p = by_id[r["video_id"]], res["profiles"].get(r["video_id"], {})
        h.append(f"<div class='card row'><div class='num'>{placed[r['video_id']]}</div><div>{vtitle(r['video_id'])}"
                 f"<div class='muted'>{_e(p.get('level', '?'))} · {_fmt_dur(v['duration_sec'])}</div><div>{_e(r['reason'])}</div></div></div>")
    for r in res["unplaced"]:
        h.append(f"<div class='card row'><div class='num off'>–</div><div>{vtitle(r['video_id'])}<div class='muted'>Not part of this goal</div><div>{_e(r['reason'])}</div></div></div>")
    h.append(f"</div></div><p class='sub'>{_e(res['path_summary'])}</p>")

    # --- profiles
    h.append("<h2>2. What each video really teaches (Agent 1: Profiler)</h2><p class='sub'>Every topic is backed by a quote from the transcript; topics without a verifiable quote are removed.</p>")
    for v in inputs["videos"]:
        p = res["profiles"].get(v["id"], {})
        chips = "".join(f"<span title='{_e(t['evidence'])}'>{_e(t['name'])}</span>" for t in p.get("topics", []))
        h.append(f"<div class='card'>{vtitle(v['id'])} <span class='pill'>· {_e(p.get('level', '?'))}</span><div>{_e(p.get('summary', ''))}</div>"
                 f"<div class='chips'>{chips}</div><div class='muted'>Needs first: {_e(', '.join(p.get('prerequisites', [])) or 'nothing')}. Hover a topic to see the quote that proves it.</div></div>")

    # --- coverage
    covered = sum(a["status"] == "covered" for a in res["areas"])
    h.append(f"<h2>3. Coverage of the goal (Agent 3: Gap analyst)</h2><p class='sub'>{covered} of {len(res['areas'])} areas covered by what you saved.</p>")
    h.append("<div class='card'><table><tr><th>Area needed for the goal</th><th>Status</th><th>Priority</th><th>Covered by</th></tr>")
    for a in res["areas"]:
        by = "<br>".join(vtitle(v) for v in a["covered_by"]) or "<span class='muted'>nothing in the playlist</span>"
        h.append(f"<tr><td><b>{_e(a['area'])}</b><div class='muted'>{_e(a['why'])}</div></td><td><span class='tag {a['status']}'>{a['status']}</span></td><td>{_e(a['priority'])}</td><td>{by}</td></tr>")
    h.append("</table></div>")
    for r in res["off_goal"]:
        h.append(f"<div class='card'><b>Off-goal:</b> {vtitle(r['video_id'])}<div class='muted'>{_e(r.get('reason', ''))}</div></div>")

    # --- suggestions
    h.append("<h2>4. Suggested additions</h2><p class='sub'>Topics your goal needs that the playlist does not cover yet, with real videos to consider.</p>")
    for s in res["suggestions"]:
        cands = "".join(f"<li><a href='{_e(c['url'])}' target='_blank' rel='noopener'>{_e(c['title'])}</a> <span class='muted'>· {_e(c['channel'])} · {_fmt_dur(c['duration_sec'])}</span></li>" for c in s["candidates"]) \
            or "<li class='muted'>No candidate found.</li>"
        h.append(f"<div class='card'><b>{_e(s['topic'])}</b> <span class='pill'>· {_e(s['kind'])}</span><div>{_e(s['reason'])}</div>"
                 f"<div class='muted'>Searched: “{_e(s['search_query'])}”</div><ul>{cands}</ul></div>")

    # --- checks
    h.append("<h2>5. What the code verified</h2><div class='card'><ul class='checks'>" + "".join(f"<li>{_e(c)}</li>" for c in res["checks"]) + "</ul></div>")
    h.append("</main></body></html>")
    return "".join(h)


def cmd_finish(_args) -> None:
    inputs = _read("inputs.json")
    res = verify(inputs, _read("agent1.json"), _read("agent2.json"), _read("agent3.json"))
    _write("result.json", res)
    meta = _read("run_meta.json") if _path("run_meta.json").exists() else {}
    _path("report.html").write_text(render(inputs, res, meta), encoding="utf-8")
    for c in res["checks"]:
        print("-", c)
    print("wrote", _path("report.html"))


def main() -> None:
    global RUN
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    p = sub.add_parser("prompt"); p.add_argument("stage", type=int, choices=(1, 2, 3))
    p = sub.add_parser("agents"); p.add_argument("--provider", choices=("groq", "gemini"), required=True)
    p.add_argument("--model"); p.add_argument("--batch", type=int, help="videos per Agent 1 call")
    sub.add_parser("finish")
    for name, sp in sub.choices.items():
        if name != "fetch":
            sp.add_argument("--run", default="default", help="run label, e.g. groq-1 (folder out/runs/<label>)")
    args = ap.parse_args()
    if args.cmd != "fetch":
        RUN = OUT / "runs" / re.sub(r"[^A-Za-z0-9_.-]", "", args.run)
    {"fetch": cmd_fetch, "prompt": cmd_prompt, "agents": cmd_agents, "finish": cmd_finish}[args.cmd](args)


if __name__ == "__main__":
    main()
