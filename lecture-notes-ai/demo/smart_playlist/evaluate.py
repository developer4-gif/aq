"""Scores every run in out/runs/<label>/ against gold.json and writes out/evaluation.json (see CONTRACT.md).

Usage:  python evaluate.py

Pure offline: reads local JSON only. Every function takes explicit paths/dicts so tests can feed small fixtures.
A missing file or field never raises: the metric gets value null and a display such as "n/a (no result.json)".
"""
from __future__ import annotations

import itertools
import json
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import run_demo  # noqa: E402  (reuse _grounded_profiles: same grounding rule the run itself applies)

OUT = HERE / "out"
STANDIN_LABEL = "claude-standin"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
MIN_CAND_SEC, MAX_CAND_SEC = 120, 1500


# ------------------------------------------------------------------------------------------------ helpers
def load_json(path: Path):
    """Parse a JSON file (BOM tolerant); None when missing or unreadable."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def metric(key, group, label, value, display, unit, direction, detail) -> dict:
    return {"key": key, "group": group, "label": label, "value": value, "display": display,
            "unit": unit, "direction": direction, "detail": detail}


def na(key, group, label, reason, unit, direction, detail) -> dict:
    return metric(key, group, label, None, f"n/a ({reason})", unit, direction, detail)


def _pct(x: float) -> str:
    return f"{int(x * 100 + 0.5)}%"


def _ratio(num: int, den: int, key, group, label, detail, direction="higher", empty_reason="nothing to measure") -> dict:
    if not den:
        return na(key, group, label, empty_reason, "ratio", direction, detail)
    v = num / den
    return metric(key, group, label, round(v, 4), f"{num} / {den} ({_pct(v)})", "ratio", direction, detail)


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _ids(rows) -> list:
    """video ids of [{"video_id": ...}] rows, first occurrence only, order kept."""
    out, seen = [], set()
    for r in rows or []:
        vid = r.get("video_id") if isinstance(r, dict) else None
        if isinstance(vid, str) and vid not in seen:
            seen.add(vid)
            out.append(vid)
    return out


def _text_has(text: str, keywords) -> bool:
    t = (text or "").lower()
    return any(k.lower() in t for k in keywords)


def _fmt_seconds(v: float) -> str:
    s = f"{v:.1f}"
    return (s[:-2] if s.endswith(".0") else s) + " s"


# ------------------------------------------------------------------------------------------------ stats
def derive_stats(result: dict, inputs: dict | None, agent1: dict | None, agent2: dict | None, agent3: dict | None) -> dict:
    """result["stats"] when present, otherwise recomputed from result.json and the raw agent files (no network)."""
    stats = dict(result.get("stats") or {})
    known = {v["id"] for v in (inputs or {}).get("videos", [])}
    if "topics_claimed" not in stats and inputs and agent1 is not None:
        _, g = run_demo._grounded_profiles(inputs, agent1)
        stats.setdefault("topics_claimed", g["topics_claimed"])
        stats.setdefault("topics_grounded", g["topics_grounded"])
    if "videos_readded_to_order" not in stats and agent2 is not None and known:
        placed = set(_ids(agent2.get("order"))) | set(_ids(agent2.get("unplaced")))
        stats["videos_readded_to_order"] = len(known - placed)
    if "areas_downgraded_to_missing" not in stats and agent3 is not None and known:
        n = 0
        for a in agent3.get("areas") or []:
            cited = [v for v in (a.get("covered_by") or []) if v in known]
            if a.get("status") in ("covered", "partial") and not cited:
                n += 1
        stats["areas_downgraded_to_missing"] = n
    if "suggestions" not in stats and isinstance(result.get("suggestions"), list):
        stats["suggestions"] = len(result["suggestions"])
    if "candidates_found" not in stats and isinstance(result.get("suggestions"), list):
        stats["candidates_found"] = sum(len(s.get("candidates") or []) for s in result["suggestions"])
    return stats


# ------------------------------------------------------------------------------------------------ per-run metric groups
def grounding_metrics(result: dict, stats: dict, playlist: list) -> list:
    out = []
    d1 = "Share of claimed topics whose quoted evidence was found in the transcript excerpt (stats.topics_grounded / stats.topics_claimed)."
    claimed, grounded = _num(stats.get("topics_claimed")), _num(stats.get("topics_grounded"))
    if claimed is None or grounded is None:
        out.append(na("grounding_rate", "Grounding", "Topics backed by a transcript quote", "no topic stats", "ratio", "higher", d1))
    else:
        out.append(_ratio(int(grounded), int(claimed), "grounding_rate", "Grounding", "Topics backed by a transcript quote", d1,
                          empty_reason="no topics claimed"))
    d2 = "Playlist videos with at least one grounded topic in result.json profiles, out of all playlist videos."
    profiles = result.get("profiles")
    if not isinstance(profiles, dict) or not playlist:
        out.append(na("videos_profiled", "Grounding", "Videos with a grounded profile",
                      "no profiles" if not isinstance(profiles, dict) else "no playlist", "count", "higher", d2))
    else:
        n = sum(1 for vid in playlist if isinstance(profiles.get(vid), dict) and profiles[vid].get("topics"))
        out.append(metric("videos_profiled", "Grounding", "Videos with a grounded profile", n, f"{n} / {len(playlist)}",
                          "count", "higher", d2))
    return out


def arrangement_metrics(result: dict, stats: dict, gold: dict) -> list:
    out = []
    order_rows = result.get("order")
    fw = gold.get("framework_video")
    cons = gold.get("order_constraints") or []
    n_fw = sum(1 for c in cons if fw and c.get("before") == fw)
    d1 = ("Share of gold before/after rules where the before video sits strictly earlier in the order, and a rule fails if either video is not in the order; "
          + (f"{n_fw} of the {len(cons)} rules are the single 'framework first' opinion." if n_fw else "none of the rules is a 'framework first' rule."))
    d_fw = "1 if the gold framework video is the first entry of the order, else 0."
    d_dep = ("Share of the gold before/after rules not about the framework video (the database-dependency rules only) "
             "where the before video sits strictly earlier in the order; a rule fails if either video is not in the order.")
    d_ff = "Number of videos the run set aside (in unplaced or off_goal) that are not gold off-goal videos."
    d2 = "1 if every gold off-goal video is listed in unplaced (or off_goal) and is absent from the order, else 0."
    d3 = "Number of videos the code had to repair by re-adding them to the end of the order (stats.videos_readded_to_order)."
    if not isinstance(order_rows, list):
        out.append(na("order_constraints_met", "Arrangement", "Order rules satisfied", "no order", "ratio", "higher", d1))
        out.append(na("framework_first", "Arrangement", "Framework video placed first", "no order", "text", "higher", d_fw))
        out.append(na("order_rules_dependency", "Arrangement", "Dependency order rules satisfied", "no order", "ratio", "higher", d_dep))
        out.append(na("off_goal_detected", "Arrangement", "Off-topic video set aside", "no order", "text", "higher", d2))
        out.append(na("off_goal_false_flags", "Arrangement", "Good videos wrongly set aside", "no order", "count", "lower", d_ff))
    else:
        pos = {vid: i for i, vid in enumerate(_ids(order_rows))}
        met = sum(1 for c in cons if c.get("before") in pos and c.get("after") in pos and pos[c["before"]] < pos[c["after"]])
        out.append(_ratio(met, len(cons), "order_constraints_met", "Arrangement", "Order rules satisfied", d1,
                          empty_reason="no gold rules"))
        first = _ids(order_rows)[:1]
        if not fw:
            out.append(na("framework_first", "Arrangement", "Framework video placed first", "no gold framework video", "text", "higher", d_fw))
        else:
            ok_fw = first == [fw]
            out.append(metric("framework_first", "Arrangement", "Framework video placed first", 1 if ok_fw else 0,
                              "yes" if ok_fw else "no", "text", "higher", d_fw))
        dep = [c for c in cons if c.get("before") != fw]
        dep_met = sum(1 for c in dep if c.get("before") in pos and c.get("after") in pos and pos[c["before"]] < pos[c["after"]])
        out.append(_ratio(dep_met, len(dep), "order_rules_dependency", "Arrangement", "Dependency order rules satisfied", d_dep,
                          empty_reason="no dependency rules"))
        off = gold.get("off_goal") or []
        if not off:
            out.append(na("off_goal_detected", "Arrangement", "Off-topic video set aside", "no gold off-goal video", "text", "higher", d2))
        else:
            aside = set(_ids(result.get("unplaced"))) | set(_ids(result.get("off_goal")))
            ok = all(v in aside and v not in pos for v in off)
            out.append(metric("off_goal_detected", "Arrangement", "Off-topic video set aside", 1 if ok else 0,
                              "yes" if ok else "no", "text", "higher", d2))
        flags = len((set(_ids(result.get("unplaced"))) | set(_ids(result.get("off_goal")))) - set(off))
        out.append(metric("off_goal_false_flags", "Arrangement", "Good videos wrongly set aside", flags, str(flags), "count", "lower", d_ff))
    n = _num(stats.get("videos_readded_to_order"))
    out.append(na("order_integrity", "Arrangement", "Videos the code had to repair", "no stats", "count", "lower", d3) if n is None
               else metric("order_integrity", "Arrangement", "Videos the code had to repair", n, str(n), "count", "lower", d3))
    return out


def coverage_metrics(result: dict, stats: dict, gold: dict, playlist: list) -> list:
    out = []
    areas = result.get("areas")
    G, L = "Coverage", None
    d = {
        "gap_recall": "Share of gold expected gaps for which some area titled with one of its keywords has status missing or partial (case-insensitive match on the area title).",
        "gap_recall_suggested": "Share of gold expected gaps found either as a missing/partial area (title match) or because some suggestion has one of the gap's keywords in its topic or search_query (case-insensitive).",
        "extra_gaps_proposed": "Number of missing/partial areas whose title matches none of the gold expected-gap keywords; valid extra gaps are not scored as wrong, read them on the page.",
        "false_covered": "Number of gold expected gaps matched by a covered area while no missing or partial area matches them.",
        "covered_recall": "Share of gold expected-covered topics matched by a covered or partial area whose covered_by includes the gold video.",
        "citation_validity": "Share of covered_by ids, across all areas, that are ids of playlist videos (n/a when nothing is cited).",
        "areas_downgraded": "Number of covered/partial areas the code changed to missing because they cited no valid video (stats.areas_downgraded_to_missing).",
    }
    labels = {"gap_recall": "Expected gaps found", "gap_recall_suggested": "Expected gaps surfaced (areas or suggestions)",
              "extra_gaps_proposed": "Extra gaps proposed beyond the reference",
              "false_covered": "Gaps wrongly called covered",
              "covered_recall": "Expected covered topics found", "citation_validity": "Citations that point to real playlist videos",
              "areas_downgraded": "Areas downgraded to missing"}
    units = {"gap_recall": ("ratio", "higher"), "gap_recall_suggested": ("ratio", "higher"), "extra_gaps_proposed": ("count", "info"), "false_covered": ("count", "lower"), "covered_recall": ("ratio", "higher"),
             "citation_validity": ("ratio", "higher"), "areas_downgraded": ("count", "lower")}
    if not isinstance(areas, list):
        for k in ("gap_recall", "gap_recall_suggested", "extra_gaps_proposed", "false_covered", "covered_recall", "citation_validity"):
            out.append(na(k, G, labels[k], "no areas", units[k][0], units[k][1], d[k]))
    else:
        rows = [(str(a.get("area", "")), str(a.get("status", "")).lower(), a.get("covered_by") or [])
                for a in areas if isinstance(a, dict)]

        def hit(kws, statuses):
            return [r for r in rows if r[1] in statuses and _text_has(r[0], kws)]

        gaps = gold.get("expected_gaps") or []
        found = sum(1 for g in gaps if hit(g.get("keywords", []), ("missing", "partial")))
        out.append(_ratio(found, len(gaps), "gap_recall", G, labels["gap_recall"], d["gap_recall"], empty_reason="no gold gaps"))
        sugg_rows = [f"{x.get('topic', '')} {x.get('search_query', '')}" for x in (result.get("suggestions") or []) if isinstance(x, dict)]
        surfaced = sum(1 for g in gaps if hit(g.get("keywords", []), ("missing", "partial"))
                       or any(_text_has(t, g.get("keywords", [])) for t in sugg_rows))
        out.append(_ratio(surfaced, len(gaps), "gap_recall_suggested", G, labels["gap_recall_suggested"], d["gap_recall_suggested"],
                          empty_reason="no gold gaps"))
        all_kws = [k for g in gaps for k in g.get("keywords", [])]
        extra = sum(1 for r in rows if r[1] in ("missing", "partial") and not _text_has(r[0], all_kws))
        out.append(metric("extra_gaps_proposed", G, labels["extra_gaps_proposed"], extra, str(extra), "count", "info", d["extra_gaps_proposed"]))
        if not gaps:
            out.append(na("false_covered", G, labels["false_covered"], "no gold gaps", "count", "lower", d["false_covered"]))
        else:
            bad = sum(1 for g in gaps if hit(g.get("keywords", []), ("covered",)) and not hit(g.get("keywords", []), ("missing", "partial")))
            out.append(metric("false_covered", G, labels["false_covered"], bad, str(bad), "count", "lower", d["false_covered"]))
        cov = gold.get("expected_covered") or []
        got = sum(1 for c in cov if any(c.get("video") in r[2] for r in hit(c.get("keywords", []), ("covered", "partial"))))
        out.append(_ratio(got, len(cov), "covered_recall", G, labels["covered_recall"], d["covered_recall"], empty_reason="no gold covered topics"))
        cites = [v for r in rows for v in r[2]]
        valid = sum(1 for v in cites if v in set(playlist))
        out.append(_ratio(valid, len(cites), "citation_validity", G, labels["citation_validity"], d["citation_validity"],
                          empty_reason="no citations"))
    n = _num(stats.get("areas_downgraded_to_missing"))
    out.append(na("areas_downgraded", G, labels["areas_downgraded"], "no stats", "count", "lower", d["areas_downgraded"]) if n is None
               else metric("areas_downgraded", G, labels["areas_downgraded"], n, str(n), "count", "lower", d["areas_downgraded"]))
    return out


def suggestion_metrics(result: dict, stats: dict, playlist: list) -> list:
    out, G = [], "Suggestions"
    sugg = result.get("suggestions")
    d1 = "Number of suggestions that came back with at least one candidate video."
    d2 = "stats.candidates_found: the number of real YouTube search results attached to the suggestions."
    d3 = ("Share of all candidates whose id is 11 characters of [A-Za-z0-9_-], whose duration is 120 to 1500 seconds, "
          "and which are not already in the playlist.")
    if not isinstance(sugg, list):
        out.append(na("suggestions_with_candidates", G, "Suggestions with a real video", "no suggestions", "count", "info", d1))
    else:
        n = sum(1 for s in sugg if isinstance(s, dict) and s.get("candidates"))
        out.append(metric("suggestions_with_candidates", G, "Suggestions with a real video", n, f"{n} / {len(sugg)}", "count", "info", d1))
    c = _num(stats.get("candidates_found"))
    if c is None:
        out.append(na("candidates_found", G, "Real videos found for suggestions", "no stats", "count", "info", d2))
    else:
        k = _num(stats.get("suggestions"))
        out.append(metric("candidates_found", G, "Real videos found for suggestions", c,
                          f"{c} for {int(k)} topics" if k is not None else str(c), "count", "info", d2))
    if not isinstance(sugg, list):
        out.append(na("candidate_validity", G, "Candidates passing sanity checks", "no suggestions", "ratio", "higher", d3))
    else:
        cands = [c for s in sugg if isinstance(s, dict) for c in (s.get("candidates") or []) if isinstance(c, dict)]
        pl = set(playlist)
        ok = 0
        for c in cands:
            dur = _num(c.get("duration_sec"))
            cid = c.get("id")
            if isinstance(cid, str) and ID_RE.match(cid) and cid not in pl and dur is not None and MIN_CAND_SEC <= dur <= MAX_CAND_SEC:
                ok += 1
        out.append(_ratio(ok, len(cands), "candidate_validity", G, "Candidates passing sanity checks", d3, empty_reason="no candidates"))
    return out


def burn_metrics(usage: dict | None, is_standin: bool) -> list:
    G = "Burn"
    spec = [  # key, label, unit, detail
        ("total_tokens", "Tokens used", "tokens", "Prompt + completion tokens as reported by the provider API (totals.total_tokens)."),
        ("prompt_tokens", "Prompt tokens", "tokens", "Tokens sent to the model, summed over all calls (totals.prompt_tokens)."),
        ("completion_tokens", "Completion tokens", "tokens", "Tokens the model produced, reasoning included, summed over all calls (totals.completion_tokens)."),
        ("reasoning_tokens", "Reasoning tokens", "tokens", "Hidden reasoning tokens, a part of the completion tokens (totals.reasoning_tokens)."),
        ("api_calls", "API calls", "count", "Number of requests sent to the provider (totals.calls)."),
        ("wall_seconds", "Wall-clock time", "seconds", "Total run time including rate-limit waiting (totals.wall_seconds)."),
        ("api_seconds", "Time inside the API", "seconds", "Seconds spent inside provider API requests, summed over calls (totals.api_seconds)."),
        ("waiting_seconds", "Time waiting for rate limits", "seconds", "Seconds spent sleeping for rate limits rather than in the API (totals.waiting_seconds)."),
        ("tokens_per_second", "Output speed", "tokens", "Completion tokens divided by seconds inside the API."),
    ]
    totals = dict((usage or {}).get("totals") or {})
    calls = [c for c in ((usage or {}).get("calls") or []) if isinstance(c, dict)]
    src = {"total_tokens": "total_tokens", "prompt_tokens": "prompt_tokens", "completion_tokens": "completion_tokens",
           "reasoning_tokens": "reasoning_tokens", "api_calls": "calls", "wall_seconds": "wall_seconds",
           "api_seconds": "api_seconds", "waiting_seconds": "waiting_seconds"}
    vals = {}
    for key, field in src.items():
        v = _num(totals.get(field))
        if v is None and calls and field in ("total_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens", "api_seconds"):
            parts = [_num(c.get(field)) for c in calls]
            if all(p is not None for p in parts):
                v = round(sum(parts), 2)
        if v is None and field == "calls" and calls:
            v = len(calls)
        vals[key] = v
    ca, asec = vals["completion_tokens"], vals["api_seconds"]
    vals["tokens_per_second"] = round(ca / asec, 1) if ca is not None and asec else None

    out = []
    for key, label, unit, detail in spec:
        direction = "info" if key in ("tokens_per_second", "api_calls", "prompt_tokens") else "lower"
        if is_standin and key == "wall_seconds":
            detail = "Total run time (totals.wall_seconds); agents 2 and 3 ran in parallel."
        if is_standin and key not in ("wall_seconds", "api_calls"):
            reason = "stand-in" if key == "total_tokens" else "stand-in tokens are not comparable"
            out.append(na(key, G, label, reason, unit, "info" if key == "total_tokens" else direction, detail))
            continue
        v = vals[key]
        if usage is None:
            out.append(na(key, G, label, "no usage.json", unit, direction, detail))
        elif v is None:
            out.append(na(key, G, label, "not reported", unit, direction, detail))
        elif unit == "seconds":
            out.append(metric(key, G, label, v, _fmt_seconds(v), unit, direction, detail))
        elif key == "tokens_per_second":
            out.append(metric(key, G, label, v, f"{v:,.1f} tokens/s", unit, direction, detail))
        else:
            out.append(metric(key, G, label, v, f"{int(v):,}" if float(v).is_integer() else f"{v:,}", unit, direction, detail))
    return out


# ------------------------------------------------------------------------------------------------ run + comparisons
def evaluate_run(label: str, run_dir: Path, inputs: dict | None, gold: dict) -> dict | None:
    """One `runs` entry, or None when the folder has no result.json."""
    run_dir = Path(run_dir)
    result = load_json(run_dir / "result.json")
    if not isinstance(result, dict):
        return None
    usage, meta = load_json(run_dir / "usage.json"), load_json(run_dir / "run_meta.json")
    usage = usage if isinstance(usage, dict) else None
    meta = meta if isinstance(meta, dict) else {}
    agents = [load_json(run_dir / f"agent{i}.json") for i in (1, 2, 3)]
    agents = [a if isinstance(a, dict) else None for a in agents]
    stats = derive_stats(result, inputs, *agents)
    playlist = [v["id"] for v in (inputs or {}).get("videos", [])] or list((gold.get("videos") or {}).keys())
    is_standin = label == STANDIN_LABEL
    metrics = (grounding_metrics(result, stats, playlist) + arrangement_metrics(result, stats, gold)
               + coverage_metrics(result, stats, gold, playlist) + suggestion_metrics(result, stats, playlist)
               + burn_metrics(usage, is_standin))
    return {"label": label, "provider": (usage or {}).get("provider") or meta.get("provider") or "unknown",
            "model": (usage or {}).get("model") or meta.get("model") or "unknown",
            "kind": "stand-in" if is_standin else "live", "metrics": metrics,
            "_order": _ids(result.get("order")), "_aside": sorted(set(_ids(result.get("unplaced"))) | set(_ids(result.get("off_goal"))))}


def kendall_tau_a(order_a: list, order_b: list):
    """Kendall tau-a over the ids present in both lists: (concordant - discordant) / (n(n-1)/2); None if n < 2."""
    pb = {v: i for i, v in enumerate(order_b)}
    common = [v for v in order_a if v in pb]
    n = len(common)
    if n < 2:
        return None
    s = 0
    for i, j in itertools.combinations(range(n), 2):
        s += 1 if pb[common[i]] < pb[common[j]] else -1
    return s / (n * (n - 1) / 2)


def compare_pair(a: dict, b: dict, stability: bool) -> list:
    g, prefix = ("Stability", "stability_") if stability else ("Agreement", "")
    who = "two runs of the same model" if stability else "two runs"
    tau = kendall_tau_a(a["_order"], b["_order"])
    out = [{"a": a["label"], "b": b["label"], "key": prefix + "order_kendall_tau", "group": g,
            "label": "Order stability (Kendall tau)" if stability else "Order agreement (Kendall tau)",
            "value": None if tau is None else round(tau, 4),
            "display": "n/a (fewer than 2 shared videos)" if tau is None else f"{tau:.2f}",
            "detail": f"Kendall tau-a between the orders of {who} over the videos both placed: 1 means identical order, -1 reversed."}]
    same = a["_aside"] == b["_aside"]
    out.append({"a": a["label"], "b": b["label"], "key": prefix + "off_goal_agreement", "group": g,
                "label": "Same videos set aside" , "value": 1 if same else 0, "display": "yes" if same else "no",
                "detail": f"1 if {who} set aside exactly the same videos (unplaced or off-goal), else 0."})
    return out


def compare_runs(runs: list) -> list:
    usable = sorted((r for r in runs if r["_order"]), key=lambda r: r["label"])
    out = []
    for a, b in itertools.combinations(usable, 2):
        out += compare_pair(a, b, stability=False)
        if a["provider"] == b["provider"] and a["provider"] != "unknown" and a["label"].rsplit("-", 1)[0] == b["label"].rsplit("-", 1)[0]:
            out += compare_pair(a, b, stability=True)
    return out


def evaluate_all(runs_dir: Path, inputs_path: Path, gold_path: Path, now: datetime | None = None) -> dict:
    gold = load_json(gold_path) or {}
    inputs = load_json(inputs_path)
    inputs = inputs if isinstance(inputs, dict) else None
    runs = []
    for d in sorted(p for p in Path(runs_dir).iterdir() if p.is_dir()) if Path(runs_dir).is_dir() else []:
        try:
            r = evaluate_run(d.name, d, inputs, gold)
        except Exception as e:  # one broken run must not stop the others
            print(f"warning: could not evaluate {d.name}: {e!r}", file=sys.stderr)
            r = None
        if r:
            runs.append(r)
    comparisons = compare_runs(runs)
    for r in runs:
        r.pop("_order"), r.pop("_aside")
    return {"generated": (now or datetime.now()).replace(microsecond=0).isoformat(), "gold_note": gold.get("_note", ""),
            "runs": runs, "comparisons": comparisons}


def main() -> None:
    ev = evaluate_all(OUT / "runs", OUT / "inputs.json", HERE / "gold.json")
    target = OUT / "evaluation.json"
    target.write_text(json.dumps(ev, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {target}: {len(ev['runs'])} run(s), {len(ev['comparisons'])} comparison row(s)")
    for r in ev["runs"]:
        print(f"\n{r['label']}  ({r['provider']} / {r['model']}, {r['kind']})")
        for m in r["metrics"]:
            print(f"  {m['group']:<11}{m['key']:<28}{m['display']}")
    for c in ev["comparisons"]:
        print(f"{c['a']} vs {c['b']}  {c['key']}: {c['display']}")


if __name__ == "__main__":
    main()
