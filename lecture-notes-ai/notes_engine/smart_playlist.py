"""Smart playlist: three AI agents plus checks in plain code.

The playlist NAME is the learner's goal; its videos are the topics already covered.

  Agent 1  Profiler    reads transcript excerpts   -> what each video teaches (with quoted evidence)
  Agent 2  Sequencer   reads the profiles + goal   -> the order to watch them in
  Agent 3  Gap analyst reads the profiles + goal   -> covered / missing areas and what to add

The agents only *propose*. Code then verifies: quotes must really appear in the transcript, every video id must
exist, the order must contain each video once, a "covered" area must cite a real playlist video, and suggested
videos are real YouTube search results.

Public surface:
    analyze(goal, videos, provider, api_key, model=None, progress=None) -> {"result": Result, "usage": Usage}
    verify(inputs, a1, a2, a3) -> Result without candidates (pure: no network, unit-tested)
    LLMError (user-safe messages, re-exported from llm)

Transcripts come from ``ingest.get_transcript`` (so they share its 30-day disk cache with the notes pipeline).
A video whose transcript cannot be fetched is still analysed from its title and channel, and `checks` says so.
The API key is only handled by ``llm._Client`` (header only, scrubbed from errors).
"""
from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from . import ingest
from .llm import PROVIDERS, LLMError, _BadJSON, _Client, _clean_key, _OutputTruncated

Progress = Callable[[str, int, str], None]

WINDOW_CHARS = 1200      # how much transcript Agent 1 sees per video: start, middle and end windows
MAX_AREAS = 15
MAX_SUGGESTIONS = 6
CANDIDATES_PER_TOPIC = 2
MIN_CANDIDATE_SEC, MAX_CANDIDATE_SEC = 120, 1500
LEVELS = ("beginner", "intermediate", "advanced")
KINDS = ("overview", "deep-dive", "practice")

# --------------------------------------------------------------------------------------------- prompts
SYS_1 = """You are the Profiler in a learning-playlist assistant. You read transcript excerpts of several videos and \
describe what each video actually teaches. Use ONLY what the excerpt says. Never add outside knowledge.

For every video return:
- level: beginner | intermediate | advanced (judge from the excerpt)
- summary: one plain sentence
- topics: 2 to 5 concepts the video teaches. Each topic has `name` (2-4 words) and `evidence`, a SHORT quote of at most \
12 words copied EXACTLY from the excerpt that proves the video covers it. If you cannot quote it, leave the topic out.
- prerequisites: up to 3 concepts a viewer should already know (short names, may be empty)
If a video has no excerpt (transcript unavailable), judge it from the title only and return an empty topics list.
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
def _report(cb: Progress | None, stage: str, pct: int, msg: str) -> None:
    if cb:
        try:
            cb(stage, max(0, min(100, int(pct))), msg)
        except Exception:  # noqa: BLE001 - a broken progress callback must not kill the job
            pass


def _mmss(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _fmt_dur(sec) -> str:
    sec = int(sec or 0)
    return f"{sec // 60}:{sec % 60:02d}"


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


def _s(v, limit: int = 400) -> str:
    return " ".join(str(v or "").split())[:limit]


def _rows(v) -> list[dict]:
    """The dict items of a list the model returned (anything else is ignored)."""
    return [r for r in v if isinstance(r, dict)] if isinstance(v, list) else []


def _clean_videos(videos: list[dict]) -> list[dict]:
    out, seen = [], set()
    for v in videos or []:
        vid = v.get("id") if isinstance(v, dict) else None
        if not isinstance(vid, str) or not ingest.VIDEO_ID_RE.match(vid) or vid in seen:
            continue
        seen.add(vid)
        d = v.get("duration_sec")
        out.append({"id": vid, "title": _s(v.get("title"), 200) or f"YouTube video {vid}", "channel": _s(v.get("channel"), 120),
                    "duration_sec": int(d) if isinstance(d, (int, float)) and not isinstance(d, bool) and d > 0 else 0})
    return out


# --------------------------------------------------------------------------------------------- transcripts
def _fetch_excerpts(videos: list[dict], progress: Progress | None) -> None:
    """Adds `excerpt` to every video ("" when no transcript could be fetched). Cached by ingest on disk."""
    done = 0

    def one(v: dict) -> None:
        nonlocal done
        try:
            t = ingest.get_transcript(f"https://www.youtube.com/watch?v={v['id']}")
            v["excerpt"] = _excerpt(t["segments"])
        except Exception:  # noqa: BLE001 - IngestError or anything odd: this video is analysed from its title
            v["excerpt"] = ""
        done += 1
        _report(progress, "transcripts", 2 + int(23 * done / len(videos)), f"Reading transcripts ({done}/{len(videos)})...")

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, videos))


# --------------------------------------------------------------------------------------------- agents
def _video_block(v: dict) -> str:
    excerpt = v["excerpt"] or "(transcript unavailable - judge from the title only, topics must be empty)"
    return (f'--- video_id: {v["id"]}\ntitle: {v["title"]}\nchannel: {v["channel"]}\n'
            f'length: {_fmt_dur(v["duration_sec"])}\nexcerpt: {excerpt}')


def _compact_profiles(inputs: dict, profiles: dict) -> str:
    rows = []
    for v in inputs["videos"]:
        p = profiles.get(v["id"], {})
        row = {"video_id": v["id"], "title": v["title"], "length": _fmt_dur(v["duration_sec"]),
               "level": p.get("level", "?"), "summary": p.get("summary", ""),
               "topics": [t["name"] for t in p.get("topics", [])], "prerequisites": p.get("prerequisites", [])}
        if not v["excerpt"]:
            row["note"] = "no transcript, only the title is known"
        rows.append(row)
    return json.dumps(rows, ensure_ascii=False, indent=1)


def _ask_profiles(client: _Client, goal: str, vids: list[dict]) -> list[dict]:
    msgs = (SYS_1, USER_1.format(goal=goal, videos="\n\n".join(_video_block(v) for v in vids)))
    try:
        out = client.ask_json(msgs, max_tokens=1000 * len(vids) + 1200, temperature=0.1)
    except (_OutputTruncated, _BadJSON):
        if len(vids) == 1:
            return []                          # this video gets an empty profile; verify() says so
        mid = len(vids) // 2                   # too much for one reply: half the videos per call
        return _ask_profiles(client, goal, vids[:mid]) + _ask_profiles(client, goal, vids[mid:])
    return _rows(out.get("profiles") if isinstance(out, dict) else out)


def _grounded_profiles(inputs: dict, agent1: dict) -> tuple[dict, dict]:
    """Keep only topics whose quoted evidence really is in the transcript excerpt. Returns (profiles, stats)."""
    by_id = {v["id"]: v for v in inputs["videos"]}
    out, kept, total = {}, 0, 0
    for p in _rows(agent1.get("profiles")):
        vid = p.get("video_id")
        if vid not in by_id:
            continue
        topics = []
        for t in p.get("topics") or []:
            total += 1
            if isinstance(t, dict) and _s(t.get("name"), 80) and _is_grounded(t.get("evidence", ""), by_id[vid]["excerpt"]):
                topics.append({"name": _s(t.get("name"), 80), "evidence": str(t["evidence"])})
                kept += 1
        out[vid] = {"level": p.get("level") if p.get("level") in LEVELS else "?", "summary": _s(p.get("summary")),
                    "topics": topics, "prerequisites": [_s(x, 80) for x in (p.get("prerequisites") or [])][:3]}
    return out, {"topics_claimed": total, "topics_grounded": kept}


# --------------------------------------------------------------------------------------------- verification
def verify(inputs: dict, a1: dict, a2: dict, a3: dict) -> dict:
    """Turns raw agent answers into a safe Result (candidates still empty) and records every correction in `checks`.

    inputs = {"goal": str, "videos": [{"id", "title", "channel", "duration_sec", "excerpt"}]}; excerpt "" = no transcript.
    """
    ids = [v["id"] for v in inputs["videos"]]
    known = set(ids)
    checks: list[str] = []

    blind = [v["title"] for v in inputs["videos"] if not v["excerpt"]]
    if blind:
        checks.append(f"No transcript could be fetched for {len(blind)} video(s) ({'; '.join(t[:50] for t in blind[:5])}); "
                      "they were judged from the title and channel only.")

    profiles, stats = _grounded_profiles(inputs, a1)
    dropped = stats["topics_claimed"] - stats["topics_grounded"]
    checks.append(f"Agent 1: {stats['topics_grounded']} of {stats['topics_claimed']} claimed topics were backed by a quote "
                  f"found in the transcript" + (f"; {dropped} unsupported topic(s) removed." if dropped else "."))
    noprofile = [v for v in ids if v not in profiles]
    if noprofile:
        checks.append(f"Agent 1 returned no profile for {len(noprofile)} video(s); they are shown without topics.")
    video_topics = {}
    for v in ids:
        p = profiles.get(v, {})
        video_topics[v] = {"level": p.get("level") if p.get("level") in LEVELS else "intermediate",
                           "summary": p.get("summary", ""), "topics": [t["name"] for t in p.get("topics", [])]}

    order, seen = [], set()
    for row in _rows(a2.get("order")):
        vid = row.get("video_id")
        if vid in known and vid not in seen:
            seen.add(vid)
            order.append({"video_id": vid, "reason": _s(row.get("reason"))})
    unplaced = []
    for row in _rows(a2.get("unplaced")):
        vid = row.get("video_id")
        if vid in known and vid not in seen:
            seen.add(vid)
            unplaced.append({"video_id": vid, "reason": _s(row.get("reason"))})
    lost = [v for v in ids if v not in seen]
    for vid in lost:
        order.append({"video_id": vid, "reason": "Not placed by the Sequencer, kept at the end."})
    checks.append("Agent 2: every video appears exactly once" + (f"; {len(lost)} missing video(s) re-added at the end." if lost else "."))

    areas, downgraded = [], 0
    for a in _rows(a3.get("areas"))[:MAX_AREAS]:
        name = _s(a.get("area"), 120)
        if not name:
            continue
        status = a.get("status") if a.get("status") in ("covered", "partial", "missing") else "missing"
        cited = []
        for v in a.get("covered_by") or []:
            if v in known and v not in cited:
                cited.append(v)
        if status in ("covered", "partial") and not cited:
            status, downgraded = "missing", downgraded + 1
        if status == "missing":
            cited = []
        areas.append({"area": name, "why": _s(a.get("why")), "status": status, "covered_by": cited,
                      "priority": a.get("priority") if a.get("priority") in ("high", "medium", "low") else "medium"})
    checks.append("Agent 3: every 'covered' claim cites a real video from the playlist"
                  + (f"; {downgraded} claim(s) without a valid citation were changed to 'missing'." if downgraded else "."))

    off_goal, flagged = [], set()
    for r in _rows(a3.get("off_goal")):
        if r.get("video_id") in known and r["video_id"] not in flagged:
            flagged.add(r["video_id"])
            off_goal.append({"video_id": r["video_id"], "reason": _s(r.get("reason"))})
    suggestions = []
    for s in _rows(a3.get("suggestions"))[:MAX_SUGGESTIONS]:
        topic, q = _s(s.get("topic"), 120), _s(s.get("search_query"), 150)
        if topic and q:
            suggestions.append({"topic": topic, "reason": _s(s.get("reason")), "kind": s.get("kind") if s.get("kind") in KINDS else "overview",
                                "search_query": q, "candidates": []})
    return {"goal": inputs["goal"], "path_summary": _s(a2.get("path_summary")), "order": order, "unplaced": unplaced,
            "off_goal": off_goal, "areas": areas, "suggestions": suggestions, "video_topics": video_topics, "checks": checks,
            "stats": {"topics_claimed": stats["topics_claimed"], "topics_grounded": stats["topics_grounded"],
                      "videos_readded_to_order": len(lost), "areas_downgraded_to_missing": downgraded,
                      "suggestions": len(suggestions), "candidates_found": 0}}


# --------------------------------------------------------------------------------------------- candidates
def _search_youtube(query: str, exclude: set[str], limit: int = CANDIDATES_PER_TOPIC) -> list[dict]:
    """Real YouTube search results via yt-dlp (no API key). Skips videos already in the playlist and very short/long ones."""
    try:
        import yt_dlp
        opts = dict(ingest._YTDLP_COMMON, skip_download=True, extract_flat=True, noplaylist=False)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch8:{query}", download=False)
    except Exception:  # noqa: BLE001 - a failed search just means no candidates for this topic
        return []
    found = []
    for e in _rows((info or {}).get("entries")):
        vid, d = e.get("id"), e.get("duration")
        if not isinstance(vid, str) or not ingest.VIDEO_ID_RE.match(vid) or vid in exclude:
            continue
        if not isinstance(d, (int, float)) or isinstance(d, bool) or not MIN_CANDIDATE_SEC <= d <= MAX_CANDIDATE_SEC:
            continue
        found.append({"id": vid, "title": ingest._plain(e.get("title"), 200), "channel": ingest._plain(e.get("channel") or e.get("uploader"), 120),
                      "duration_sec": int(d), "url": f"https://www.youtube.com/watch?v={vid}"})
        if len(found) >= limit:
            break
    return found


def _add_candidates(result: dict, known: set[str]) -> None:
    sugg = result["suggestions"]
    with ThreadPoolExecutor(max_workers=3) as pool:
        hits = list(pool.map(lambda s: _search_youtube(s["search_query"], known), sugg))
    used = set(known)
    for s, cands in zip(sugg, hits):         # one video is offered for one topic only
        s["candidates"] = [c for c in cands if c["id"] not in used]
        used.update(c["id"] for c in s["candidates"])
    n_real = sum(len(s["candidates"]) for s in sugg)
    result["stats"]["candidates_found"] = n_real
    result["checks"].append(f"Suggestions: {n_real} real YouTube candidates found for {len(sugg)} suggested topics "
                            "(candidates are search results, not yet vetted against the transcript).")


# --------------------------------------------------------------------------------------------- usage ledger
class _Meter:
    """Counts the real tokens and seconds of every HTTP call a client makes (Gemini and OpenAI-style responses)."""

    def __init__(self, client: _Client):
        self.calls = self.tokens = 0
        self.api_seconds = 0.0
        real_post = client._post

        def metered_post(url, headers, body):
            t = time.time()
            data = real_post(url, headers, body)
            self.api_seconds += time.time() - t
            self.calls += 1
            u, g = data.get("usage") or {}, data.get("usageMetadata") or {}
            self.tokens += int(u.get("total_tokens") or g.get("totalTokenCount") or 0)
            return data
        client._post = metered_post


# --------------------------------------------------------------------------------------------- public API
def analyze(goal: str, videos: list[dict], provider: str, api_key: str, model: str | None = None,
            progress: Progress | None = None) -> dict:
    """Playlist goal + videos [{id,title,channel,duration_sec}] -> {"result": Result, "usage": Usage}.

    Raises LLMError (user-safe message) on failure. Usage `wall_seconds` is the whole run, `api_seconds` the time spent
    inside the provider's API, `waiting_seconds` the rest (transcripts, rate-limit pacing, searches).
    """
    if provider not in PROVIDERS:
        raise LLMError(f"Unknown provider '{_s(provider, 40)}'. Choose one of: {', '.join(PROVIDERS)}.")
    key = _clean_key(api_key)
    model = (model or "").strip() or PROVIDERS[provider]["default_model"]
    if provider == "gemini":
        model = model.removeprefix("models/")
    if not re.fullmatch(r"[A-Za-z0-9._\-/:]+", model):
        raise LLMError("Invalid model name.")
    goal = _s(goal, 120)
    videos = _clean_videos(videos)
    if not goal or len(videos) < 2:
        raise LLMError("A smart playlist needs a goal (the playlist name) and at least two videos.")

    t0 = time.time()
    client = _Client(provider, key, model)
    meter = _Meter(client)
    try:
        _report(progress, "transcripts", 2, "Reading transcripts...")
        _fetch_excerpts(videos, progress)
        inputs = {"goal": goal, "videos": videos}

        batch = 2 if provider == "groq" else 4         # Groq free tier: ~8k tokens per minute, keep calls small
        profiles: list[dict] = []
        for i in range(0, len(videos), batch):
            _report(progress, "profiling", 25 + int(30 * i / len(videos)),
                    f"Understanding what each video teaches ({min(i + batch, len(videos))}/{len(videos)})...")
            profiles += _ask_profiles(client, goal, videos[i:i + batch])
        a1 = {"profiles": profiles}
        grounded, _stats = _grounded_profiles(inputs, a1)
        compact = _compact_profiles(inputs, grounded)

        n = len(videos)
        _report(progress, "ordering", 56, "Finding the best watch order...")
        a2 = client.ask_json((SYS_2, USER_2.format(goal=goal, profiles=compact)),
                             max_tokens=3500 if provider == "groq" else 2500 + 150 * n, temperature=0.1)
        _report(progress, "gaps", 70, "Looking for gaps against your goal...")
        a3 = client.ask_json((SYS_3, USER_3.format(goal=goal, profiles=compact)), max_tokens=3500, temperature=0.1)

        _report(progress, "checking", 84, "Checking the answers against the transcripts...")
        result = verify(inputs, a1, a2 if isinstance(a2, dict) else {}, a3 if isinstance(a3, dict) else {})
        _report(progress, "candidates", 88, "Finding real videos for the missing topics...")
        _add_candidates(result, {v["id"] for v in videos})
    except LLMError:
        raise
    except Exception as e:  # noqa: BLE001 - never leak internals/keys
        raise LLMError(f"Unexpected error while analysing the playlist ({type(e).__name__}). Please retry.") from None

    wall = time.time() - t0
    usage = {"calls": meter.calls, "total_tokens": meter.tokens, "wall_seconds": round(wall, 1),
             "api_seconds": round(meter.api_seconds, 1), "waiting_seconds": round(max(0.0, wall - meter.api_seconds), 1)}
    return {"result": result, "usage": usage}
