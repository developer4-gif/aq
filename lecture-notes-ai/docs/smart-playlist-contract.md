# Smart playlist - contract between the three layers

The playlist NAME is the learning goal; its videos are the topics already covered.
One run = 3 AI agents (profiler, sequencer, gap analyst) + code checks. The working prototype is
`lecture-notes-ai/demo/smart_playlist/run_demo.py` (prompts, `verify()`, `_search_youtube()`); the three layers below
turn it into a feature. Do not change this contract without telling the orchestrator.

```
browser (lecture-notes-ui)  -->  aq-api :5180 (Node)  -->  Python worker :5055 (notes_engine)  -->  Gemini / Groq
```

NEVER touch the OAuth app: `D:\AQspace\backend`, `D:\AQspace\frontend`, `docker-compose.yml` at `D:\AQspace` root.
(`D:\AQspace\lecture-notes-ai\backend` IS ours - it is the Python worker.) Never print or log API keys.
All scratch/temp files stay on D: (`$env:TEMP='D:\AQspace\lecture-notes-ai\backend\.tmp'`). No git commit/push/sync.

## 1. Python worker (port 5055)

`POST /api/smart`   JSON `{ "goal": str (1-120), "videos": [{"id": 11-char, "title": str, "channel": str, "duration_sec": int}] (2..20),
                         "provider": "gemini"|"groq", "model"?: str }`
  -> `202 {"job_id": hex}`; 400 for bad input (same error style as /api/jobs); 429 when busy; 503 if engine not installed.
  Keys come from `backend/.env` through the existing `server_key(provider)` (never from the browser).
  Default model for provider gemini is `gemini-3.5-flash-lite` (the old default `gemini-2.5-flash` returns 404 for new keys).

`GET /api/smart/<job_id>` -> `200 {"status": "queued"|"running"|"done"|"error", "stage": "transcripts"|"profiling"|"ordering"|"gaps"|"checking"|"candidates",
                                  "pct": 0-100, "message": str, "error": str, "result"?: Result, "usage"?: Usage}`; `404` when unknown (worker restarted).

Result (only when status = done):
```json
{
  "goal": "System Design Interview Prep",
  "path_summary": "one or two sentences",
  "order": [{"video_id": "i7twT3x5yv8", "reason": "why here"}],
  "unplaced": [{"video_id": "U-G-mSd4KAE", "reason": "why it is not in the path"}],
  "off_goal": [{"video_id": "U-G-mSd4KAE", "reason": "..."}],
  "areas": [{"area": "Rate limiting", "why": "...", "status": "covered"|"partial"|"missing",
             "covered_by": ["videoId"], "priority": "high"|"medium"|"low"}],
  "suggestions": [{"topic": "...", "reason": "...", "kind": "overview"|"deep-dive"|"practice",
                   "search_query": "...", "candidates": [{"id": "11chars", "title": "", "channel": "", "duration_sec": 656, "url": "https://www.youtube.com/watch?v=..."}]}],
  "video_topics": {"videoId": {"level": "beginner"|"intermediate"|"advanced", "summary": "...", "topics": ["name", "..."]}},
  "checks": ["human readable verification notes"],
  "stats": {"topics_claimed": 25, "topics_grounded": 22, "videos_readded_to_order": 0, "areas_downgraded_to_missing": 0, "suggestions": 3, "candidates_found": 6}
}
```
Rules the code (not the model) enforces - same as the demo: every playlist video appears exactly once in `order` or `unplaced`;
a "covered" area must cite real playlist videos (else downgraded to "missing"); topic evidence quotes must exist in the transcript
(unsupported topics are dropped); candidates are real YouTube search results, 120-1500 s long, not already in the playlist.
`Usage`: `{"calls": n, "total_tokens": n, "wall_seconds": x, "api_seconds": x, "waiting_seconds": x}` (burn ledger, per run).
Jobs live in memory (like notes jobs); finished jobs are pruned like the existing ones.

## 2. aq-api (port 5180) - base `/api/v1`, user = `req.user`, playlist = slug `:id`

`POST /api/v1/playlists/:id/smart`  (heavy rate limiter)
  - 404 unknown playlist; 422 `{error}` when the playlist has < 2 or > 20 videos.
  - Builds `{goal: playlist.name, videos}` from the playlist, computes `fingerprint` = sha256 of goal + the SORTED video ids.
  - If a run with the same fingerprint is `queued|running|ready` -> return it (200, `cached: true`). Else start one in the worker -> 202.
  - Provider = `config.pySmartProvider` (env `PY_SMART_PROVIDER`, default `gemini`).
`GET /api/v1/playlists/:id/smart` -> the latest run for that playlist (so the panel can auto-show):
```json
{ "state": "none"|"queued"|"running"|"ready"|"error",
  "pct": 0, "stage": "profiling", "message": "", "error": "",
  "fingerprint": "...", "current": true, "generatedAt": "ISO", "provider": "gemini", "model": "gemini-3.5-flash-lite",
  "result": Result, "usage": Usage }
```
  `current` = fingerprint still matches the playlist now (false -> "playlist changed since this was generated"; result still returned).
  `result`/`usage` only when state = ready. Results are STORED in SQLite (new migration `sql/002_smart_runs.sql`) so they survive worker restarts
  and page reloads; a queued/running job whose worker id 404s becomes `error` ("The analysis was interrupted - run it again").
  A failed run never blocks a new POST.

## 3. UI (lecture-notes-ui, vanilla JS, no build step)

- New `smart.js` (+ a clearly labelled `smart` section appended to `styles.css`, + a `<script>` tag before `app.js`; minimal hooks in `app.js renderDetail`).
- The button (spec the user pasted): dark pill, `border-radius:9999px`, bg `rgba(255,255,255,.08)` / `#1C1C1E`, faint border + outer glow, 4-point sparkle icon on the left.
  Idle: icon + text muted gray `#6E6E73`. Hover: text+icon -> `#FFFFFF`, a soft purple->pink gradient ring/back-light scales up and fades in, the sparkle rotates/pulses slightly.
  Pressed: `transform: scale(.96)`. Running: label changes to "Arranging..." with a shimmer travelling across the gradient border. Label idle = "Smart arrange".
  Must keep keyboard focus ring, `aria-busy`, `prefers-reduced-motion` (no spin/shimmer), and fit the existing black/silver theme and the other `.btn` heights.
- Clicking = POST the run, poll GET (every ~1.5 s, stop on ready/error or when leaving the page) and the panel appears AUTOMATICALLY.
  On opening a playlist that already has a stored run, the panel shows immediately (no click).
- The panel ("Learning path" + "Topics to cover"): goal as title, `path_summary`; the covered / partial / missing areas (missing first, high priority first);
  suggested videos per missing topic with thumbnail-less compact rows, duration, "Add to playlist" and "Watch on YouTube"; recommended order with reasons and an
  "Apply order" button (uses the existing store reorder + undo toast); off-goal videos flagged; a small footer with the checks/usage ("Verified by code: 22/25 topics backed by transcript quotes - 14.5 s").
  Stale (`current:false`) shows a quiet "Playlist changed since this was generated" note with the button as the refresh action.
- Do not restyle or break the existing page; nothing else on the page may change position unexpectedly.
