"""Builds out/dashboard.html: one self-contained evidence page for the smart playlist demo.

Usage (from anywhere):
  python build_dashboard.py [--evaluation out/evaluation.json]

Reads (never writes): out/inputs.json, out/evaluation.json (or evaluation.sample.json as a loud fallback),
out/runs/<label>/{result,usage,run_meta}.json.   Writes: out/dashboard.html (inline CSS/JS, no network).
Missing files or fields never crash the build: the page shows "n/a" instead.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
RUNS = OUT / "runs"
SAMPLE = HERE / "evaluation.sample.json"

AGENTS = {"1": ("Profiler", "reads transcript excerpts"), "2": ("Sequencer", "orders the videos"),
          "3": ("Gap analyst", "finds missing topics")}
GROUP_ORDER = ["Grounding", "Arrangement", "Coverage", "Suggestions", "Burn"]
NA = "n/a"


# ------------------------------------------------------------------------------------------------ helpers
def e(x) -> str:
    return html.escape("" if x is None else str(x), quote=True)


def load(path: Path):
    """JSON file or None (tolerates BOM, missing file, bad JSON)."""
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return None


def num(x):
    """A real number or None (bool, NaN and strings are not numbers)."""
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, (int, float)) and x == x and x not in (float("inf"), float("-inf")):
        return x
    return None


def n_fmt(x, dec: int = 0) -> str:
    x = num(x)
    if x is None:
        return NA
    return f"{x:,.{dec}f}" if dec else f"{round(x):,}"


def s_fmt(x) -> str:
    x = num(x)
    return NA if x is None else f"{x:,.1f}"


def dur(sec) -> str:
    sec = num(sec)
    if sec is None:
        return NA
    sec = int(sec)
    return f"{sec // 60}:{sec % 60:02d}"


def txt(x, default: str = NA) -> str:
    return default if x is None or str(x).strip() == "" else str(x)


def as_dict(x) -> dict:
    return x if isinstance(x, dict) else {}


def as_list(x) -> list:
    return x if isinstance(x, list) else []


def slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in str(s)).strip("-").lower() or "run"


# ------------------------------------------------------------------------------------------------ data
class Run:
    def __init__(self, label: str, ev: dict | None):
        d = RUNS / label
        self.label = label
        self.ev = as_dict(ev)
        self.metrics = [m for m in as_list(self.ev.get("metrics")) if isinstance(m, dict)]
        self.result = load(d / "result.json")
        self.usage = load(d / "usage.json")
        self.meta = as_dict(load(d / "run_meta.json"))
        self.result = self.result if isinstance(self.result, dict) else None
        self.usage = self.usage if isinstance(self.usage, dict) else None
        prov = self.ev.get("provider") or as_dict(self.usage).get("provider") or self.meta.get("provider")
        model = self.ev.get("model") or as_dict(self.usage).get("model") or self.meta.get("model")
        self.provider, self.model = txt(prov, ""), txt(model, "")
        kind = self.ev.get("kind")
        if kind not in ("live", "stand-in"):
            kind = "stand-in" if "stand" in (label + self.provider).lower() else "live"
        self.kind = kind

    @property
    def standin(self) -> bool:
        return self.kind == "stand-in"

    @property
    def desc(self) -> str:
        return " / ".join(p for p in (self.provider, self.model) if p) or NA


def collect_runs(evaluation: dict) -> list[Run]:
    runs, seen = [], set()
    for r in as_list(evaluation.get("runs")):
        if isinstance(r, dict) and r.get("label") and r["label"] not in seen:
            seen.add(r["label"])
            runs.append(Run(str(r["label"]), r))
    if RUNS.is_dir():
        for d in sorted(RUNS.iterdir()):
            if d.is_dir() and d.name not in seen and ((d / "result.json").exists() or (d / "usage.json").exists()):
                seen.add(d.name)
                runs.append(Run(d.name, None))
    return runs


# ------------------------------------------------------------------------------------------------ small html bits
def kind_tag(run: Run) -> str:
    return "<span class='tag standin'>stand-in</span>" if run.standin else ""


def run_title(run: Run) -> str:
    return f"<strong>{e(run.label)}</strong> {kind_tag(run)}"


def status_tag(status: str) -> str:
    glyph = {"covered": "●", "partial": "◐", "missing": "○"}.get(status, "?")
    label = status if status in ("covered", "partial", "missing") else NA
    return f"<span class='status {e(label)}'><span aria-hidden='true'>{glyph}</span> {e(label.capitalize())}</span>"


class Titles:
    def __init__(self, inputs: dict):
        self.by_id = {v.get("id"): v for v in as_list(inputs.get("videos")) if isinstance(v, dict)}

    def title(self, vid) -> str:
        v = self.by_id.get(vid)
        return str(v.get("title")) if v and v.get("title") else f"{vid} (title unknown)"

    def link(self, vid) -> str:
        t = e(self.title(vid))
        if vid in self.by_id:
            return f"<a href='https://www.youtube.com/watch?v={e(vid)}' target='_blank' rel='noopener'>{t}</a>"
        return t


# ------------------------------------------------------------------------------------------------ sections
def sec_header(goal: str, evaluation: dict, sample: bool, warnings: list[str]) -> str:
    gen = txt(evaluation.get("generated"))
    note = txt(evaluation.get("gold_note"), "The reference answers are provisional; no note was supplied.")
    banner = ""
    if sample:
        banner = ("<div class='banner' role='alert'><strong>SAMPLE DATA</strong> The numbers in the scoreboard and "
                  "comparisons come from <code>evaluation.sample.json</code>, not from a real evaluation. "
                  "Do not quote them.</div>")
    warn = "".join(f"<div class='banner soft' role='status'>{e(w)}</div>" for w in warnings)
    return f"""{banner}{warn}<main>
<header>
<p class='eyebrow'>Evidence report</p>
<h1>Smart playlist: evidence report</h1>
<p class='lead'>Goal of the playlist: <strong>{e(goal)}</strong>. Three AI agents arrange the saved videos into a watch order and
find topics the playlist does not yet cover. This page shows what that cost and how good the result is.</p>
<p class='meta'>Evaluation generated: {e(gen)}. Page built: {e(datetime.now().strftime('%Y-%m-%d %H:%M'))}.</p>
<p class='honest'><strong>Honesty note:</strong> {e(note)}</p>
<nav aria-label='On this page'><ul class='toc'>
<li><a href='#how'>How it works</a></li><li><a href='#score'>Scoreboard</a></li><li><a href='#burn'>Proof of burn</a></li>
<li><a href='#order'>The arrangement</a></li><li><a href='#topics'>Topics to cover</a></li>
<li><a href='#agree'>Agreement and stability</a></li><li><a href='#limits'>Limits</a></li></ul></nav>
</header>"""


def sec_how() -> str:
    return """<section id='how' aria-labelledby='h-how'>
<h2 id='h-how'>How it works</h2>
<p class='sub'>The agents only propose. Plain code then checks every claim before anything is shown.</p>
<ol class='flow'>
<li class='step'><span class='n'>1</span><div><h3>Profiler</h3><p>Reads a transcript excerpt of each video and says what it teaches, quoting the transcript as proof.</p></div></li>
<li class='arrow' aria-hidden='true'>then, in parallel</li>
<li class='par'>
<div class='step'><span class='n'>2a</span><div><h3>Sequencer</h3><p>Puts the videos in a watch order, foundations first, and sets aside any video that does not serve the goal.</p></div></div>
<div class='step'><span class='n'>2b</span><div><h3>Gap analyst</h3><p>Lists the areas the goal needs, marks each covered, partial or missing, and suggests what to search for.</p></div></div>
</li>
<li class='arrow' aria-hidden='true'>then</li>
<li class='step code'><span class='n'>3</span><div><h3>Code verification (no AI)</h3>
<ul><li>Every quoted piece of evidence must exist in the transcript, otherwise the topic is removed.</li>
<li>Every video id must exist in the playlist, and each video appears in the order exactly once.</li>
<li>A &quot;covered&quot; claim must cite a real playlist video, otherwise it becomes &quot;missing&quot;.</li>
<li>Suggested videos must be real YouTube search results, not invented titles.</li></ul></div></li>
<li class='arrow' aria-hidden='true'>then</li>
<li class='step'><span class='n'>4</span><div><h3>Report</h3><p>The verified arrangement, topic coverage and suggested additions, shown below for each run.</p></div></li>
</ol></section>"""


def best_cells(runs: list[Run], key: tuple, direction: str, group: str, values: dict, unit: str = "") -> set:
    """Labels of the runs holding the best value (empty when nothing can fairly be called best).

    Only higher/lower rows; stand-in runs never take part; needs two live numbers that are not all equal;
    for token/second/count rows the best must beat the runner-up by at least 1% of the larger value."""
    if direction not in ("higher", "lower"):
        return set()
    standin = {r.label for r in runs if r.standin}
    cand = {l: v for l, v in values.items() if v is not None and l not in standin}
    distinct = sorted(set(cand.values()), reverse=(direction == "higher"))
    if len(cand) < 2 or len(distinct) < 2:
        return set()
    best, runner = distinct[0], distinct[1]
    if unit in ("tokens", "seconds", "count") and abs(best - runner) < 0.01 * max(abs(best), abs(runner)):
        return set()
    return {l for l, v in cand.items() if v == best}


def sec_score(runs: list[Run]) -> str:
    out = ["<section id='score' aria-labelledby='h-score'><h2 id='h-score'>Scoreboard</h2>",
           "<p class='sub'>One column per run. <span class='best'>Best</span> marks the leading value in a row only when at least two live runs "
           "have a number, the values differ meaningfully and the metric has a direction (stand-in runs are never marked). "
           "Open &quot;How computed&quot; under a metric for its exact definition.</p>",
           "<p class='note'><strong>Scores compare each run with provisional reference answers written by the assistant. Treat rows as indicative; "
           "read the arrangement and topic sections to judge quality.</strong></p>"]
    groups: dict[str, dict[str, dict]] = {}
    for r in runs:
        for m in r.metrics:
            g, k = txt(m.get("group"), "Other"), txt(m.get("key") or m.get("label"), "metric")
            groups.setdefault(g, {}).setdefault(k, {"label": m.get("label"), "direction": m.get("direction"),
                                                    "detail": m.get("detail"), "cells": {}})["cells"][r.label] = m
    if not groups:
        out.append("<p class='empty'>No metrics available: the evaluation file has no runs yet.</p></section>")
        return "".join(out)
    order = [g for g in GROUP_ORDER if g in groups] + [g for g in groups if g not in GROUP_ORDER]
    out.append("<div class='tablewrap' tabindex='0' role='region' aria-label='Scoreboard table, scrolls sideways on small screens'><table class='score'><thead><tr>"
               "<th scope='col'>Metric</th><th scope='col'>Better</th>")
    for r in runs:
        out.append(f"<th scope='col'>{run_title(r)}<span class='sub2'>{e(r.desc)}</span></th>")
    out.append("</tr></thead>")
    for g in order:
        out.append(f"<tbody><tr class='grp'><th scope='rowgroup' colspan='{2 + len(runs)}'>{e(g)}</th></tr>")
        for k, row in groups[g].items():
            d = row["direction"] if row["direction"] in ("higher", "lower", "info") else "info"
            arrow = {"higher": ("↑", "higher is better"), "lower": ("↓", "lower is better"),
                     "info": ("•", "for information")}[d]
            values = {r.label: num(as_dict(row["cells"].get(r.label)).get("value")) for r in runs}
            best = best_cells(runs, (g, k), d, g, values, txt(next((m.get('unit') for m in row['cells'].values() if isinstance(m, dict)), ''), ''))
            detail = f"<details><summary>How computed</summary><span>{e(txt(row['detail']))}</span></details>"
            out.append(f"<tr><th scope='row'>{e(txt(row['label'], k))}{detail}</th>"
                       f"<td class='dir'><span aria-hidden='true'>{arrow[0]}</span> {arrow[1]}</td>")
            for r in runs:
                m = row["cells"].get(r.label)
                if m is None:
                    out.append(f"<td class='na'>{NA}</td>")
                    continue
                disp = txt(m.get("display"), NA if num(m.get("value")) is None else str(m.get("value")))
                is_best = r.label in best
                tip = f" title='{e(txt(m.get('detail'), ''))}'" if m.get("detail") else ""
                out.append(f"<td class='{'isbest' if is_best else ''}'{tip}><span class='val'>{e(disp)}</span>"
                           f"{' <span class=\"best\">Best</span>' if is_best else ''}</td>")
            out.append("</tr>")
        out.append("</tbody>")
    out.append("</table></div></section>")
    return "".join(out)


# ---- burn
def token_split(a: dict):
    """(prompt, completion-without-reasoning, reasoning) or None when it cannot be split."""
    p, c, r, t = (num(a.get(k)) for k in ("prompt_tokens", "completion_tokens", "reasoning_tokens", "total_tokens"))
    if p is None or c is None:
        return None
    r = r or 0
    if t is not None and r and abs(p + c + r - t) <= 1 and abs(p + c - t) > 1:
        return p, c, r                      # provider reports reasoning on top of completion
    return p, max(c - r, 0), min(r, c)      # reasoning is already counted inside completion


def usage_rows(run: Run) -> list[tuple]:
    """[(agent_key, name, dict)] followed by ('total', 'All agents', dict)."""
    u = as_dict(run.usage)
    per = as_dict(u.get("per_agent"))
    rows = [(k, AGENTS.get(k, (f"Agent {k}", ""))[0], as_dict(per.get(k))) for k in sorted(per)]
    return rows


def wait_of(d: dict):
    w = num(d.get("waiting_seconds"))
    if w is None and num(d.get("wall_seconds")) is not None and num(d.get("api_seconds")) is not None:
        w = max(d["wall_seconds"] - d["api_seconds"], 0)
    return w


def burn_finding(runs: list[Run]) -> str:
    facts = []
    for r in runs:
        if r.standin or not r.usage:
            continue
        t = as_dict(r.usage.get("totals"))
        wall, w = num(t.get("wall_seconds")), wait_of(t)
        if wall and w is not None:
            facts.append((r, wall, w, w / wall, num(t.get("total_tokens"))))
    if not facts:
        return "No live run has wall-clock and API timing yet, so no time finding can be stated."
    facts.sort(key=lambda f: -f[3])
    r, wall, w, share, _ = facts[0]
    s = (f"Biggest finding: <strong>{e(r.label)}</strong> spent <strong>{share:.0%}</strong> of its wall time waiting (not in the API): "
         f"{e(s_fmt(w))} of {e(s_fmt(wall))} seconds, i.e. built-in rate-limit pacing and retries.")
    if len(facts) > 1:
        o = facts[-1]
        s += f" By comparison, {e(o[0].label)} spent {o[3]:.0%} of its wall time waiting ({e(s_fmt(o[2]))} of {e(s_fmt(o[1]))} s)."
    toks = [(f[0], f[4]) for f in facts if f[4] is not None]
    if len(toks) > 1:
        lo, hi = min(toks, key=lambda x: x[1]), max(toks, key=lambda x: x[1])
        if lo[0] is not hi[0]:
            s += f" Token use ranged from {e(n_fmt(lo[1]))} ({e(lo[0].label)}) to {e(n_fmt(hi[1]))} ({e(hi[0].label)})."
    return s


def sec_burn(runs: list[Run]) -> str:
    out = ["<section id='burn' aria-labelledby='h-burn'><h2 id='h-burn'>Proof of burn</h2>",
           "<p class='sub'>What each run cost, taken from the usage log the run wrote. Token counts are those the provider API reported.</p>",
           f"<p class='finding'>{burn_finding(runs)}</p>",
           "<ul class='legend' aria-label='Legend'><li><span class='sw prompt'></span>Prompt (input)</li>"
           "<li><span class='sw comp'></span>Completion (answer)</li><li><span class='sw reas'></span>Reasoning (hidden thinking)</li>"
           "<li><span class='sw tot'></span>Total only (not split)</li></ul>",
           "<p class='note'>Providers count reasoning tokens inside the completion count; the bars show completion without reasoning so "
           "the segments add up to the total. All live bars share one scale so they can be compared.</p>"]
    live_max = max([num(d.get("total_tokens")) or 0 for r in runs if not r.standin for _, _, d in usage_rows(r)] + [0])
    st_max = max([num(d.get("total_tokens")) or 0 for r in runs if r.standin for _, _, d in usage_rows(r)] + [0])
    any_run = False
    for r in runs:
        rows = usage_rows(r)
        if not r.usage or not rows:
            continue
        any_run = True
        u = r.usage
        out.append(f"<article class='card'><h3>{run_title(r)} <span class='sub2 inl'>{e(r.desc)}</span></h3>")
        if r.standin:
            out.append("<p class='warn'><strong>Not comparable.</strong> " + e(txt(u.get("source"), "Stand-in token totals are not provider API counts."))
                       + " Do not compare these numbers with the Groq or Gemini runs.</p>")
        scale = st_max if r.standin else live_max
        out.append("<div class='bars' role='list'>")
        for k, name, d in rows:
            tot = num(d.get("total_tokens"))
            sp = token_split(d)
            if tot is None or not scale:
                out.append(f"<div class='barrow' role='listitem'><div class='bl'>{e(name)}</div><div class='bt'>{NA}</div></div>")
                continue
            width = lambda v: f"{max(v / scale * 100, 0):.2f}%"  # noqa: E731
            if sp and not r.standin:
                p, c, rs = sp
                segs = (f"<span class='seg prompt' style='width:{width(p)}'></span>"
                        f"<span class='seg comp' style='width:{width(c)}'></span>"
                        f"<span class='seg reas' style='width:{width(rs)}'></span>")
                detail = (f"prompt {n_fmt(p)} + completion {n_fmt(c)} + reasoning {n_fmt(rs)}")
            else:
                segs = f"<span class='seg tot' style='width:{width(tot)}'></span>"
                detail = "total only, not split by type"
            out.append(f"<div class='barrow' role='listitem'><div class='bl'>{e(name)}</div>"
                       f"<div class='track' aria-hidden='true'>{segs}</div>"
                       f"<div class='bt'><strong>{e(n_fmt(tot))}</strong> tokens<span class='bd'>{e(detail)}</span></div></div>")
        out.append("</div>")
        out.append("<div class='tablewrap' tabindex='0' role='region' aria-label='Usage table for " + e(r.label) + "'><table class='burn'><thead><tr>"
                   "<th scope='col'>Agent</th><th scope='col'>Calls</th><th scope='col'>Tokens</th><th scope='col'>API seconds</th>"
                   "<th scope='col'>Wall seconds</th><th scope='col'>Waiting seconds (pacing and retries)</th><th scope='col'>Total tokens / API second</th></tr></thead><tbody>")
        tot_row = as_dict(u.get("totals"))

        def tps(d):
            t, a = num(d.get("total_tokens")), num(d.get("api_seconds"))
            return n_fmt(t / a, 1) if t is not None and a else NA

        for k, name, d in rows:
            out.append(f"<tr><th scope='row'>{e(name)}</th><td>{n_fmt(d.get('calls'))}</td><td>{n_fmt(d.get('total_tokens'))}</td>"
                       f"<td>{s_fmt(d.get('api_seconds'))}</td><td>{s_fmt(d.get('wall_seconds'))}</td><td>{s_fmt(wait_of(d))}</td><td>{tps(d)}</td></tr>")
        out.append(f"<tr class='total'><th scope='row'>Whole run</th><td>{n_fmt(tot_row.get('calls'))}</td><td>{n_fmt(tot_row.get('total_tokens'))}</td>"
                   f"<td>{s_fmt(tot_row.get('api_seconds'))}</td><td>{s_fmt(tot_row.get('wall_seconds'))}</td><td>{s_fmt(wait_of(tot_row))}</td>"
                   f"<td>{tps(tot_row)}</td></tr></tbody></table></div>")
        if tot_row.get("note"):
            out.append(f"<p class='note'>Run note: {e(tot_row['note'])}. Whole-run wall time is therefore less than the sum of the agents.</p>")
        if not r.standin:
            out.append("<p class='note'>Waiting = wall-clock time minus time inside the provider API. For Groq's free tier the app deliberately "
                       "pauses between calls to stay under its tokens-per-minute limit.</p>")
        out.append("</article>")
    if not any_run:
        out.append("<p class='empty'>No usage data found for any run yet.</p>")
    out.append("</section>")
    return "".join(out)


# ---- tabs
def tabset(sid: str, runs: list[Run], bodies: list[str]) -> str:
    if not runs:
        return "<p class='empty'>No runs available.</p>"
    tabs = "".join(f"<button type='button' role='tab' id='{sid}-t{i}' aria-controls='{sid}-p{i}' aria-selected='{'true' if i == 0 else 'false'}'"
                   f" tabindex='{0 if i == 0 else -1}'>{e(r.label)}{' (stand-in)' if r.standin else ''}</button>" for i, r in enumerate(runs))
    panels = "".join(f"<div role='tabpanel' class='panel' id='{sid}-p{i}' aria-labelledby='{sid}-t{i}'>"
                     f"<h3 class='runh'>{run_title(r)} <span class='sub2 inl'>{e(r.desc)}</span></h3>{b}</div>"
                     for i, (r, b) in enumerate(zip(runs, bodies)))
    return f"<div class='tabset'><div class='tablist' role='tablist' aria-label='Choose a run' hidden>{tabs}</div>{panels}</div>"


def no_result(r: Run) -> str:
    return (f"<p class='empty'>No verified result for this run yet (<code>out/runs/{e(r.label)}/result.json</code> is missing or unreadable).</p>")


def arrangement_body(r: Run, inputs: dict, T: Titles) -> str:
    res = r.result
    if not res:
        return no_result(r)
    vids = [v for v in as_list(inputs.get("videos")) if isinstance(v, dict)]
    order = [x for x in as_list(res.get("order")) if isinstance(x, dict)]
    unplaced = [x for x in as_list(res.get("unplaced")) if isinstance(x, dict)]
    pos = {x.get("video_id"): i + 1 for i, x in enumerate(order)}
    aside = {x.get("video_id") for x in unplaced}
    profiles = as_dict(res.get("profiles"))
    left = []
    for v in vids:
        vid = v.get("id")
        dest = "set aside" if vid in aside else (f"moves to #{pos[vid]}" if vid in pos else NA)
        left.append(f"<li value='{e(v.get('position', ''))}'><span class='t'>{T.link(vid)}</span>"
                    f"<span class='sub2'>{e(txt(v.get('channel')))} &middot; {e(dur(v.get('duration_sec')))} &middot; <strong>{e(dest)}</strong></span></li>")
    offflag = {x.get("video_id") for x in as_list(res.get("off_goal")) if isinstance(x, dict)}
    right = []
    for i, x in enumerate(order):
        vid = x.get("video_id")
        p = as_dict(profiles.get(vid))
        v = as_dict(T.by_id.get(vid))
        right.append(f"<li><span class='t'>{T.link(vid)}</span><span class='sub2'>{e(txt(p.get('level')))} &middot; {e(dur(v.get('duration_sec')))}</span>"
                     f"<span class='why'>{e(txt(x.get('reason')))}</span>"
                     + ("<span class='disagree'>Flagged off-goal by the gap analyst but placed by the sequencer (the two agents disagree).</span>" if vid in offflag else "")
                     + "</li>")
    side = "".join(f"<li><span class='t'>{T.link(x.get('video_id'))}</span><span class='why'>{e(txt(x.get('reason')))}</span></li>" for x in unplaced) \
        or "<li class='empty'>No video was set aside.</li>"
    st = as_dict(res.get("stats"))
    checks = "".join(f"<li>{e(c)}</li>" for c in as_list(res.get("checks"))) or f"<li>{NA}</li>"
    stat_line = ""
    if st:
        stat_line = (f"<p class='note'>Corrections made by code: {e(n_fmt(st.get('videos_readded_to_order')))} video(s) re-added to the order, "
                     f"{e(n_fmt(st.get('areas_downgraded_to_missing')))} coverage claim(s) downgraded to missing, "
                     f"{e(n_fmt(st.get('topics_claimed')))} topics claimed, {e(n_fmt(st.get('topics_grounded')))} backed by a transcript quote.</p>")
    return (f"<p class='summary'><strong>Path summary:</strong> {e(txt(res.get('path_summary')))}</p>"
            f"<div class='cols'><div><h4>As saved ({len(vids)} videos)</h4><ol class='vlist'>{''.join(left)}</ol></div>"
            f"<div><h4>Suggested order ({len(order)} videos)</h4><ol class='vlist num'>{''.join(right)}</ol>"
            f"<h4>Set aside, not in the learning path</h4><ul class='vlist plain'>{side}</ul></div></div>"
            f"<details class='checks'><summary>What the code verified for this run</summary><ul>{checks}</ul>{stat_line}</details>")


def topics_body(r: Run, T: Titles) -> str:
    res = r.result
    if not res:
        return no_result(r)
    areas = [a for a in as_list(res.get("areas")) if isinstance(a, dict)]
    counts = {s: sum(1 for a in areas if a.get("status") == s) for s in ("covered", "partial", "missing")}
    rows = []
    for a in areas:
        by = "<br>".join(T.link(v) for v in as_list(a.get("covered_by"))) or "<span class='muted'>nothing in the playlist</span>"
        rows.append(f"<tr><th scope='row'>{e(txt(a.get('area')))}<span class='sub2'>{e(txt(a.get('why'), ''))}</span></th>"
                    f"<td>{status_tag(a.get('status'))}</td><td>{e(txt(a.get('priority')))}</td><td>{by}</td></tr>")
    table = ("<div class='tablewrap' tabindex='0' role='region' aria-label='Coverage table'><table class='cov'><thead><tr><th scope='col'>Area needed for the goal</th>"
             "<th scope='col'>Status</th><th scope='col'>Priority</th><th scope='col'>Covered by</th></tr></thead><tbody>"
             + "".join(rows) + "</tbody></table></div>") if rows else "<p class='empty'>No coverage areas in this result.</p>"
    sugg = []
    for s in [x for x in as_list(res.get("suggestions")) if isinstance(x, dict)]:
        cands = []
        for c in [x for x in as_list(s.get("candidates")) if isinstance(x, dict)]:
            url = str(c.get("url") or "")
            if not url.startswith("https://"):
                url = f"https://www.youtube.com/watch?v={c['id']}" if c.get("id") else ""
            title = e(txt(c.get("title")))
            link = f"<a href='{e(url)}' target='_blank' rel='noopener'>{title}</a>" if url else title
            cands.append(f"<li>{link}<span class='sub2'>{e(txt(c.get('channel')))} &middot; {e(dur(c.get('duration_sec')))}</span></li>")
        sugg.append(f"<div class='sugg'><h4>{e(txt(s.get('topic')))} <span class='tag'>{e(txt(s.get('kind')))}</span></h4>"
                    f"<p>{e(txt(s.get('reason'), ''))}</p><p class='sub2'>Searched for: &ldquo;{e(txt(s.get('search_query')))}&rdquo;</p>"
                    f"<ul class='vlist plain'>{''.join(cands) or '<li class=empty>No real candidate found.</li>'}</ul></div>")
    off = "".join(f"<li>{T.link(x.get('video_id'))}<span class='why'>{e(txt(x.get('reason')))}</span></li>"
                  for x in as_list(res.get("off_goal")) if isinstance(x, dict))
    return (f"<p class='summary'>{counts['covered']} covered, {counts['partial']} partial, {counts['missing']} missing "
            f"(of {len(areas)} areas).</p>{table}"
            f"<h4>Suggested additions</h4><p class='note'>These are real YouTube search results, not yet checked against their transcripts.</p>"
            f"{''.join(sugg) or '<p class=empty>No suggestions in this result.</p>'}"
            + (f"<h4>Flagged as off-goal by the Gap analyst</h4><ul class='vlist plain'>{off}</ul>" if off else ""))


def sec_order(runs, inputs, T) -> str:
    return ("<section id='order' aria-labelledby='h-order'><h2 id='h-order'>The arrangement</h2>"
            "<p class='sub'>Left: the playlist as saved. Right: the order the Sequencer suggests, with a one-line reason for each step.</p>"
            + tabset("ord", runs, [arrangement_body(r, inputs, T) for r in runs]) + "</section>")


def sec_topics(runs, T) -> str:
    return ("<section id='topics' aria-labelledby='h-topics'><h2 id='h-topics'>Topics to cover</h2>"
            "<p class='sub'>What the goal needs, how well the saved videos cover it, and which real videos could fill the gaps.</p>"
            + tabset("top", runs, [topics_body(r, T) for r in runs]) + "</section>")


def sec_agree(evaluation: dict) -> str:
    comps = [c for c in as_list(evaluation.get("comparisons")) if isinstance(c, dict)]
    out = ["<section id='agree' aria-labelledby='h-agree'><h2 id='h-agree'>Agreement and stability</h2>",
           "<p class='sub'><strong>What Kendall tau means:</strong> it compares two watch orders pair by pair. 1 means the two orders are identical, "
           "0 means they are unrelated and -1 means one is the exact reverse of the other. Comparing different providers measures agreement; "
           "comparing repeats of the same provider measures stability.</p>"]
    if not comps:
        out.append("<p class='empty'>No comparisons between runs are available yet.</p></section>")
        return "".join(out)
    out.append("<div class='tablewrap' tabindex='0' role='region' aria-label='Comparison table'><table><thead><tr><th scope='col'>Comparison</th>"
               "<th scope='col'>Group</th><th scope='col'>Runs compared</th><th scope='col'>Value</th><th scope='col'>How computed</th></tr></thead><tbody>")
    for c in comps:
        out.append(f"<tr><th scope='row'>{e(txt(c.get('label'), txt(c.get('key'))))}</th><td>{e(txt(c.get('group')))}</td>"
                   f"<td>{e(txt(c.get('a')))} vs {e(txt(c.get('b')))}</td><td><strong>{e(txt(c.get('display'), NA))}</strong></td>"
                   f"<td>{e(txt(c.get('detail')))}</td></tr>")
    out.append("</tbody></table></div></section>")
    return "".join(out)


def sec_limits(runs: list[Run]) -> str:
    items = ["The reference answers (expected order rules and expected gaps) are provisional, written by the assistant and not by a domain expert.",
             "The Profiler saw excerpts (start, middle and end windows) of each transcript, not whole videos, so a topic taught elsewhere in a video can be missed.",
             "Suggested videos are real search results that have not yet been vetted against their transcripts; being a search result does not make them good.",
             "Token counts come from the provider API responses. Seconds are measured around each call; waiting time is whatever is left of the wall-clock time.",
             "The evidence rests on one playlist of eight videos and a small number of runs, so small differences between runs should not be over-read."]
    if any(r.standin for r in runs):
        items.insert(4, "The stand-in run was produced by Claude subagents, not by Groq or Gemini. Its token totals include the agents' own file reading and are not comparable with provider counts.")
    return ("<section id='limits' aria-labelledby='h-limits'><h2 id='h-limits'>Limits of this evidence</h2><ul class='limits'>"
            + "".join(f"<li>{e(i)}</li>" for i in items) + "</ul></section>")


# ------------------------------------------------------------------------------------------------ style and script
CSS = """
:root{--bg:#f5f6f8;--card:#fff;--ink:#1a2130;--mut:#556072;--line:#d9dde5;--acc:#1f4fb4;--acc-soft:#e6edfb;--ok:#14653c;--warn:#8a5700;--bad:#a4210f;
--warnbg:#fff4dc;--s1:#1f4fb4;--s2:#79a0e8;--s3:#1a2130;--stand:#8a5700}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#11151c;--card:#1a202b;--ink:#e7eaf0;--mut:#a5afc0;--line:#323b4c;--acc:#8db0ff;--acc-soft:#22304f;--ok:#62d19b;--warn:#f1c05d;--bad:#ff9084;--warnbg:#3a2f12;--s1:#8db0ff;--s2:#4a6fbb;--s3:#e7eaf0;--stand:#f1c05d}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 72px}
h1{font-size:clamp(1.6rem,4vw,2.1rem);line-height:1.2;margin:0 0 8px}h2{font-size:1.4rem;margin:0 0 4px;padding-top:8px}
h3{font-size:1.1rem;margin:0 0 6px}h4{font-size:1rem;margin:18px 0 6px}
section{margin-top:44px}a{color:var(--acc)}a:focus-visible,button:focus-visible,summary:focus-visible,.tablewrap:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
code{font-size:.9em;background:var(--acc-soft);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.eyebrow{margin:0;color:var(--acc);font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:.8rem}
.lead{font-size:1.05rem;max-width:70ch}.meta,.sub,.note,.sub2,.muted{color:var(--mut)}.sub{margin:0 0 14px;max-width:80ch}
.meta{font-size:.9rem;margin:6px 0}.note{font-size:.9rem;margin:8px 0;max-width:90ch}.sub2{display:block;font-size:.85rem;font-weight:400}.sub2.inl{display:inline;margin-left:6px}
.honest{border-left:4px solid var(--acc);background:var(--card);padding:10px 14px;margin:14px 0;border-radius:0 8px 8px 0;max-width:85ch}
.banner{background:var(--bad);color:#fff;padding:12px 16px;font-weight:600;text-align:center}.banner strong{letter-spacing:.08em;margin-right:8px;border:2px solid #fff;padding:1px 8px;border-radius:4px}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .banner:not(.soft){color:#1a0b08}:root:not([data-theme=light]) .banner:not(.soft) strong{border-color:#1a0b08}}
.banner code{background:transparent;color:inherit;font-weight:700}.banner.soft{background:var(--warnbg);color:var(--ink);border-bottom:2px solid var(--warn);font-weight:400;text-align:left}
.toc{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:6px 18px}.toc a{text-decoration:none;font-weight:600;font-size:.95rem}.toc a:hover{text-decoration:underline}
.card,.sugg{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
.empty{color:var(--mut);font-style:italic}
/* flow */
.flow{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.step{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;align-items:flex-start}
.step h3{margin:0 0 2px}.step p{margin:0}.step ul{margin:4px 0 0;padding-left:18px}.step li{margin:2px 0}
.step.code{border:2px dashed var(--acc)}
.n{flex:none;min-width:34px;height:34px;border-radius:17px;background:var(--acc);color:var(--card);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;padding:0 6px}
.arrow{color:var(--mut);font-size:.85rem;text-align:center}.arrow:before{content:"\\2193  "}
.par{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:720px){.par{grid-template-columns:1fr}}
/* tables */
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card);margin:10px 0}
table{border-collapse:collapse;width:100%;min-width:520px}th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line);font-size:.93rem}
thead th{background:var(--acc-soft);font-size:.85rem;position:sticky;top:0}tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
tbody th[scope=row]{font-weight:600}tr.grp th{background:var(--bg);color:var(--acc);text-transform:uppercase;letter-spacing:.06em;font-size:.78rem}
table.score{min-width:640px}table.score td{white-space:normal}td.dir{color:var(--mut);white-space:nowrap}td.na{color:var(--mut)}
td.isbest{background:var(--acc-soft)}.val{font-weight:600}.best{display:inline-block;border:1.5px solid var(--acc);color:var(--acc);border-radius:5px;padding:0 6px;font-size:.75rem;font-weight:700;margin-left:4px}
tr.total th,tr.total td{font-weight:700;border-top:2px solid var(--line)}
details summary{cursor:pointer;color:var(--acc);font-size:.82rem;font-weight:400;margin-top:3px}details span,details ul{font-size:.85rem;color:var(--mut);font-weight:400}
.tag{display:inline-block;font-size:.72rem;font-weight:700;border:1.5px solid var(--mut);color:var(--mut);border-radius:5px;padding:0 6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.04em}
.tag.standin{border-color:var(--stand);color:var(--stand)}
.status{font-weight:700;white-space:nowrap}.status.covered{color:var(--ok)}.status.partial{color:var(--warn)}.status.missing{color:var(--bad)}
/* burn */
.finding{font-size:1.05rem;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:8px;padding:12px 14px;max-width:90ch}
.warn{background:var(--warnbg);border:1px solid var(--warn);border-radius:8px;padding:8px 12px;font-size:.92rem;margin:8px 0}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;padding:0;margin:14px 0 4px;font-size:.9rem}.legend li{display:flex;align-items:center;gap:6px}
.sw{width:18px;height:12px;border-radius:2px;display:inline-block;border:1px solid var(--ink)}
.prompt{background:var(--s1)}.comp{background:var(--s2)}.reas{background:repeating-linear-gradient(45deg,var(--s1) 0 3px,var(--card) 3px 6px)}.tot{background:var(--s3);opacity:.55}
.bars{margin:8px 0 14px;display:flex;flex-direction:column;gap:12px}
.barrow{display:grid;grid-template-columns:96px 1fr;gap:2px 12px;align-items:center}.bl{font-weight:600;font-size:.92rem;grid-row:1}
.track{background:var(--bg);border:1px solid var(--line);border-radius:4px;height:22px;display:flex;overflow:hidden;grid-column:2;grid-row:1}
.seg{display:block;height:100%;border-right:1px solid var(--card)}.seg.prompt{background:var(--s1)}.seg.comp{background:var(--s2)}
.seg.reas{background:repeating-linear-gradient(45deg,var(--s1) 0 3px,var(--card) 3px 6px)}.seg.tot{background:var(--s3);opacity:.55}
.bt{grid-column:2;font-size:.88rem}.bd{display:block;color:var(--mut);font-size:.82rem}
@media(max-width:560px){.barrow{grid-template-columns:1fr}.bl,.track,.bt{grid-column:1;grid-row:auto}}
/* tabs, lists */
.tablist{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px}
.tablist button{font:inherit;font-size:.92rem;background:var(--card);color:var(--ink);border:1.5px solid var(--line);border-radius:8px;padding:7px 14px;cursor:pointer;min-height:40px}
.tablist button[aria-selected=true]{border-color:var(--acc);background:var(--acc-soft);color:var(--ink);font-weight:700;box-shadow:inset 0 -3px 0 var(--acc)}
.panel{margin-top:6px}.js .panel[hidden]{display:none}.runh{margin:8px 0}.js .runh{display:none}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
.cols h4:first-child{margin-top:0}
.vlist{margin:0;padding-left:30px}.vlist.plain{list-style:none;padding-left:0}.vlist li{padding:8px 0;border-bottom:1px solid var(--line)}
.vlist li::marker{font-weight:700;color:var(--acc)}.vlist .t{display:block;font-weight:600;overflow-wrap:anywhere}.why{display:block;margin-top:2px;font-size:.92rem}
.summary{max-width:90ch}.checks{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}.checks summary{font-size:.92rem}
.disagree{display:block;margin-top:4px;font-size:.85rem;color:var(--warn);border-left:3px solid var(--warn);padding-left:8px;font-weight:600}.sugg h4{margin-top:0}.sugg p{margin:4px 0}.limits li{margin:8px 0;max-width:85ch}
@media print{.tablist{display:none}.js .panel[hidden]{display:block}}
"""

JS = """
(function(){
  document.documentElement.classList.add('js');
  document.querySelectorAll('.tabset').forEach(function(set){
    var list=set.querySelector('.tablist'); if(!list) return; list.hidden=false;
    var tabs=[].slice.call(list.querySelectorAll('[role=tab]'));
    var panels=[].slice.call(set.querySelectorAll('[role=tabpanel]'));
    function pick(i,focus){
      tabs.forEach(function(t,j){t.setAttribute('aria-selected',j===i?'true':'false');t.tabIndex=j===i?0:-1;});
      panels.forEach(function(p,j){p.hidden=j!==i;});
      if(focus) tabs[i].focus();
    }
    tabs.forEach(function(t,i){
      t.addEventListener('click',function(){pick(i,false);});
      t.addEventListener('keydown',function(ev){
        var k=ev.key,n=tabs.length;
        if(k==='ArrowRight'){pick((i+1)%n,true);ev.preventDefault();}
        else if(k==='ArrowLeft'){pick((i+n-1)%n,true);ev.preventDefault();}
        else if(k==='Home'){pick(0,true);ev.preventDefault();}
        else if(k==='End'){pick(n-1,true);ev.preventDefault();}
      });
    });
    pick(0,false);
  });
})();
"""


# ------------------------------------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--evaluation", default=str(OUT / "evaluation.json"), help="evaluation file (default out/evaluation.json)")
    ap.add_argument("--output", default=str(OUT / "dashboard.html"), help="output file (default out/dashboard.html)")
    args = ap.parse_args()

    warnings: list[str] = []
    ev_path = Path(args.evaluation)
    if not ev_path.is_absolute():
        ev_path = (Path.cwd() / ev_path) if (Path.cwd() / ev_path).exists() else (HERE / ev_path)
    evaluation, sample = load(ev_path), False
    if not isinstance(evaluation, dict):
        sample = True
        evaluation = load(SAMPLE)
        msg = f"{ev_path.name} was not found or unreadable: using {SAMPLE.name}. Scoreboard numbers are SAMPLE DATA."
        print("!" * 78 + f"\nWARNING: {msg}\n" + "!" * 78, file=sys.stderr)
        if not isinstance(evaluation, dict):
            evaluation = {}
            msg += " The sample file is missing too, so no metrics are shown."
        warnings.append(msg)

    inputs = load(OUT / "inputs.json")
    if not isinstance(inputs, dict):
        inputs = {}
        warnings.append("out/inputs.json is missing: video titles cannot be shown.")
    T = Titles(inputs)
    runs = collect_runs(evaluation)
    for r in runs:
        if r.result is None:
            warnings.append(f"Run {r.label}: result.json not found yet, so its arrangement and topics are not shown.")
        if r.usage is None:
            warnings.append(f"Run {r.label}: usage.json not found, so its cost is not shown.")
        if sample and not r.metrics:
            warnings.append(f"Run {r.label}: not in the sample evaluation file, so it has no scoreboard numbers.")

    goal = txt(inputs.get("goal") or next((r.result.get("goal") for r in runs if r.result and r.result.get("goal")), None))
    parts = [sec_header(goal, evaluation, sample, warnings), sec_how(), sec_score(runs), sec_burn(runs),
             sec_order(runs, inputs, T), sec_topics(runs, T), sec_agree(evaluation), sec_limits(runs), "</main>"]
    doc = ("<!doctype html><html lang='en'><head><meta charset='utf-8'>"
           "<meta name='viewport' content='width=device-width,initial-scale=1'>"
           "<meta name='color-scheme' content='light dark'><title>Smart playlist: evidence report</title>"
           f"<style>{CSS}</style></head><body>{parts[0]}{''.join(parts[1:])}<script>{JS}</script></body></html>")
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    print(f"wrote {out} ({len(doc):,} bytes, {len(runs)} runs: {', '.join(r.label for r in runs)})" + ("  [SAMPLE DATA]" if sample else ""))
    for w in warnings:
        print("note:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
