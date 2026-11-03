// Notes provider evaluation dashboard. Loads eval-data.json; renders with textContent only (no innerHTML).
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const NM = "not measured";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function svg(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const pct = (v, d = 0) => (isNum(v) ? (v * 100).toFixed(d) + "%" : null);
  const fix = (v, d = 1) => (isNum(v) ? v.toFixed(d) : null);
  const sec = (v) => (isNum(v) ? (v >= 120 ? (v / 60).toFixed(1) + " min" : v.toFixed(1) + " s") : null);

  // a cell that shows "not measured" in muted italics when value is null
  function cell(tr, v, cls) {
    const td = el("td", cls || "");
    if (v === null || v === undefined || v === "") { td.textContent = NM; td.classList.add("nm"); }
    else td.textContent = String(v);
    tr.appendChild(td);
    return td;
  }
  function head(table, cols) {
    const tr = el("tr");
    cols.forEach((c) => tr.appendChild(el("th", "", c)));
    const th = el("thead"); th.appendChild(tr); table.appendChild(th);
  }

  function name(c) { return c.id + " (" + c.model + ")"; }

  function cards(d) {
    const box = $("cards");
    const cs = d.contestants;
    const pass = cs.filter((c) => c.decision.passes_gates && isNum(c.decision.composite));
    const add = (k, v, s) => { const c = el("div", "ev-card"); c.append(el("div", "k", k), el("div", "v", v), el("div", "s", s)); box.appendChild(c); };
    if (pass.length) add("Recommended", pass[0].id, "composite " + pass[0].decision.composite.toFixed(3) + " - " + pass[0].model);
    else add("Recommended", "none", "no contestant passed every gate with all metrics measured");
    const lat = cs.filter((c) => isNum(c.latency_p50)).sort((a, b) => a.latency_p50 - b.latency_p50);
    if (lat.length) add("Fastest (p50 latency)", lat[0].id, sec(lat[0].latency_p50) + " median over " + lat[0].latency_n + " successful runs");
    else add("Fastest", NM, "");
    const fa = cs.filter((c) => isNum(c.hallucination_rate_mean)).sort((a, b) => a.hallucination_rate_mean - b.hallucination_rate_mean);
    if (fa.length) add("Most faithful", fa[0].id, pct(fa[0].hallucination_rate_mean, 1) + " unsupported claims (judge)");
    else add("Most faithful", NM, "");
    const tot = d.runs.length, ok = d.runs.filter((r) => r.status === "success").length;
    add("Runs recorded", ok + " / " + tot + " succeeded", d.videos.length + " videos x " + cs.length + " contestants x 2 runs");
  }

  function decision(d) {
    const k = d.constants;
    $("formula").textContent =
      "Gates: success rate >= " + k.success_gate * 100 + "% and judge hallucination rate <= " + k.hallucination_gate * 100 +
      "%. Then composite = " + k.w_quality + " x quality + " + k.w_speed + " x speed + " + k.w_headroom + " x headroom, where " +
      "quality = (0.4 x rubric overall/10 + 0.3 x coverage recall + 0.2 x (1 - hallucination rate) + 0.1 x pairwise win rate), re-weighted over the parts that were measured; " +
      "speed = fastest p50 latency / this p50 latency; headroom = (1 - wait share) x (0 if a hard daily quota was hit, else 1). " +
      "Contestants that fail a gate are ranked below all that pass.";
    const t = $("decision");
    head(t, ["#", "Contestant", "Model", "Gates", "Composite", "Quality", "Speed", "Headroom", "Success", "Recall", "Halluc.", "Rubric /10", "Win rate", "p50", "p95"]);
    const tb = el("tbody");
    d.contestants.forEach((c) => {
      const tr = el("tr");
      cell(tr, c.rank, "num"); cell(tr, c.id); cell(tr, c.model, "mono");
      const g = cell(tr, c.decision.passes_gates ? "pass" : c.decision.gates_failed.join("; "), "wrap");
      g.classList.add(c.decision.passes_gates ? "ok" : "bad");
      cell(tr, fix(c.decision.composite, 3), "num"); cell(tr, fix(c.decision.quality, 3), "num");
      cell(tr, fix(c.decision.speed, 3), "num"); cell(tr, fix(c.decision.headroom, 3), "num");
      cell(tr, isNum(c.success_rate) ? pct(c.success_rate) + " (" + c.succeeded + "/" + c.attempted + ")" : null, "num");
      cell(tr, pct(c.recall_mean), "num"); cell(tr, pct(c.hallucination_rate_mean, 1), "num");
      cell(tr, fix(c.rubric_mean.overall, 1), "num"); cell(tr, isNum(c.pairwise_win_rate) ? pct(c.pairwise_win_rate) + " of " + c.pairwise_games : null, "num");
      cell(tr, sec(c.latency_p50), "num"); cell(tr, sec(c.latency_p95), "num");
      tb.appendChild(tr);
    });
    d.unavailable.forEach((u) => {
      const tr = el("tr", "na");
      cell(tr, "-"); cell(tr, u.id); const td = el("td", "wrap", u.reason); td.colSpan = 13; tr.appendChild(td);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  }

  // horizontal bar chart; rows: {label, value, tick?, text}
  function barChart(title, sub, rows, opt) {
    opt = opt || {};
    const box = el("div", "ev-chart");
    box.append(el("h3", "", title), el("p", "", sub));
    const W = 460, rowH = 26, L = 128, R = 92, H = rows.length * rowH + 8;
    const s = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
    const vals = rows.map((r) => r.value).concat(rows.map((r) => r.tick)).filter(isNum);
    const max = opt.max || Math.max(1e-9, ...vals);
    const best = opt.lowerBetter ? Math.min(...rows.map((r) => r.value).filter(isNum)) : Math.max(...rows.map((r) => r.value).filter(isNum));
    rows.forEach((r, i) => {
      const y = 4 + i * rowH;
      s.appendChild(svg("text", { x: 0, y: y + 16, class: "lbl" }, r.label));
      s.appendChild(svg("rect", { x: L, y: y + 4, width: W - L - R, height: 16, rx: 3, class: "track" }));
      if (isNum(r.value)) {
        const w = Math.max(1, (W - L - R) * Math.min(1, r.value / max));
        s.appendChild(svg("rect", { x: L, y: y + 4, width: w, height: 16, rx: 3, class: "bar" + (r.value === best ? " best" : "") }));
      }
      if (isNum(r.tick)) {
        const x = L + (W - L - R) * Math.min(1, r.tick / max);
        s.appendChild(svg("line", { x1: x, x2: x, y1: y + 2, y2: y + 22, class: "tick" }));
      }
      s.appendChild(svg("text", { x: W - R + 6, y: y + 16, class: isNum(r.value) ? "" : "lbl" }, isNum(r.value) ? r.text : NM));
    });
    if (isNum(opt.gate)) {
      const x = L + (W - L - R) * Math.min(1, opt.gate / max);
      s.appendChild(svg("line", { x1: x, x2: x, y1: 0, y2: H, class: "gate" }));
    }
    box.appendChild(s);
    return box;
  }

  function charts(d) {
    const box = $("charts");
    const cs = d.contestants;
    const R = (f, t, tick) => cs.map((c) => ({ label: c.id, value: f(c), tick: tick ? tick(c) : undefined, text: t(c) }));
    box.appendChild(barChart("Latency (p50, lower is better)", "Bar = median end-to-end seconds per run; yellow tick = p95. Successful runs only.",
      R((c) => c.latency_p50, (c) => sec(c.latency_p50), (c) => c.latency_p95), { lowerBetter: true }));
    box.appendChild(barChart("Success rate", "Successful runs / attempted runs. Red dashed line = 90% gate.",
      R((c) => c.success_rate, (c) => pct(c.success_rate)), { max: 1, gate: d.constants.success_gate }));
    box.appendChild(barChart("Coverage recall", "Share of the video's gold key facts the judge found in the notes.",
      R((c) => c.recall_mean, (c) => pct(c.recall_mean)), { max: 1 }));
    box.appendChild(barChart("Hallucination rate (lower is better)", "Share of sampled claims the judge found unsupported by the transcript. Red line = gate.",
      R((c) => c.hallucination_rate_mean, (c) => pct(c.hallucination_rate_mean, 1)), { lowerBetter: true, max: Math.max(0.2, ...cs.map((c) => c.hallucination_rate_mean || 0)), gate: d.constants.hallucination_gate }));
    box.appendChild(barChart("Grounding check (code)", "Numbers and quoted terms in the notes that literally appear in the transcript.",
      R((c) => c.grounding_rate_mean, (c) => pct(c.grounding_rate_mean)), { max: 1 }));
    box.appendChild(barChart("Rubric score (judge, 1-10)", "Mean 'overall' score. Accuracy / coverage / clarity / structure are in the per-video table.",
      R((c) => c.rubric_mean.overall, (c) => fix(c.rubric_mean.overall, 1)), { max: 10 }));
    box.appendChild(barChart("Pairwise win rate", "Anonymised A/B comparisons of run-1 notes per video; tie = half a win.",
      R((c) => c.pairwise_win_rate, (c) => isNum(c.pairwise_win_rate) ? pct(c.pairwise_win_rate) + " /" + c.pairwise_games : null), { max: 1 }));
    box.appendChild(barChart("Output tokens / sec", "Provider-reported output tokens (incl. reasoning) / time inside HTTP calls.",
      R((c) => c.tokens_per_sec_mean, (c) => fix(c.tokens_per_sec_mean, 0))));
    box.appendChild(barChart("Wait share (lower is better)", "Share of run time spent in the engine's pacing / retry sleeps.",
      R((c) => c.wait_share_mean, (c) => pct(c.wait_share_mean)), { lowerBetter: true, max: 1 }));
    box.appendChild(barChart("Output size", "Mean words in the finished notes.",
      R((c) => c.output_words_mean, (c) => fix(c.output_words_mean, 0))));
    box.appendChild(barChart("Consistency (rubric SD, lower is better)", "Std. dev. of the overall score between the 2 runs, averaged over videos.",
      R((c) => c.consistency_sd, (c) => fix(c.consistency_sd, 2)), { lowerBetter: true, max: 3 }));
    box.appendChild(barChart("Noise leakage", "Filler/promo phrases (subscribe, sponsor, like the video...) per 1k words of notes.",
      R((c) => c.noise_per_1k_mean, (c) => fix(c.noise_per_1k_mean, 2) + " (" + c.noise_hits_total + ")"), { lowerBetter: true, max: Math.max(1, ...cs.map((c) => c.noise_per_1k_mean || 0)) }));
  }

  function perVideo(d) {
    const box = $("perVideo");
    d.videos.forEach((v) => {
      box.appendChild(el("h3", "", v.label + "  (" + v.id + ")"));
      box.appendChild(el("p", "muted", "Transcript " + v.transcript_chars + " chars; " + v.gold_facts + " auto-generated gold facts."));
      const wrap = el("div", "ev-scroll"); const t = el("table", "ev-table ev-small");
      head(t, ["Contestant", "Run", "Status", "Latency", "Words", "Recall", "Halluc.", "Grounding", "Acc", "Cov", "Clar", "Struct", "Overall", "Judge rationale"]);
      const tb = el("tbody");
      d.runs.filter((r) => r.video === v.id).forEach((r) => {
        const tr = el("tr");
        cell(tr, r.contestant); cell(tr, r.run, "num");
        const st = cell(tr, r.status); st.classList.add(r.status === "success" ? "ok" : "bad");
        const rb = r.rubric || {};
        cell(tr, sec(r.latency_sec), "num"); cell(tr, r.output_words, "num");
        cell(tr, pct(r.recall), "num"); cell(tr, pct(r.hallucination_rate, 0), "num");
        cell(tr, r.grounding ? pct(r.grounding.grounding_rate) : null, "num");
        ["accuracy", "coverage", "clarity", "structure", "overall"].forEach((k) => cell(tr, rb[k], "num"));
        cell(tr, r.rubric_rationale || (r.status === "success" ? null : r.error), "wrap");
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
      const pw = d.pairwise.filter((p) => p.video === v.id);
      if (pw.length) {
        const det = el("details", "ev-det"); det.appendChild(el("summary", "", "Pairwise judgements (" + pw.length + ")"));
        const ul = el("ul", "ev-list");
        pw.forEach((p) => ul.appendChild(el("li", "", p.a + " vs " + p.b + " -> " + p.winner + " (shown first: " + p.shown_first + "). " + (p.reason || ""))));
        det.appendChild(ul); box.appendChild(det);
      }
      if (v.gold && v.gold.length) {
        const det = el("details", "ev-det"); det.appendChild(el("summary", "", "Gold key facts (auto-generated, editable in out/gold/" + v.id + ".json)"));
        const ol = el("ol", "ev-list"); v.gold.forEach((f) => ol.appendChild(el("li", "", f.fact))); det.appendChild(ol); box.appendChild(det);
      }
    });
  }

  function runlog(d) {
    const t = $("runlog");
    head(t, ["Started", "Contestant", "Video", "Run", "Status", "Latency", "HTTP req", "HTTP statuses", "Sleep", "Out tokens", "Error type", "Error"]);
    const tb = el("tbody");
    d.runs.slice().sort((a, b) => String(a.started).localeCompare(String(b.started))).forEach((r) => {
      const tr = el("tr");
      cell(tr, r.started || "-", "mono"); cell(tr, r.contestant); cell(tr, r.video, "mono"); cell(tr, r.run, "num");
      const st = cell(tr, r.status); st.classList.add(r.status === "success" ? "ok" : "bad");
      cell(tr, sec(r.latency_sec), "num"); cell(tr, r.http_requests, "num");
      cell(tr, r.http_statuses ? Object.entries(r.http_statuses).map((e) => e[0] + ":" + e[1]).join(" ") : null, "mono");
      cell(tr, sec(r.sleep_sec), "num"); cell(tr, r.output_tokens, "num");
      cell(tr, r.error_type || "-"); cell(tr, r.error || "-", "wrap");
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  }

  const GLOSSARY = [
    ["End-to-end latency", "Wall-clock seconds from calling generate_notes() to validated notes, including every API call, retry and pacing sleep."],
    ["p50 / p95", "Median and 95th-percentile latency across successful runs. With 8 runs per contestant, p95 is close to the slowest run."],
    ["Output tokens / sec", "Output tokens reported by the provider's usage field (Gemini usageMetadata incl. thinking tokens; OpenAI-style usage.completion_tokens) divided by time spent inside HTTP calls. 'not measured' if the provider reported no usage."],
    ["Wait share", "Share of the run spent in the engine's own sleeps (client-side token pacer + 429/5xx retry back-off), measured by wrapping the engine's sleep function."],
    ["Success rate", "Runs that returned notes / runs attempted. Runs skipped after a hard daily quota are not counted as attempts but are listed as errors in the run log."],
    ["Error types", "quota_daily (provider says daily cap reached), quota_429 (rate limit after retries), timeout (network/timeout), invalid_json (model output not parseable into notes), output_truncated (model hit its output-token limit), server_5xx, config, other."],
    ["Schema validity", "Share of successful runs whose output passes notes_schema.validate_notes (the engine already enforces this, so it is a sanity check)."],
    ["Consistency", "Population standard deviation of the judge's overall score between the 2 runs of the same video, averaged over videos. Lower = more repeatable."],
    ["Coverage / recall", "Share of the video's 12-15 gold key facts that the judge says the notes state (paraphrase allowed)."],
    ["Faithfulness / hallucination rate", "The judge picks ~20 atomic factual claims from the notes and checks each against the transcript; rate = unsupported / checked."],
    ["Grounding check", "Code-only check: numbers and short quoted terms in the notes that literally appear in the transcript (number words like 'seven' count). Does not need a judge; misses paraphrased facts."],
    ["Noise leakage", "Code-only count of filler/promo phrases (subscribe, sponsor, like the video, link in the description...) in the notes, per 1k words."],
    ["LLM-as-a-judge rubric", "The judge scores accuracy, coverage, clarity, structure and overall on 1-10 with a short rationale."],
    ["Pairwise win rate", "For each video, every pair of contestants' run-1 notes is shown to the judge as anonymous A/B in a seeded random order; wins / comparisons, tie = 0.5."],
    ["Self-preference bias", "LLM judges tend to rate text from their own model family higher. Here the judge is Gemini, and Gemini is also a contestant."],
    ["Composite", "Weighted score used for ranking after the gates; formula shown above the decision table."],
  ];

  function glossary() {
    const dl = $("glossary");
    GLOSSARY.forEach((g) => { dl.appendChild(el("dt", "", g[0])); dl.appendChild(el("dd", "", g[1])); });
  }

  function method(d) {
    const ul = $("method");
    const items = [
      "Test set: " + d.videos.length + " real videos from the user's library (" + d.videos.map((v) => v.label).join("; ") + "). Transcripts fetched once and cached.",
      "Contestants called the production engine (notes_engine.llm.generate_notes) unchanged, one generation at a time, 2 runs per video, with the engine's on-disk digest cache switched off so run 2 is a fresh generation.",
      "Sample size is tiny: at most 8 runs per contestant. Differences of a few percentage points or under 1 rubric point are not meaningful; p95 is effectively the slowest run.",
      "Judge: " + d.judge + " for gold facts, coverage, faithfulness, rubric and pairwise. It may favour Gemini output (self-preference bias), and it can itself be wrong. Treat Gemini's quality scores with extra caution.",
      "Gold facts are auto-generated by the judge from the transcript, not written by a human. They are editable (out/gold/<id>.json); editing them invalidates the cached per-run judgements, which are re-run on the next run_eval.py --judge-only.",
      "Coverage, faithfulness and rubric are produced in one judge call per run (to stay inside free-tier limits); pairwise uses run 1 only.",
      "Latency includes free-tier pacing and retries, so it reflects this account's limits at the time of the run, not the providers' raw speed. Groq's client-side token pacer dominates its latency.",
      "Headroom is a proxy: share of time not spent waiting, zeroed if a hard daily quota was hit. Official free-tier quotas were not measured.",
      "Not run: Colab (no GPU session) and Hugging Face (no credits) - shown greyed out.",
      "Code checks (grounding, noise) are literal string matches; they can flag correct paraphrases and miss subtle errors.",
    ];
    if (d.judge_quota) items.push("Judge hit a quota at " + d.judge_quota.when + "; some judgements may be missing (shown as not measured).");
    items.forEach((s) => ul.appendChild(el("li", "", s)));
  }

  function render(d) {
    $("meta").textContent = "Generated " + d.generated + " | judge " + d.judge;
    const gem = d.contestants.some((c) => c.provider === "gemini");
    if (gem) {
      $("biasWarn").hidden = false;
      $("biasText").textContent = "the judge is " + d.judge + ", so it may favour the Gemini contestant (self-preference bias). Rubric, coverage, faithfulness and pairwise results for gemini should be read with that in mind.";
    }
    cards(d); decision(d); charts(d); perVideo(d); runlog(d); glossary(); method(d);
  }

  fetch("eval-data.json", { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(render)
    .catch((e) => { const b = $("loadErr"); b.hidden = false; b.textContent = "Could not load eval-data.json (" + e.message + "). Run demo/notes_eval/build_data.py."; glossary(); });
})();
