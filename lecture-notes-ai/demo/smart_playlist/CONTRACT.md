# Smart playlist demo: data contracts

Folder: `demo/smart_playlist/`. Python: `D:\AQspace\lecture-notes-ai\.venv\Scripts\python.exe`.
Set `TEMP` and `TMP` to `D:\AQspace\lecture-notes-ai\backend\.tmp` before running anything (C: is nearly full).

## Inputs (shared)
- `out/inputs.json`: `{"goal": str, "videos": [{"id","position","title","channel","duration_sec","words","excerpt"}]}`
  `excerpt` is the transcript text the Profiler saw (start, middle, end windows, with `[mm:ss]` markers).
- `gold.json`: reference answers (see its `_note`: provisional).

## Per run (folder `out/runs/<label>/`, e.g. `groq-1`, `gemini-1`, `claude-standin`)
- `agent1.json`: raw Profiler output `{"profiles":[{"video_id","level","summary","topics":[{"name","evidence"}],"prerequisites":[]}]}`
- `agent2.json`: raw Sequencer output `{"order":[{"video_id","reason"}],"unplaced":[{"video_id","reason"}],"path_summary"}`
- `agent3.json`: raw Gap analyst output `{"areas":[{"area","why","status","covered_by":[],"priority"}],"suggestions":[...],"off_goal":[...]}`
- `result.json`: AFTER code verification (this is what the user sees):
  `{"goal","profiles":{video_id:{"level","summary","topics":[{"name","evidence"}],"prerequisites"}},"order":[{"video_id","reason"}],
    "unplaced":[{"video_id","reason"}],"path_summary","areas":[{"area","why","status":"covered|partial|missing","covered_by":[ids],"priority"}],
    "suggestions":[{"topic","reason","kind","search_query","candidates":[{"id","duration_sec","channel","title","url"}]}],
    "off_goal":[{"video_id","reason"}],"checks":[str],
    "stats":{"topics_claimed","topics_grounded","videos_readded_to_order","areas_downgraded_to_missing","suggestions","candidates_found"}}`
- `usage.json`: `{"provider","model","source","calls":[{"agent","label","prompt_tokens","completion_tokens","reasoning_tokens","total_tokens","api_seconds"}],
  "per_agent":{"1":{"calls","prompt_tokens","completion_tokens","reasoning_tokens","total_tokens","api_seconds","wall_seconds"},"2":{...},"3":{...}},
  "totals":{"calls","prompt_tokens","completion_tokens","reasoning_tokens","total_tokens","api_seconds","wall_seconds","waiting_seconds"}}`
  The `claude-standin` run only has `total_tokens` and `wall_seconds` per agent, and its `source` says they are NOT comparable with provider API counts. Any field may be missing: never crash, show "n/a".
- `run_meta.json`: `{"provider","model"}`.

## Output of evaluate.py: `out/evaluation.json`
```
{
  "generated": "<ISO time>",
  "gold_note": "<copy of gold.json _note>",
  "runs": [
    {"label": "groq-1", "provider": "...", "model": "...", "kind": "live" | "stand-in",
     "metrics": [
        {"key": "grounding_rate", "group": "Grounding", "label": "Topics backed by a transcript quote",
         "value": 0.897, "display": "35 / 39 (90%)", "unit": "ratio", "direction": "higher",
         "detail": "one sentence: exactly how it is computed"}
     ]}
  ],
  "comparisons": [
     {"a": "groq-1", "b": "gemini-1", "key": "order_kendall_tau", "group": "Agreement", "label": "...",
      "value": 0.71, "display": "0.71", "detail": "..."}
  ]
}
```
- `value`: number or null (null when it cannot be computed; `display` then says why, e.g. "n/a").
- `unit`: ratio | count | tau | seconds | tokens | text. `direction`: higher | lower | info (is a bigger value better?).
- `kind` is "stand-in" for `claude-standin`, otherwise "live".
- Groups used: Grounding, Arrangement, Coverage, Suggestions, Burn (per run); Stability and Agreement (in `comparisons`).
