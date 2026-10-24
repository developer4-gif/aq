# AQ Learning - architecture

AQ Learning turns YouTube lectures into **playlists you can watch in order**, with **resume-where-you-left-off progress** and **hand-drawn study notes** (HTML + PDF) written by an AI model from the video's transcript.

It is three small programs, each with one job:

| Program | Folder | Runtime | Port | Job |
|---|---|---|---|---|
| UI | `lecture-notes-ui/` | vanilla JS/CSS in the browser (no build step) | served by aq-api on **5180** (or `serve.ps1` on 5173) | playlists, player, progress bars, notes viewer |
| App backend | `aq-api/` | Node >= 24, Express 5, SQLite (`node:sqlite`) | **5180** | users + auth seam, playlists, videos, watch progress, notes records cached by `video_id`, proxy to Python, serves the UI |
| AI / media worker | `lecture-notes-ai/` | Python 3.10+, Flask, `notes_engine` package | **5055** (127.0.0.1 only) | YouTube transcript, LLM notes, HTML/PDF rendering, playlist listing; knows nothing about users |

> Visual version of this document: [`AQ-Learning-Dev-Notebook.pdf`](AQ-Learning-Dev-Notebook.pdf) (a hand-drawn developer notebook, one topic per page). Its source is [`dev-notebook.json`](dev-notebook.json), rendered with the project's own `notes_engine`.

Rule of thumb: **Node owns state and identity; Python owns slow, expensive, stateless work.** The browser talks to one door (Node, :5180); Node calls Python on `127.0.0.1:5055`.

---

## 1. System map

```
                       +-------------------------------------------+
                       |  browser  -  lecture-notes-ui (vanilla JS) |
                       |  hash router, store.js, player, notes view |
                       +---------------------+---------------------+
                                             | REST + JSON  (same origin :5180)
                                             v
   +-----------------------------------------------------------------------------+
   | aq-api  (Node 24, Express 5)                          http://127.0.0.1:5180 |
   |  host guard -> CORS -> security headers -> rate limit -> auth middleware     |
   |  routes: playlists | videos | progress | notes | youtube import | health     |
   |  static: serves ../lecture-notes-ui                                          |
   |        |                                                  |                 |
   |        v SQL                                              v HTTP (fetch)    |
   |  SQLite  data/aq.db                                 pyclient.js             |
   |  users, videos, playlists, playlist_videos,                |                |
   |  watch_progress, notes_jobs                                |                |
   +------------------------------------------------------------+----------------+
                                                                | 127.0.0.1:5055
                                                                v
   +-----------------------------------------------------------------------------+
   | lecture-notes-ai  (Python, Flask)   AI / media worker                       |
   |  guard -> routes -> in-memory State.jobs -> job thread                      |
   |     ingest.py  ----> YouTube (captions API, yt-dlp, ffmpeg + Groq Whisper)  |
   |     llm.py     ----> Gemini | Groq | xAI Grok | Hugging Face                |
   |     notes_schema.py (validate)  ->  pdf.py (+templates/, fonts)             |
   |     headless Edge/Chrome --print-to-pdf                                     |
   |  files: backend/output/<job_id>/notes.json | notes.html | notes.pdf  (24 h) |
   +-----------------------------------------------------------------------------+
```

The browser also talks **directly** to YouTube for two things only: the embedded player (`youtube-nocookie.com`, plus the IFrame API script and `oembed` for titles) and thumbnails (`i.ytimg.com`). Everything else goes through Node.

## 2. Tech stack

| Layer | Tech | Notes |
|---|---|---|
| UI | HTML, CSS, vanilla JS (IIFE modules on `window.AQ`) | no framework, no bundler, no `innerHTML` |
| App backend | Node >= 24, Express 5, built-in `node:sqlite` (`DatabaseSync`) | WAL mode, migrations in `sql/` |
| AI worker | Python 3.10+, Flask 3, flask-cors, python-dotenv, `requests` | no vendor SDKs |
| Transcripts | `youtube-transcript-api`, `yt-dlp`, `ffmpeg`, Groq Whisper (`whisper-large-v3-turbo`) | 3-step fallback chain |
| LLMs | Gemini (`gemini-2.5-flash`), Groq (`openai/gpt-oss-120b`), xAI (`grok-4`), Hugging Face (`Llama-3.3-70B-Instruct`) | called with plain HTTP |
| Notebook look | Rough.js (vendored), Kalam / Patrick Hand / Caveat / JetBrains Mono (OFL fonts) | self-contained HTML |
| PDF | headless Microsoft Edge / Google Chrome `--print-to-pdf`, PyMuPDF for checks | `LNAI_BROWSER` overrides the browser |
| Tests | pytest (Python, network mocked, ~185 cases), `node --test` (Node, 32 cases) | no live calls needed |

## 3. Repo layout

```
D:\AQspace
  lecture-notes-ui\      the UI (index.html + 13 .js files + styles.css), serve.ps1
    _landing-backup\     previous marketing landing page, untouched
    screenshots\         reference screenshots of the screens and effects
  aq-api\                Node app backend (src\, sql\, test\, data\aq.db)
  lecture-notes-ai\      Python worker
    notes_engine\        ingest, llm, prompts, notes_schema, pdf, templates\, static\fonts\
    backend\             Flask server (app\server.py), run.py, .env.example
    frontend\            the old standalone page (form + stepper + preview); still works on :5055
    tests\  docs\        pytest suites + fixtures; notes-schema.md
    start.ps1  pyproject.toml
  docs\                  this file, the dev notebook (PDF + JSON)
  backend\  frontend\    unrelated Express hello-world and React/Vite templates (not part of the system)
```

The three apps share no code; they share only an HTTP contract, so each can be replaced or deployed on its own.

---

## 4. File-by-file

### 4.1 `lecture-notes-ui/` (the UI)

Script order in `index.html` matters: each file is an IIFE that attaches to `window.AQ` and may use earlier ones.

| File | Role | Talks to |
|---|---|---|
| `index.html` | Page shell: top bar (logo, search, avatar placeholder), `#view` (screens render here), `#modal`, toasts, loads scripts in order | all `.js`, `styles.css` |
| `styles.css` | Design tokens + all components (black glass theme, chroma cards, rows, modal, notes split view, responsive) | - |
| `util.js` | `AQ.util`: `el()` DOM builder (always `textContent`), stroke icons, YouTube id parser (`parseYouTubeId`), thumbnail/watch URLs, duration parse/format, "time ago" | used by every file |
| `store.js` | `AQ.store`: playlist CRUD, sanitising, limits, persistence, **watch progress** (`watchSave`, `watchInfo`, `watchLabel`), time-based `progress()` / `overall()` | `localStorage` (`aq.playlists.v1`, `aq.watch.v1`); calls `AQ.api.record()` after every change |
| `api.js` | `AQ.api`: adapter for aq-api. Probes `/api/v1/health` (same origin, else :5180), imports local data once (`/sync/import`), pulls server data into the store, writes every later change through **in order**, debounces progress (2 s per video), sets `aq.dirty.v1` when offline and re-pushes later | `AQ.store` (`record`, `applyRemote`, `exportState`), aq-api |
| `dialog.js` | `AQ.dialog`: accessible modal host (focus trap, Esc, restore focus) and `confirm()` | `#modal` in `index.html` |
| `notes.js` | `AQ.notesJobs`: start / status / retry / urls / subscribe for notes jobs, max 2 running, polling, resume after reload (`aq.notes.v1`); `AQ.notes.mount` small panel | aq-api `/api/v1/notes/*` when `AQ.api.available()`, otherwise the Python worker on :5055 directly; `notebutton.js` |
| `notebutton.js` | `AQ.noteButton`: the Get notes button (none / progress fill with % / ready "View notes" / retry) | `AQ.notesJobs` |
| `notesview.js` | `AQ.notesView`: center notes panel: header, Download PDF, iframe of `notes.html` | `AQ.notesJobs`, `AQ.noteButton` |
| `player.js` | `AQ.player`: `youtube-nocookie` embed, YouTube IFrame API, prev/next through a queue, saves position every second, resume | YouTube, `AQ.store` |
| `split.js` | `AQ.split`: route `#/playlist/<id>/notes/<videoId>`; notes panel slides in, list shrinks to a nav (FLIP animation); Back/Esc closes | `AQ.notesView`, `AQ.notesJobs`, history |
| `importpl.js` | `AQ.importPlaylist`: "Import from YouTube" dialog (link -> preview -> new playlist with `source`) | aq-api `GET /api/v1/import/youtube` (else Python `GET /api/playlist`), `AQ.store.createWithVideos` |
| `water.js` | `AQ.water.button`: liquid-glass "New playlist" button (SVG displacement refraction, spring hover) | - |
| `clickspark.js` | `AQ.clickSpark`: click spark canvas effect everywhere (skips inputs, `[data-no-spark]`) | - |
| `app.js` | Hash router + rendering: playlists home (chroma cards, progress), playlist detail, add-video form, rows, drag and drop, toasts, card menu | store, dialog, split, player, importpl |
| `serve.ps1` | Serves the folder with `python -m http.server` on 127.0.0.1:5173 (dev only) | - |
| `README.md` | Screens, effects, data model, where things live | - |
| `screenshots/*.png` | Reference screenshots | - |
| `_landing-backup/*` | Old landing page (`index.html`, `styles.css`, `app.js`, `resources.js`) | - |

### 4.2 `lecture-notes-ai/` (the Python worker)

| File | Role | Talks to |
|---|---|---|
| `notes_engine/__init__.py` | `generate()` (URL -> notes + files), `render_notes()`, lazy re-exports, `ENV_KEYS`, global progress mapping | all engine modules |
| `notes_engine/__main__.py` | CLI `python -m notes_engine URL ...`: progress bar, secrets masked, exit codes 0-5 | `generate()` |
| `notes_engine/ingest.py` | Link validation (`parse_video_id`, SSRF guard), metadata, transcript fallback chain, cleaning, `chunk_transcript`, `get_playlist` / `parse_playlist_id` | YouTube, yt-dlp, ffmpeg, Groq Whisper |
| `notes_engine/llm.py` | Provider table `PROVIDERS`, `_Client`, pacer + retries, single pass vs map-reduce, JSON repair, key scrubbing | Gemini, Groq, xAI, Hugging Face, `prompts.py`, `notes_schema.py` |
| `notes_engine/prompts.py` | The rules and message builders: digest, compose single/batch, compose final, fix-JSON; `target_section_count` | `llm.py` |
| `notes_engine/notes_schema.py` | `validate_notes`: coerces any LLM JSON into the Notes contract (limits, aliases, derived fields) | `llm.py`, `pdf.py` |
| `notes_engine/pdf.py` | Diagram SVG layout (8 types), HTML build, `render_html`, `render_pdf` (headless browser) and `_pdf_ok` page check | `templates/`, fonts, PyMuPDF, Edge/Chrome |
| `notes_engine/templates/notebook.css` | Paper, rings, cards, print styles | `pdf.py` |
| `notes_engine/templates/notebook.js` | Browser-side pagination into A4 pages, rings, footer `pg. N / M`, Rough.js sketching | inlined by `pdf.py` |
| `notes_engine/templates/vendor/rough.js` | Rough.js (MIT) hand-drawn shapes | `notebook.js` |
| `notes_engine/static/fonts/*.ttf` + `OFL-*.txt` | Bundled fonts and licences; also served at `/static/fonts` | `pdf.py`, Flask |
| `backend/app/server.py` | Flask app factory `create_app()`: guards, headers, jobs, routes, 24 h cleanup | `notes_engine` |
| `backend/app/__init__.py` | package marker | - |
| `backend/run.py` | Starts Flask on `127.0.0.1:$LNA_PORT` (5055), `threaded=True` | `server.py` |
| `backend/.env.example` | Template for `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `HF_TOKEN`, `FFMPEG_PATH` | - |
| `frontend/index.html`, `app.js`, `styles.css` | Old standalone page: form (URL, provider, key), stepper, progress, preview iframe, downloads | `/api/*` on :5055 |
| `start.ps1` | One-click launcher: venv, `pip install -e ".[web]"` when `pyproject.toml` changed, opens the browser, runs `run.py` | - |
| `pyproject.toml` | Package metadata, dependencies, `web` and `dev` extras, pytest config | - |
| `tests/test_ingest.py` | URL parsing, caption cleaning, fallback chain, Whisper chunking, chunker (44 cases) | - |
| `tests/test_llm.py` | Retries, pacing, JSON repair, map-reduce, validation (79) | - |
| `tests/test_pdf.py` | HTML/diagram rendering, page-number check (17) | - |
| `tests/test_playlist.py` | Playlist id parsing, entries, limits (24) | - |
| `tests/test_api.py` | Flask routes, guards, jobs, headers (21) | - |
| `tests/sample_notes.json`, `sample_llm_output.json` | Fixtures | - |
| `docs/notes-schema.md`, `docs/images/` | The Notes JSON contract; README screenshots | - |

### 4.3 `aq-api/` (the Node application backend)

| File | Role | Talks to |
|---|---|---|
| `package.json` | ESM package, `engines.node >= 24`, only dependency is `express` ^5; scripts `start` (`node src/server.js`) and `test` (`node --test`) | - |
| `.gitignore` | ignores `node_modules`, `data/*` (the DB), logs, `.env` | - |
| `data/aq.db` (+ `.gitkeep`) | the SQLite database file (created on first start, WAL mode) | `src/db.js` |
| `sql/001_init.sql` | schema migration 1: users, videos, playlists, playlist_videos, watch_progress, notes_jobs (applied once, in file-name order) | `src/db.js` |
| `src/server.js` | entry point: loads config, builds the app, listens on `127.0.0.1:$PORT`, closes the DB on SIGINT/SIGTERM | `config.js`, `app.js` |
| `src/config.js` | `loadConfig()`: port, DB file, UI dir, Python URL/provider, rate limits, notes timings (all from env, with safe defaults) | env |
| `src/app.js` | `createApp(config, deps)`: wires middleware order, `/api/v1` router, font proxy, static UI, JSON error handler | everything below |
| `src/db.js` | `openDb` (pragmas, migrations in a transaction), `tx()` helper (`BEGIN IMMEDIATE`) | `node:sqlite` |
| `src/http.js` | `HttpError` plus `bad` / `notFound` / `conflict` helpers | all |
| `src/validate.js` | `LIMITS`, regexes (video id, slug, list id, job id), `text`, `name`, `description`, duration parse/format, `videoInput`, `source`, `nonNeg` | repo, routes |
| `src/repo.js` | all SQL: users, playlists, playlist videos (add, batch add, reorder, edit, remove), progress get/put (last-writer-wins by `updated`), `importState`, `userHasVideo`; every call is scoped by `userId` | SQLite |
| `src/notes-service.js` | notes records + cache by `video_id`: `status`, `list`, `start`, `file`; one live job per video, expiry detection, verification of finished jobs | `repo.js`, `pyclient.js`, SQLite |
| `src/pyclient.js` | thin client for the Python worker: fixed paths, timeouts, no redirects, 503 `py_offline` when unreachable; refuses non-loopback URLs unless `ALLOW_REMOTE_PY=1` | Python :5055 |
| `src/middleware/security.js` | security headers + CSP, host guard (DNS rebinding), CORS for local origins, in-memory per-IP rate limiter | all routes |
| `src/middleware/auth.js` | the **authentication seam**: `localAuth` sets `req.user = {id: 1, name: "local"}`; replace via `createApp(config, {authenticate})` for OAuth | routes |
| `src/routes/playlists.js` | playlists + videos CRUD | `repo.js` |
| `src/routes/progress.js` | watch progress get / put | `repo.js` |
| `src/routes/notes.js` | notes status/start and streaming of notes html/pdf; `/static/fonts` proxy for the notes page | `notes-service.js`, Python |
| `src/routes/misc.js` | `/health`, `/me`, YouTube playlist import proxy, `/sync/import` (bulk import of browser data) | `repo.js`, Python |
| `test/helpers.js`, `playlists.test.js`, `progress.test.js`, `notes.test.js`, `security.test.js` | `node --test` (32 cases): in-memory SQLite, fake Python via injected `fetchImpl`, `--test-concurrency=1` | `src/app.js` |

---

## 5. Data flows

### 5.1 Watch and resume

1. Opening a video calls `AQ.store.watchInfo(id)`; a saved position > 0 starts playback there and shows "Resumed at m:ss".
2. `player.js` loads the YouTube IFrame API once. A 1-second timer reads `currentTime` and calls `AQ.store.watchSave(id, {pos, dur})`.
3. `watchSave` marks `done` when the position reaches 95% of the duration or the player reports "ended". Replaying a finished video and stopping early flips it back to Resume.
4. On closing the dialog `AQ.store.notify()` re-renders cards and rows (progress bars, "Play / Resume 12:34 / Replay").
5. `learnDuration()` fills a missing duration from the real player.
6. Persistence: `localStorage` `aq.watch.v1` immediately; then `api.js` sends the same `{pos, dur, done, updated}` with `PUT /api/v1/progress/:videoId` (debounced to one write per video every 2 s, flushed when the tab is hidden); the server keeps the newest `updated` in `watch_progress` (last writer wins). `localStorage` stays as the offline cache.

### 5.2 Notes generation, end to end

```
UI (notebutton / notesJobs)        aq-api                         Python worker           outside
  POST /api/v1/notes/<videoId> -> membership check (video in one of the user's playlists)
                                   cache lookup notes_jobs by video_id
                                     hit  (done)  -> return ready + links
                                     live (running) -> return progress
                                     miss ------------> POST /api/jobs {url, provider} -> 202 {job_id}
                                   INSERT notes_jobs(status queued, job_id)
  poll GET /api/v1/notes/<videoId> (~1.5 s) -> refresh from GET /api/jobs/<job_id> -> thread:
                                                                             1 ingest  (0-25 %)  -> YouTube captions / yt-dlp / Whisper
                                                                             2 llm     (25-85 %) -> provider(s), single pass or map-reduce
                                                                             3 validate + render (85-100 %) -> notes.json/.html/.pdf
  <--- {state, pct, stage}   <---  UPDATE notes_jobs
  done: iframe /api/v1/notes/<videoId>/html, Download PDF (/pdf)   <--- streamed through Node from Python
```

- Short lectures: one LLM call. Long ones: map-reduce (digest each slice, compose sections in batches, write cover/glossary/recap).
- One live job (queued / running / done) per video across all users: the partial unique index `notes_one_live_job` plus an in-process lock.
- The server keeps at most 2 active jobs (429 otherwise) and 10 new jobs per 60 s; the UI queues extra videos client-side.
- Job ids live in Python memory; a Python restart makes them 404. Node then marks the record `expired` and a new job may be started.
- If the PDF step fails but notes were written, the job is `done` with a `warning`; HTML and JSON are still available.

### 5.3 Playlist import

1. `importpl.js` extracts `list=<id>` from the pasted link and requests `GET /api/playlist?url=...` (via Node, which proxies to Python).
2. Python `parse_playlist_id` re-validates (SSRF guard); yt-dlp lists entries (limit 200, private/deleted skipped and counted).
3. Response `{id, title, channel, count, videos[], truncated, skipped}`; `cleanResponse` re-validates every field in the browser.
4. The dialog previews title, count, total time and thumbnails; `uniqueName` proposes "Title (2)" when the name is taken.
5. `store.createWithVideos(name, desc, videos, source)` creates the playlist in one write with `source: {type:"youtube", listId, url, importedAt}`. Nothing syncs back to YouTube.

### 5.4 Progress calculation

`sumVideos()` in `store.js`; nothing stores a percentage.

```
per video   : state = done (ended or >= 95 %) | partial (pos >= 1 s) | new
playlist pct: round(100 * watchedSec / totalSec)          (a done video counts its full duration)
              never 100 % while some seconds are missing, never 0 % once anything was watched
              no known durations at all -> finished videos / total videos
overall()   : the same over every playlist, each unique video counted once
```

Example: videos of 10:00 (done), 20:00 (watched 5:00), 30:00 (new) give watched = 900 s of 3600 s = **25 %**, 1 of 3 done.

### 5.5 Sync between the UI and aq-api (`api.js`)

`store.js` stays synchronous and keeps `localStorage` as the offline cache; `api.js` mirrors it to the server.

1. Boot: probe `GET /api/v1/health` on the same origin, then on `http://127.0.0.1:5180` (works when the UI is served by `serve.ps1`).
2. `reconcile()`: `GET /api/v1/me`. If the user is not `bootstrapped` (first run) or `aq.dirty.v1` is set, push the local data with `POST /api/v1/sync/import` (`merge` on first run, `replace` after offline edits); otherwise pull `GET /playlists?include=videos` + `GET /progress`.
3. `store.applyRemote(playlists, progress)` adopts the server data (a newer local watch record still wins) and re-renders.
4. Every store change calls `AQ.api.record(name, args)`; writes are queued in order (`POST /playlists`, `PATCH`, `DELETE`, `PUT .../videos/order`, `PUT /progress/<id>`).
5. Server unreachable: set `aq.dirty.v1`; on `online` / tab visible `api.js` reconnects and pushes the whole local state. If the server refuses a write it re-pulls and takes the server's view.
6. When `AQ.api.available()` is true, the import dialog (and the notes jobs manager) use aq-api instead of calling the Python worker directly.

---

## 6. Storage and data model

### 6.1 Browser (`localStorage`)

| Key | Content | Owner |
|---|---|---|
| `aq.playlists.v1` | `[{id, name, description, created, updated, videos:[{id, title, channel, duration, added}], source?}]` | `store.js` |
| `aq.watch.v1` | `{videoId: {pos, dur, done, updated}}` (seconds; `updated` epoch ms) | `store.js` |
| `aq.notes.v1` | `{videoId: {jobId, state}}` so queued/running jobs resume polling after reload | `notes.js` |
| `aq.dirty.v1` | `"1"` while local edits are not yet sent to aq-api | `api.js` |
| `lna.key.<provider>`, `lna.provider` | API key (only if "Remember" is ticked) and last provider | old standalone page |

All data read from storage is sanitised (bad ids, duplicates, over-long text dropped). If storage is blocked the app keeps working in memory and shows a banner.

### 6.2 SQLite (`aq-api/data/aq.db`, `sql/001_init.sql`)

Opened with `PRAGMA foreign_keys=ON`, WAL journal. Timestamps are ISO-8601 UTC text, except `watch_progress.updated_ms` (epoch milliseconds, as the UI sends it).

| Table | Columns (key ones) | Notes |
|---|---|---|
| `users` | `id` PK, `external_id` UNIQUE (OAuth subject), `name`, `email`, `bootstrapped_at`, `created_at` | row 1 = built-in `local` user; `bootstrapped_at` is set once the browser's localStorage data was imported |
| `videos` | `id` PK (11 chars), `title`, `channel`, `duration_sec`, `created_at` | registry of every video seen; FK target for the tables below |
| `playlists` | `pk` PK, `user_id` FK, `slug`, `name`, `description`, `source_list_id`, `source_imported_at`, `created_at`, `updated_at` | `UNIQUE(user_id, slug)`; unique name per user, case-insensitive; `slug` is the `#/playlist/<slug>` id |
| `playlist_videos` | `playlist_pk` FK, `video_id` FK, `position`, `title`, `channel`, `duration_sec`, `added_at` | PK `(playlist_pk, video_id)`; per-entry title/channel/duration (users edit them per playlist); `position` contiguous 0..n-1 |
| `watch_progress` | `user_id`, `video_id`, `pos_sec`, `dur_sec`, `done`, `updated_ms` | PK `(user_id, video_id)`; an older `updated` never overwrites a newer one |
| `notes_jobs` | `id` PK, `video_id` FK, `job_id` (Python's 32-hex id), `status` queued/running/done/error/expired, `pct`, `stage`, `message`, `error`, `requested_by`, `created_at`, `updated_at`, `checked_at` | partial unique index `notes_one_live_job (video_id) WHERE status IN (queued, running, done)`: one live job per video across all users; error/expired rows stay as history |
| `schema_migrations` | `name` PK, `applied_at` | created by `db.js`; records which `sql/*.sql` ran |

Cache rule: a video's notes are generated once. `POST /notes/:videoId` returns the existing `done` or running record instead of starting a second job; only `error` or `expired` rows allow a new one.

### 6.3 Python worker

| Where | What | Lifetime |
|---|---|---|
| `State.jobs` (memory) | `{id, status queued/running/done/error, stage, pct, message, meta, links, warning, error}` | until restart (finished jobs pruned after 24 h) |
| `lecture-notes-ai/backend/output/<job_id>/` | `notes.json`, `notes.html`, `notes.pdf` | folders older than 24 h are deleted at startup |
| `backend/.env` | optional provider keys | local file, git-ignored |

The Notes JSON structure (meta, cover, sections of blocks + diagram + recall question, glossary, recap) is documented in `lecture-notes-ai/docs/notes-schema.md`.

---

## 7. API reference

### 7.1 Python worker - `http://127.0.0.1:5055`

| Method + path | Purpose |
|---|---|
| `GET /` , `/app.js`, `/styles.css` | the old standalone page |
| `GET /api/providers` | `{providers:[{id, label, default_model, key_hint, server_key}]}` (`server_key` is a boolean) |
| `POST /api/jobs` | JSON `{url, provider, api_key?, model?, groq_key?}` -> `202 {job_id}`; 400 invalid input, 429 busy / rate limited, 503 engine missing |
| `GET /api/jobs/<id>` | `{status queued/running/done/error, stage transcript/notes/pdf, pct, message, error?, meta?, links?, warning?}`; 404 after restart |
| `GET /api/jobs/<id>/notes.json` | structured notes |
| `GET /api/jobs/<id>/notes.pdf` | the PDF (download) |
| `GET /api/jobs/<id>/notes.html` | the notebook page (scripts allowed by SHA-256 hash; framable by local pages) |
| `GET /api/playlist?url=` | `{id, title, channel, count, videos[], truncated, skipped}` (max 200 videos) |
| `GET /static/fonts/*` | bundled fonts |

Limits: body 64 KB, URL 2048 chars, 2 active jobs, 10 new jobs / 60 s (separate bucket for playlist lookups), 2 concurrent playlist fetches.

### 7.2 aq-api - `http://127.0.0.1:5180`

All data routes live under **`/api/v1`**, run `authenticate` first and are scoped to `req.user.id`. Errors are always JSON `{error, code?}`; `code` is `py_offline` (worker not running, 503) or `not_in_playlist` (403). Body limit 256 KB (`/sync/import` 2 MB). Rate limits per client IP: 600 requests/min in general, 20/min for starting notes and YouTube imports (429 with `Retry-After`).

| Method + path | Purpose |
|---|---|
| `GET /api/v1/health[?deep=1]` | `{ok, service, version, uptimeSec, db, notesService?}` (no auth; `deep=1` also pings Python) |
| `GET /api/v1/me` | `{user: {id, name}, bootstrapped}` |
| `GET /api/v1/playlists[?include=videos]` | `{playlists: [...]}` |
| `POST /api/v1/playlists` | create `{name, description?, videos?, source?}` -> 201 |
| `GET /api/v1/playlists/:id` | `{playlist}` (`:id` = slug) |
| `PATCH /api/v1/playlists/:id` | rename / change description |
| `DELETE /api/v1/playlists/:id` | -> 204 |
| `POST /api/v1/playlists/:id/videos` | add one `{id, title, channel, duration, position?}` (201) or a batch `{videos: [...]}` |
| `PUT /api/v1/playlists/:id/videos/order` | `{order: [videoId, ...]}` reorder |
| `PATCH /api/v1/playlists/:id/videos/:videoId` | edit title / channel / duration |
| `DELETE /api/v1/playlists/:id/videos/:videoId` | remove -> 204 |
| `GET /api/v1/progress` | `{progress: {videoId: {pos, dur, done, updated}}}` |
| `GET /api/v1/progress/:videoId` | one entry, 404 when none |
| `PUT /api/v1/progress/:videoId` | `{pos, dur, done?, updated?}` upsert (stale writes ignored, `stale: true`) |
| `GET /api/v1/notes` | every queued / running / ready record (DB only) |
| `GET /api/v1/notes/:videoId` | `{state none/queued/running/ready/error, pct, stage, message, error, jobId}`; refreshes from Python (throttled) |
| `POST /api/v1/notes/:videoId` | start notes: 403 unless the video is in one of the user's playlists (`NOTES_REQUIRE_MEMBERSHIP`), 202 started, 200 already cached/running |
| `GET /api/v1/notes/:videoId/html` | the notebook page, streamed from Python (keeps Python's hash-based CSP) |
| `GET /api/v1/notes/:videoId/pdf` | the PDF, streamed from Python |
| `GET /api/v1/import/youtube?url=` | validates `list=<id>`, forwards only the canonical playlist URL to Python `/api/playlist` |
| `POST /api/v1/sync/import` | `{mode: merge/replace, playlists, progress}` one-time import of browser data; lenient, returns the full resulting state |
| `GET /static/fonts/:file` | fonts for the notes page, proxied from Python |
| `GET /` and static files | the UI (`../lecture-notes-ui`), web assets only (no dot-files, `_` folders, docs) |

Request pipeline: security headers -> host guard -> CORS -> access log (method, path, status, ms; no bodies) -> `/api/v1`: rate limit -> health -> `authenticate` -> me -> sync -> JSON parser -> playlists -> progress -> notes -> import -> 404. Python is called only through `pyclient.js` (fixed paths, 10 s timeout, 60 s for playlist import, redirects refused).

---

## 8. Security

| Layer | Control |
|---|---|
| Network | Python binds `127.0.0.1` only (`run.py`, never `0.0.0.0`); Node binds `127.0.0.1` (host not configurable) |
| Host | DNS-rebinding guard on both servers: only `localhost`, `127.0.0.1`, `[::1]` Host headers are answered |
| Origin / CORS | allow only local origins; POSTs (and Python's `/api/playlist`) from a non-local `Origin` get 403; `file://` pages (`Origin: null`) are rejected |
| Input | key and model regexes, 2048-char URL cap, body caps, 11-char video ids, slug / list-id / job-id regexes, text stripped of control characters |
| SSRF | only validated YouTube video/playlist ids reach the network; Node only requests fixed Python paths and refuses redirects; Python URL must be loopback unless `ALLOW_REMOTE_PY=1` |
| Secrets | provider keys live in server memory for one job, are never logged or returned, and are scrubbed from every error (`_redact`, `_scrub`); `.env` is git-ignored |
| Headers | CSP per route, `nosniff`, frame options, `no-referrer`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`; API responses `no-store` |
| Generated HTML | `notes.html` runs only its own two inline scripts (hash-allowlisted); everything else under `default-src 'none'`; text is HTML-escaped before rendering |
| UI | `textContent` only (no `innerHTML`), player URL built from a validated id on `youtube-nocookie.com` |
| Files | job ids must be 32 hex chars; resolved path must stay inside `output/` |
| Auth | **not built yet.** Node has an `authenticate` middleware seam (single built-in local user); OAuth plugs in there |

Known gaps: no login (single-user, localhost app); a key saved with "Remember" is plain text in `localStorage`; the Python server is Flask's development server.

## 9. Run and deploy

```powershell
# terminal 1 - AI worker (creates .venv, installs deps, opens the browser)
powershell -ExecutionPolicy Bypass -File D:\AQspace\lecture-notes-ai\start.ps1

# terminal 2 - app backend + UI
cd D:\AQspace\aq-api
npm start                       # http://127.0.0.1:5180/
```

1. Copy `lecture-notes-ai\backend\.env.example` to `backend\.env` and add at least one provider key (Groq or Gemini are free), or paste a key in the old standalone page. aq-api asks Python for the provider named by `PY_NOTES_PROVIDER` (default `groq`), so that key must be on the Python server.
2. Open **http://127.0.0.1:5180/**. Do not open `index.html` by double-click (a `file://` page sends `Origin: null`, which is rejected).
3. Optional: `LNA_PORT` (worker port), `LNAI_BROWSER` (Edge/Chrome path), `FFMPEG_PATH`, `LNA_OFFLINE=1` (skip the one live test), and the aq-api variables below.

Requirements: Python 3.10+, Node 24+, Microsoft Edge or Google Chrome (PDF only), ffmpeg (only for videos without captions).

aq-api environment variables (all optional): `PORT` (5180), `DB_FILE` (`aq-api/data/aq.db`), `UI_DIR` (`../lecture-notes-ui`), `PY_NOTES_URL` (`http://127.0.0.1:5055`), `PY_NOTES_PROVIDER` (`groq`), `ALLOW_REMOTE_PY=1`, `NOTES_REQUIRE_MEMBERSHIP=0`, `BODY_LIMIT`, `LOG=0`, `RATE_LIMIT_PER_MIN`, `RATE_LIMIT_HEAVY_PER_MIN`. The listen address is always `127.0.0.1`.

Tests: `cd lecture-notes-ai; python -m pytest` (185 cases, network mocked) and `cd aq-api; npm test` (32 cases, in-memory SQLite, fake Python).

Beyond a laptop: HTTPS reverse proxy in front of aq-api, real OAuth in the auth seam, a managed database if more than one instance, a production WSGI server and a persistent job queue for the worker, worker on a private network.

## 10. Limits and future scope

Limits today: YouTube only; private, age-restricted and live videos fail; caption-less videos need a Groq key and ffmpeg; PDFs need Edge or Chrome; very long lectures take minutes and hit free-tier rate limits; job state in Python is in memory; no login.

Roadmap, in order: **OAuth + user-scoped rows** (seam exists; the UI already syncs to aq-api write-through) -> **multi-device conflict handling** -> **persistent job queue and hosted deploy** -> **notes search, spaced repetition from the recall questions, more sources than YouTube**.
