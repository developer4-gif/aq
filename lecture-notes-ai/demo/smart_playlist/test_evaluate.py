"""Tests for evaluate.py using tiny hand-made fixtures (no real run data, no network)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as ev  # noqa: E402

VIDS = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]  # d = off-goal
A, B, C, D = VIDS

GOLD = {
    "_note": "test note",
    "videos": {v: v for v in VIDS},
    "off_goal": [D],
    "framework_video": A,
    "order_constraints": [{"before": A, "after": B}, {"before": A, "after": C}, {"before": B, "after": C}, {"before": B, "after": D}],
    "expected_gaps": [
        {"name": "queues", "keywords": ["queue", "Kafka"]},
        {"name": "rate", "keywords": ["rate limit"]},
        {"name": "cdn", "keywords": ["cdn"]},
        {"name": "cases", "keywords": ["case stud"]},
    ],
    "expected_covered": [
        {"name": "lb", "keywords": ["load balanc"], "video": B},
        {"name": "cache", "keywords": ["cach"], "video": C},
        {"name": "shard", "keywords": ["shard"], "video": A},
    ],
}
EXCERPT = "the quick brown fox jumps over the lazy dog"
INPUTS = {"goal": "g", "videos": [{"id": v, "position": i, "title": v, "channel": "c", "duration_sec": 300, "words": 9,
                                   "excerpt": EXCERPT} for i, v in enumerate(VIDS)]}


def write(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8-sig")  # BOM on purpose: real files have one


def full_result(**over):
    r = {
        "goal": "g",
        "profiles": {A: {"topics": [{"name": "t", "evidence": "x y"}]}, B: {"topics": []}, C: {"topics": [{"name": "t", "evidence": "q w"}]}},
        "order": [{"video_id": A}, {"video_id": C}, {"video_id": B}],
        "unplaced": [{"video_id": D}],
        "off_goal": [],
        "areas": [
            {"area": "Message Queues", "status": "missing", "covered_by": []},          # gap 1 found
            {"area": "Rate limiting", "status": "partial", "covered_by": [A]},          # gap 2 found (partial counts)
            {"area": "CDN and caching", "status": "covered", "covered_by": [C, "zzzzzzzzzzz"]},  # cdn falsely covered; cache covered by C
            {"area": "Load balancing", "status": "covered", "covered_by": [B]},
            {"area": "Sharding", "status": "partial", "covered_by": [C]},               # wrong video for shard
        ],
        "suggestions": [
            {"topic": "s1", "candidates": [
                {"id": "eeeeeeeeeee", "duration_sec": 300},          # valid
                {"id": "fffffffffff", "duration_sec": 119},          # too short
                {"id": "ggggggggggg", "duration_sec": 1500},         # boundary, valid
                {"id": "hhhhhhhhhhh", "duration_sec": 1501},         # too long
                {"id": A, "duration_sec": 300},                      # already in playlist
                {"id": "short", "duration_sec": 300},                # bad id
                {"id": "ii!iiiiiiii", "duration_sec": 300},          # bad char
                {"id": "jjjjjjjjjjj", "duration_sec": 120},          # boundary, valid
            ]},
            {"topic": "s2", "candidates": []},
            {"topic": "s3", "candidates": [{"id": "kkkkkkkkkkk", "duration_sec": "n/a"}]},  # non-numeric duration
        ],
        "stats": {"topics_claimed": 4, "topics_grounded": 3, "videos_readded_to_order": 1, "areas_downgraded_to_missing": 2,
                  "suggestions": 3, "candidates_found": 9},
    }
    r.update(over)
    return r


def by_key(metrics):
    return {m["key"]: m for m in metrics}


def make_run(tmp_path, label, result, usage=None, meta=None, agents=None):
    d = tmp_path / "runs" / label
    d.mkdir(parents=True, exist_ok=True)
    if result is not None:
        write(d / "result.json", result)
    if usage is not None:
        write(d / "usage.json", usage)
    if meta is not None:
        write(d / "run_meta.json", meta)
    for i, a in (agents or {}).items():
        write(d / f"agent{i}.json", a)
    return d


LIVE_USAGE = {"provider": "groq", "model": "m1", "calls": [],
              "totals": {"calls": 6, "prompt_tokens": 1000, "completion_tokens": 600, "reasoning_tokens": 100,
                         "total_tokens": 1600, "api_seconds": 12.0, "wall_seconds": 100.5, "waiting_seconds": 88.5}}


# ------------------------------------------------------------------------------------------------ helpers
def test_load_json_missing_and_bad(tmp_path):
    assert ev.load_json(tmp_path / "nope.json") is None
    (tmp_path / "bad.json").write_text("{oops", encoding="utf-8")
    assert ev.load_json(tmp_path / "bad.json") is None


def test_kendall():
    assert ev.kendall_tau_a(["a", "b", "c"], ["a", "b", "c"]) == 1
    assert ev.kendall_tau_a(["a", "b", "c"], ["c", "b", "a"]) == -1
    assert ev.kendall_tau_a(["a", "b", "c"], ["a", "c", "b"]) == pytest.approx(1 / 3, abs=1e-3)  # 2 concordant, 1 discordant
    assert ev.kendall_tau_a(["a", "x", "b"], ["b", "y", "a"]) == -1                     # only common ids a,b count
    assert ev.kendall_tau_a(["a"], ["a"]) is None
    assert ev.kendall_tau_a([], ["a", "b"]) is None
    assert ev.kendall_tau_a(["a", "b"], ["c", "d"]) is None


# ------------------------------------------------------------------------------------------------ grounding
def test_grounding_and_profiled():
    r = full_result()
    m = by_key(ev.grounding_metrics(r, r["stats"], VIDS))
    assert m["grounding_rate"]["value"] == 0.75 and m["grounding_rate"]["display"] == "3 / 4 (75%)"
    assert m["videos_profiled"]["value"] == 2 and m["videos_profiled"]["display"] == "2 / 4"


def test_grounding_edge_cases():
    m = by_key(ev.grounding_metrics({"profiles": {"unknownid": {"topics": [1]}}}, {"topics_claimed": 0, "topics_grounded": 0}, VIDS))
    assert m["grounding_rate"]["value"] is None and m["grounding_rate"]["display"].startswith("n/a")
    assert m["videos_profiled"]["value"] == 0  # profile of a non-playlist id is ignored
    m = by_key(ev.grounding_metrics({}, {}, VIDS))
    assert m["grounding_rate"]["value"] is None and m["videos_profiled"]["value"] is None
    assert m["videos_profiled"]["display"].startswith("n/a")


# ------------------------------------------------------------------------------------------------ arrangement
def test_framework_first_and_dependency_rules():
    r = full_result()  # order A, C, B; constraints: A<B, A<C (framework rules), B<C, B<D (dependency rules)
    m = by_key(ev.arrangement_metrics(r, r["stats"], GOLD))
    assert m["framework_first"]["value"] == 1 and m["framework_first"]["display"] == "yes"
    assert m["order_rules_dependency"]["value"] == 0.0 and m["order_rules_dependency"]["display"] == "0 / 2 (0%)"
    assert "2 of the 4 rules are the single 'framework first' opinion" in m["order_constraints_met"]["detail"]
    assert "database-dependency rules only" in m["order_rules_dependency"]["detail"]
    r = full_result(order=[{"video_id": B}, {"video_id": A}, {"video_id": C}])  # framework not first; B<C met, B<D not
    m = by_key(ev.arrangement_metrics(r, r["stats"], GOLD))
    assert m["framework_first"]["value"] == 0 and m["framework_first"]["display"] == "no"
    assert m["order_rules_dependency"]["value"] == 0.5
    assert m["order_constraints_met"]["value"] == pytest.approx(2 / 4, abs=1e-3)  # A<C, B<C... A<B fails
    # empty order: framework not first, dependency rules all fail
    m = by_key(ev.arrangement_metrics(full_result(order=[]), {}, GOLD))
    assert m["framework_first"]["value"] == 0 and m["order_rules_dependency"]["value"] == 0.0
    # missing order / no framework in gold / no dependency rules
    m = by_key(ev.arrangement_metrics({}, {}, GOLD))
    assert m["framework_first"]["value"] is None and m["order_rules_dependency"]["value"] is None
    g = {k: v for k, v in GOLD.items() if k != "framework_video"}
    m = by_key(ev.arrangement_metrics(full_result(), {}, g))
    assert m["framework_first"]["value"] is None and m["framework_first"]["display"].startswith("n/a")
    assert m["order_rules_dependency"]["value"] == 0.5  # without a framework id all 4 rules count as dependency rules: A<B, A<C met; B<C, B<D not
    g = dict(GOLD, order_constraints=[{"before": A, "after": B}])
    m = by_key(ev.arrangement_metrics(full_result(), {}, g))
    assert m["order_rules_dependency"]["value"] is None and m["order_rules_dependency"]["display"].startswith("n/a")


def test_off_goal_false_flags():
    r = full_result()  # only D set aside
    assert by_key(ev.arrangement_metrics(r, r["stats"], GOLD))["off_goal_false_flags"]["value"] == 0
    r = full_result(unplaced=[{"video_id": D}, {"video_id": B}], off_goal=[{"video_id": B}, {"video_id": C}])
    m = by_key(ev.arrangement_metrics(r, r["stats"], GOLD))
    assert m["off_goal_false_flags"]["value"] == 2 and m["off_goal_false_flags"]["direction"] == "lower"  # B (deduped) and C
    assert m["off_goal_detected"]["value"] == 1                                                            # unchanged
    r = full_result(unplaced=[], off_goal=[])
    assert by_key(ev.arrangement_metrics(r, r["stats"], GOLD))["off_goal_false_flags"]["value"] == 0
    assert by_key(ev.arrangement_metrics({}, {}, GOLD))["off_goal_false_flags"]["value"] is None


def test_order_constraints_and_off_goal():
    r = full_result()
    m = by_key(ev.arrangement_metrics(r, r["stats"], GOLD))
    # A<B yes, A<C yes, B<C no (C before B), B<D no (D not in order)
    assert m["order_constraints_met"]["value"] == 0.5 and m["order_constraints_met"]["display"] == "2 / 4 (50%)"
    assert m["off_goal_detected"]["value"] == 1 and m["off_goal_detected"]["display"] == "yes"
    assert m["order_integrity"]["value"] == 1 and m["order_integrity"]["direction"] == "lower"


def test_off_goal_via_off_goal_list_and_failures():
    r = full_result(unplaced=[], off_goal=[{"video_id": D}])
    assert by_key(ev.arrangement_metrics(r, r["stats"], GOLD))["off_goal_detected"]["value"] == 1
    # off-goal video wrongly in the order, even though also unplaced
    r = full_result(order=[{"video_id": A}, {"video_id": D}])
    m = by_key(ev.arrangement_metrics(r, r["stats"], GOLD))
    assert m["off_goal_detected"]["value"] == 0 and m["off_goal_detected"]["display"] == "no"
    # not listed anywhere
    r = full_result(unplaced=[], off_goal=[])
    assert by_key(ev.arrangement_metrics(r, r["stats"], GOLD))["off_goal_detected"]["value"] == 0


def test_empty_order_and_missing_stats():
    r = full_result(order=[])
    m = by_key(ev.arrangement_metrics(r, {}, GOLD))
    assert m["order_constraints_met"]["value"] == 0.0  # no video placed: every rule fails
    assert m["order_integrity"]["value"] is None and m["order_integrity"]["display"].startswith("n/a")
    m = by_key(ev.arrangement_metrics({}, {}, GOLD))
    assert m["order_constraints_met"]["value"] is None and m["off_goal_detected"]["value"] is None


def test_order_constraint_with_unknown_id_not_met():
    gold = dict(GOLD, order_constraints=[{"before": A, "after": "notinplaylist"}, {"before": A, "after": C}])
    r = full_result()
    assert by_key(ev.arrangement_metrics(r, r["stats"], gold))["order_constraints_met"]["value"] == 0.5


# ------------------------------------------------------------------------------------------------ coverage
def test_coverage_metrics():
    r = full_result()
    m = by_key(ev.coverage_metrics(r, r["stats"], GOLD, VIDS))
    # queues (missing) + rate (partial) found; cdn only covered -> not found; case studies absent
    assert m["gap_recall"]["value"] == 0.5 and m["gap_recall"]["display"] == "2 / 4 (50%)"
    assert m["false_covered"]["value"] == 1
    # lb: covered by B ok; cache: area covered_by C ok; shard: partial but cites C not A -> not found
    assert m["covered_recall"]["value"] == pytest.approx(2 / 3, abs=1e-3)
    # citations: [A], [C, zzz], [B], [C] = 5 ids, one invalid
    assert m["citation_validity"]["value"] == 0.8 and m["citation_validity"]["display"] == "4 / 5 (80%)"
    assert m["areas_downgraded"]["value"] == 2 and m["areas_downgraded"]["direction"] == "lower"


def test_false_covered_needs_no_missing_or_partial_match():
    areas = [{"area": "CDN basics", "status": "covered", "covered_by": [A]},
             {"area": "CDN deep dive", "status": "missing", "covered_by": []},   # a missing area also matches -> not "false covered"
             {"area": "Rate limit", "status": "COVERED", "covered_by": [B]}]      # status is case-insensitive
    m = by_key(ev.coverage_metrics({"areas": areas}, {}, GOLD, VIDS))
    assert m["false_covered"]["value"] == 1  # only rate limiting
    assert m["gap_recall"]["value"] == 0.25  # only cdn found


def test_gap_recall_suggested():
    # full_result: strict recall 2/4; its suggestions have no keywords -> still 2/4
    r = full_result()
    m = by_key(ev.coverage_metrics(r, r["stats"], GOLD, VIDS))
    assert m["gap_recall_suggested"]["value"] == 0.5 and m["gap_recall"]["value"] == 0.5
    assert m["gap_recall_suggested"]["label"] == "Expected gaps surfaced (areas or suggestions)"
    # cdn only "covered" as an area, but surfaced by a suggestion topic; case studies via search_query (case-insensitive)
    r = full_result(suggestions=[{"topic": "Using a CDN", "search_query": "x", "candidates": []},
                                 {"topic": "other", "search_query": "System design CASE STUDIES", "candidates": []},
                                 "junk"])
    m = by_key(ev.coverage_metrics(r, r["stats"], GOLD, VIDS))
    assert m["gap_recall"]["value"] == 0.5                      # strict metric unchanged
    assert m["gap_recall_suggested"]["value"] == 1.0 and m["gap_recall_suggested"]["display"] == "4 / 4 (100%)"
    # suggestions only: no area matches at all
    r = {"areas": [], "suggestions": [{"topic": "Kafka basics", "search_query": ""}]}
    m = by_key(ev.coverage_metrics(r, {}, GOLD, VIDS))
    assert m["gap_recall"]["value"] == 0.0 and m["gap_recall_suggested"]["display"] == "1 / 4 (25%)"
    # no suggestions key: falls back to areas
    m = by_key(ev.coverage_metrics({"areas": [{"area": "Rate limiting", "status": "missing"}]}, {}, GOLD, VIDS))
    assert m["gap_recall_suggested"]["value"] == 0.25


def test_extra_gaps_proposed():
    r = full_result()  # missing/partial areas: "Message Queues" (gap kw), "Rate limiting" (gap kw), "Sharding" (partial, no gap kw) -> 1 extra
    m = by_key(ev.coverage_metrics(r, r["stats"], GOLD, VIDS))
    assert m["extra_gaps_proposed"]["value"] == 1 and m["extra_gaps_proposed"]["direction"] == "info"
    assert "not scored as wrong" in m["extra_gaps_proposed"]["detail"]
    areas = [{"area": "Monitoring", "status": "missing", "covered_by": []}, {"area": "Security", "status": "partial", "covered_by": [A]},
             {"area": "Observability", "status": "covered", "covered_by": [A]},          # covered: never counted
             {"area": "KAFKA streams", "status": "missing", "covered_by": []}]           # matches a gap keyword: not extra
    m = by_key(ev.coverage_metrics({"areas": areas}, {}, GOLD, VIDS))
    assert m["extra_gaps_proposed"]["value"] == 2
    assert by_key(ev.coverage_metrics({"areas": []}, {}, GOLD, VIDS))["extra_gaps_proposed"]["value"] == 0
    assert by_key(ev.coverage_metrics({}, {}, GOLD, VIDS))["extra_gaps_proposed"]["value"] is None


def test_gold_keywords_tightened():
    gold = json.loads((Path(__file__).resolve().parent / "gold.json").read_text(encoding="utf-8-sig"))
    assert gold["framework_video"] == "i7twT3x5yv8"
    cov = {c["name"]: c["keywords"] for c in gold["expected_covered"]}
    gaps = {g["name"]: g["keywords"] for g in gold["expected_gaps"]}
    assert cov["CAP theorem"] == ["cap theorem", "cap trade"]
    assert gaps["Worked case studies"] == ["case stud", "url shortener", "design problem", "walkthrough"]


def test_coverage_edges():
    m = by_key(ev.coverage_metrics({"areas": []}, {}, GOLD, VIDS))
    assert m["gap_recall"]["value"] == 0.0 and m["false_covered"]["value"] == 0 and m["covered_recall"]["value"] == 0.0
    assert m["citation_validity"]["value"] is None and m["citation_validity"]["display"].startswith("n/a")
    assert m["areas_downgraded"]["value"] is None
    m = by_key(ev.coverage_metrics({}, {}, GOLD, VIDS))
    for k in ("gap_recall", "false_covered", "covered_recall", "citation_validity"):
        assert m[k]["value"] is None and m[k]["display"].startswith("n/a")


# ------------------------------------------------------------------------------------------------ suggestions
def test_suggestion_metrics():
    r = full_result()
    m = by_key(ev.suggestion_metrics(r, r["stats"], VIDS))
    assert m["suggestions_with_candidates"]["value"] == 2 and m["suggestions_with_candidates"]["display"] == "2 / 3"
    assert m["candidates_found"]["value"] == 9 and m["candidates_found"]["display"] == "9 for 3 topics"
    # 9 candidates; valid: eee, ggg(1500), jjj(120) = 3
    assert m["candidate_validity"]["value"] == pytest.approx(3 / 9, abs=1e-3)


def test_suggestion_edges():
    m = by_key(ev.suggestion_metrics({"suggestions": []}, {}, VIDS))
    assert m["suggestions_with_candidates"]["value"] == 0 and m["suggestions_with_candidates"]["display"] == "0 / 0"
    assert m["candidates_found"]["value"] is None
    assert m["candidate_validity"]["value"] is None
    m = by_key(ev.suggestion_metrics({}, {}, VIDS))
    assert all(m[k]["value"] is None for k in m)


# ------------------------------------------------------------------------------------------------ burn
def test_burn_live():
    m = by_key(ev.burn_metrics(LIVE_USAGE, False))
    assert m["total_tokens"]["value"] == 1600 and m["total_tokens"]["display"] == "1,600"
    assert (m["prompt_tokens"]["value"], m["completion_tokens"]["value"], m["reasoning_tokens"]["value"]) == (1000, 600, 100)
    assert m["api_calls"]["value"] == 6
    assert m["wall_seconds"]["display"] == "100.5 s" and m["api_seconds"]["display"] == "12 s"
    assert m["waiting_seconds"]["value"] == 88.5
    assert m["tokens_per_second"]["value"] == 50.0 and m["tokens_per_second"]["direction"] == "info"
    assert all(m[k]["direction"] == "lower" for k in ("total_tokens", "wall_seconds", "waiting_seconds"))


def test_info_directions():
    r = full_result()
    m = by_key(ev.suggestion_metrics(r, r["stats"], VIDS))
    assert m["suggestions_with_candidates"]["direction"] == "info" and m["candidates_found"]["direction"] == "info"
    assert m["candidate_validity"]["direction"] == "higher"
    b = by_key(ev.burn_metrics(LIVE_USAGE, False))
    assert b["api_calls"]["direction"] == "info" and b["prompt_tokens"]["direction"] == "info"
    assert b["total_tokens"]["direction"] == "lower" and b["completion_tokens"]["direction"] == "lower"
    # n/a variants keep the same direction
    assert by_key(ev.suggestion_metrics({}, {}, VIDS))["candidates_found"]["direction"] == "info"
    assert by_key(ev.burn_metrics(None, False))["api_calls"]["direction"] == "info"


def test_burn_missing_usage_and_fields():
    m = by_key(ev.burn_metrics(None, False))
    assert all(x["value"] is None and x["display"].startswith("n/a") for x in m.values())
    assert len(m) == 9
    m = by_key(ev.burn_metrics({"totals": {"wall_seconds": 5}}, False))
    assert m["wall_seconds"]["value"] == 5 and m["total_tokens"]["value"] is None
    assert m["tokens_per_second"]["value"] is None
    # falls back to summing per-call rows when totals lack fields
    usage = {"calls": [{"prompt_tokens": 10, "completion_tokens": 4, "reasoning_tokens": 0, "total_tokens": 14, "api_seconds": 2.0},
                       {"prompt_tokens": 20, "completion_tokens": 6, "reasoning_tokens": 1, "total_tokens": 26, "api_seconds": 2.0}]}
    m = by_key(ev.burn_metrics(usage, False))
    assert m["total_tokens"]["value"] == 40 and m["api_calls"]["value"] == 2 and m["tokens_per_second"]["value"] == 2.5


def test_burn_zero_api_seconds_no_division_error():
    usage = {"totals": {"completion_tokens": 10, "api_seconds": 0}}
    assert by_key(ev.burn_metrics(usage, False))["tokens_per_second"]["value"] is None


def test_burn_standin():
    usage = {"provider": "claude (stand-in)", "totals": {"total_tokens": 140887, "wall_seconds": 60, "calls": 3}}
    m = by_key(ev.burn_metrics(usage, True))
    assert m["total_tokens"]["value"] is None and m["total_tokens"]["display"] == "n/a (stand-in)"
    assert m["wall_seconds"]["value"] == 60 and m["wall_seconds"]["display"] == "60 s"
    assert m["api_calls"]["value"] == 3 and m["api_calls"]["display"] == "3"
    assert "agents 2 and 3 ran in parallel" in m["wall_seconds"]["detail"]
    for k in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "api_seconds", "waiting_seconds", "tokens_per_second"):
        assert m[k]["value"] is None and "stand-in" in m[k]["display"]
    live = by_key(ev.burn_metrics(LIVE_USAGE, False))
    assert "parallel" not in live["wall_seconds"]["detail"]


# ------------------------------------------------------------------------------------------------ stats derivation
def test_derive_stats_prefers_result_stats():
    r = full_result()
    assert ev.derive_stats(r, INPUTS, None, None, None) == r["stats"]


def test_derive_stats_fallback_from_raw_agents():
    r = full_result()
    del r["stats"]
    a1 = {"profiles": [{"video_id": A, "topics": [{"name": "x", "evidence": "quick brown fox"},     # grounded
                                                  {"name": "y", "evidence": "not in the text at all"}]},
                       {"video_id": "nope", "topics": [{"name": "z", "evidence": "quick brown"}]}]}  # unknown video: skipped
    a2 = {"order": [{"video_id": A}, {"video_id": B}], "unplaced": [{"video_id": D}]}               # C is missing
    a3 = {"areas": [{"status": "covered", "covered_by": []}, {"status": "partial", "covered_by": ["bad"]},
                    {"status": "covered", "covered_by": [A]}, {"status": "missing", "covered_by": []}]}
    s = ev.derive_stats(r, INPUTS, a1, a2, a3)
    assert (s["topics_claimed"], s["topics_grounded"]) == (2, 1)
    assert s["videos_readded_to_order"] == 1
    assert s["areas_downgraded_to_missing"] == 2
    assert s["suggestions"] == 3 and s["candidates_found"] == 9


def test_derive_stats_nothing_available():
    assert ev.derive_stats({}, None, None, None, None) == {}


# ------------------------------------------------------------------------------------------------ run entries
def test_evaluate_run_shape_and_provider(tmp_path):
    d = make_run(tmp_path, "groq-1", full_result(), usage=LIVE_USAGE, meta={"provider": "other", "model": "other"})
    run = ev.evaluate_run("groq-1", d, INPUTS, GOLD)
    assert (run["provider"], run["model"], run["kind"]) == ("groq", "m1", "live")  # usage.json wins
    keys = [m["key"] for m in run["metrics"]]
    assert keys == ["grounding_rate", "videos_profiled", "order_constraints_met", "framework_first", "order_rules_dependency", "off_goal_detected",
                    "off_goal_false_flags", "order_integrity",
                    "gap_recall", "gap_recall_suggested", "extra_gaps_proposed", "false_covered", "covered_recall", "citation_validity", "areas_downgraded",
                    "suggestions_with_candidates", "candidates_found", "candidate_validity",
                    "total_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens", "api_calls",
                    "wall_seconds", "api_seconds", "waiting_seconds", "tokens_per_second"]
    groups = {"Grounding", "Arrangement", "Coverage", "Suggestions", "Burn"}
    for m in run["metrics"]:
        assert set(m) == {"key", "group", "label", "value", "display", "unit", "direction", "detail"}
        assert m["group"] in groups and m["direction"] in ("higher", "lower", "info")
        assert m["detail"].strip() and m["display"]
        json.dumps(m)


def test_evaluate_run_meta_fallback_and_standin(tmp_path):
    d = make_run(tmp_path, "gemini-1", full_result(), meta={"provider": "gemini", "model": "g"})
    run = ev.evaluate_run("gemini-1", d, INPUTS, GOLD)
    assert (run["provider"], run["model"]) == ("gemini", "g")
    assert by_key(run["metrics"])["total_tokens"]["display"] == "n/a (no usage.json)"  # missing usage: no crash
    d = make_run(tmp_path, "claude-standin", full_result(), usage={"provider": "claude (stand-in)", "totals": {"total_tokens": 5, "wall_seconds": 9}})
    run = ev.evaluate_run("claude-standin", d, INPUTS, GOLD)
    assert run["kind"] == "stand-in"
    assert by_key(run["metrics"])["total_tokens"]["display"] == "n/a (stand-in)"


def test_evaluate_run_without_result_or_inputs(tmp_path):
    d = make_run(tmp_path, "empty-1", None, usage=LIVE_USAGE)
    assert ev.evaluate_run("empty-1", d, INPUTS, GOLD) is None
    d = make_run(tmp_path, "x-1", {"order": []})  # nothing else: must not crash, falls back to gold videos
    run = ev.evaluate_run("x-1", d, None, GOLD)
    assert run["provider"] == "unknown"
    assert by_key(run["metrics"])["grounding_rate"]["value"] is None


# ------------------------------------------------------------------------------------------------ comparisons
def _run(label, provider, order, aside=()):
    return {"label": label, "provider": provider, "_order": order, "_aside": sorted(aside)}


def test_compare_pair_values():
    a, b = _run("a-1", "p", [A, B, C], [D]), _run("b-1", "q", [C, B, A], [D])
    rows = {r["key"]: r for r in ev.compare_pair(a, b, stability=False)}
    assert rows["order_kendall_tau"]["value"] == -1 and rows["order_kendall_tau"]["display"] == "-1.00"
    assert rows["order_kendall_tau"]["group"] == "Agreement"
    assert rows["off_goal_agreement"]["value"] == 1 and rows["off_goal_agreement"]["display"] == "yes"
    b2 = _run("b-1", "q", [A], [])
    rows = {r["key"]: r for r in ev.compare_pair(a, b2, stability=False)}
    assert rows["order_kendall_tau"]["value"] is None and rows["order_kendall_tau"]["display"].startswith("n/a")
    assert rows["off_goal_agreement"]["value"] == 0
    both_empty = {r["key"]: r for r in ev.compare_pair(_run("a", "p", [A, B]), _run("b", "p", [A, B]), stability=False)}
    assert both_empty["off_goal_agreement"]["value"] == 1


def test_compare_runs_stability_and_sorting():
    runs = [_run("groq-2", "groq", [B, A, C]), _run("gemini-1", "gemini", [A, B, C], [D]), _run("groq-1", "groq", [A, B, C]),
            _run("noorder-1", "groq", [])]
    rows = ev.compare_runs(runs)
    pairs = [(r["a"], r["b"]) for r in rows]
    assert all(a < b for a, b in pairs)                      # sorted by label inside each pair
    assert sorted(set(pairs)) == [("gemini-1", "groq-1"), ("gemini-1", "groq-2"), ("groq-1", "groq-2")]  # run without order skipped
    stab = [r for r in rows if r["group"] == "Stability"]
    assert [(r["a"], r["b"], r["key"]) for r in stab] == [("groq-1", "groq-2", "stability_order_kendall_tau"),
                                                          ("groq-1", "groq-2", "stability_off_goal_agreement")]
    assert stab[0]["value"] == pytest.approx(1 / 3, abs=1e-3)
    assert ev.compare_runs(runs) == rows                     # deterministic
    # same provider but different label prefix: agreement only
    rows = ev.compare_runs([_run("alpha-1", "groq", [A, B]), _run("beta-1", "groq", [A, B])])
    assert {r["group"] for r in rows} == {"Agreement"}


def test_no_stability_for_different_providers():
    rows = ev.compare_runs([_run("groq-1", "groq", [A, B]), _run("gemini-1", "gemini", [A, B])])
    assert all(r["group"] == "Agreement" for r in rows) and len(rows) == 2


# ------------------------------------------------------------------------------------------------ end to end
def test_evaluate_all_end_to_end(tmp_path):
    write(tmp_path / "inputs.json", INPUTS)
    write(tmp_path / "gold.json", GOLD)
    make_run(tmp_path, "groq-1", full_result(), usage=LIVE_USAGE)
    make_run(tmp_path, "groq-2", full_result(order=[{"video_id": C}, {"video_id": A}]), usage=LIVE_USAGE)
    make_run(tmp_path, "claude-standin", full_result(), usage={"provider": "claude (stand-in)", "totals": {"wall_seconds": 3}})
    make_run(tmp_path, "gemini-1", None, usage=LIVE_USAGE)  # incomplete run: skipped
    out = ev.evaluate_all(tmp_path / "runs", tmp_path / "inputs.json", tmp_path / "gold.json")
    assert out["gold_note"] == "test note" and out["generated"]
    assert [r["label"] for r in out["runs"]] == ["claude-standin", "groq-1", "groq-2"]
    assert [r["kind"] for r in out["runs"]] == ["stand-in", "live", "live"]
    assert all("_order" not in r and "_aside" not in r for r in out["runs"])
    keys = {(c["a"], c["b"], c["key"]) for c in out["comparisons"]}
    assert ("groq-1", "groq-2", "stability_order_kendall_tau") in keys
    assert ("claude-standin", "groq-1", "order_kendall_tau") in keys
    json.dumps(out)


def test_evaluate_all_missing_dirs(tmp_path):
    out = ev.evaluate_all(tmp_path / "none", tmp_path / "no_inputs.json", tmp_path / "no_gold.json")
    assert out["runs"] == [] and out["comparisons"] == []
