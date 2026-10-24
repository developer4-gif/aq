# aq-api - AQ Learning application backend

Node.js (Express 5 + the built-in `node:sqlite`) service that owns the application data: users, playlists, videos, watch
progress and notes records. The Python service (`D:\AQspace\lecture-notes-ai`) stays the **AI/media worker only**; this API
proxies to it and caches its results by video id. It also serves the UI (`D:\AQspace\lecture-notes-ui`) so one origin
(`http://127.0.0.1:5180/`) serves UI and API.

```
browser (UI, localStorage = offline cache)
   |  same origin
aq-api  :5180   users / playlists / videos / progress / notes records     data/aq.db (SQLite)
   |  server-to-server, loopback only
notes service (Python / Flask) :5055   transcribe + generate notes (jobs live in its memory)
```

Not related to `D:\AQspace\backend` / `frontend` (the separate OAuth app) - see "Plugging in OAuth" below.

## Run

Needs Node 24+ (uses `node:sqlite`, `fetch`). Only dependency: `express`.

```
cd D:\AQspace\aq-api
npm install
npm start            # http://127.0.0.1:5180/   (UI + API)
npm test             # node:test, no network needed (a mock Python service is started by the tests)
```

For "Get notes" start the Python service too (`D:\AQspace\lecture-notes-ai\start.ps1`, port 5055). Without it everything else works
and notes calls answer `503 {"code":"py_offline"}`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `5180` | listen port (the host is always `127.0.0.1`) |
| `DB_FILE` | `aq-api/data/aq.db` | SQLite file (created, migrated on start; `:memory:` works for experiments) |
| `UI_DIR` | `../lecture-notes-ui` | folder served statically |
| `PY_NOTES_URL` | `http://127.0.0.1:5055` | the Python notes service. Must be loopback unless `ALLOW_REMOTE_PY=1` |
| `PY_NOTES_PROVIDER` | `groq` | provider name sent to Python when starting a job |
| `NOTES_REQUIRE_MEMBERSHIP` | `1` | `0` lets any user start notes for any video id (default: only videos in their own playlists) |
| `RATE_LIMIT_PER_MIN` | `600` | requests per IP per minute for `/api/v1` |
| `RATE_LIMIT_HEAVY_PER_MIN` | `20` | starting notes + YouTube imports per IP per minute |
| `BODY_LIMIT` | `256kb` | JSON body limit (`/sync/import` allows 2mb) |
| `LOG` | `1` | `0` silences the request log (method, path, status, time - never query strings, headers or bodies) |

## Endpoints (`/api/v1`)

All JSON. Errors: `{"error": "message"}` with 400 (validation), 403 (origin / permission), 404, 409 (conflict, e.g. duplicate name or video),
413, 422 (Python refused the job), 429 (rate limit or Python busy, with `Retry-After`), 502/503 (Python problems).
Everything except `health` runs through `authenticate` and is scoped to `req.user`.

| Method + path | Purpose |
|---|---|
| `GET /health` (`?deep=1` also pings Python) | liveness: `{ok, service, version, db, notesService?}` (no auth) |
| `GET /me` | `{user, bootstrapped}` (`bootstrapped` = localStorage data was imported once) |
| `GET /playlists` (`?include=videos`) | the user's playlists with `videoCount`, `durationSec` |
| `POST /playlists` | `{name, description?, id?, videos?, source?}` -> 201 `{playlist, added, skipped}`; 409 on a duplicate name (case-insensitive) |
| `GET /playlists/:id` | playlist with ordered `videos` |
| `PATCH /playlists/:id` | `{name?, description?}` |
| `DELETE /playlists/:id` | 204 |
| `POST /playlists/:id/videos` | one video `{id, title?, channel?, duration?, position?}` -> 201 `{video}` (409 if present), or a batch `{videos:[...]}` -> `{added, skipped, playlist}` (max 500; invalid/duplicate entries are skipped and counted) |
| `PUT /playlists/:id/videos/order` | `{order:[videoId,...]}` - every video of the playlist exactly once, in the new order |
| `PATCH /playlists/:id/videos/:videoId` | `{title?, channel?, duration?, position?}` (edit and/or move) |
| `DELETE /playlists/:id/videos/:videoId` | 204, positions are compacted |
| `GET /progress` | `{progress: {videoId: {pos, dur, done, updated}}}` (same shape as the UI's `aq.watch.v1`) |
| `GET /progress/:videoId` / `PUT /progress/:videoId` | `PUT {pos, dur, done, updated?}`; an `updated` older than the stored one is ignored (`stale: true`) |
| `GET /notes` | every record that is queued / running / ready (database only) |
| `GET /notes/:videoId` | `{state: none\|queued\|running\|ready\|error, pct, stage, message, error, jobId}` (refreshes from Python) |
| `POST /notes/:videoId` | start notes. **Cache:** ready -> 200 immediately (`cached:true`); already running -> 200 with its progress; otherwise starts one Python job -> 202. One live job per video across all users |
| `GET /notes/:videoId/html`, `/pdf` | streams the finished file from Python (404 when not ready or expired) |
| `GET /import/youtube?url=` | proxies Python `/api/playlist` (only the validated `list=` id is forwarded, as a canonical URL) |
| `POST /sync/import` | `{mode: "merge"\|"replace", playlists, progress}`: one-time import of the browser's localStorage, also used to push offline edits. Lenient (bad entries dropped); returns the full resulting state |

Also: `GET /static/fonts/:file` (not under `/api`) streams the fonts the generated notes page references from Python.

Notes records expire when Python forgets a job (restart): a definitive 404 from Python marks the record `expired`
(status becomes `none`) and a new `POST` starts a fresh job. Network errors never expire anything.

### Validation limits

Video id `[A-Za-z0-9_-]{11}`; playlist id (slug) `[a-z0-9][a-z0-9-]{0,47}` (generated from the name, kept stable on rename); name 1-60,
description 0-160, title 150, channel 80 (long titles are truncated, long names are rejected); durations `m:ss` / `h:mm:ss` or seconds, < 100 h.

## Schema (`sql/001_init.sql`, applied by `src/db.js`, tracked in `schema_migrations`)

| Table | Columns / notes |
|---|---|
| `users` | `id`, `external_id` (UNIQUE, the OAuth subject), `name`, `email`, `bootstrapped_at`, `created_at`. Row 1 = `local` |
| `videos` | `id` (11 chars), `title`, `channel`, `duration_sec` - registry that playlists, progress and notes point to |
| `playlists` | `pk`, `user_id`, `slug` (public id, UNIQUE per user), `name` (UNIQUE per user, NOCASE), `description`, `source_list_id`, `source_imported_at`, `created_at`, `updated_at` |
| `playlist_videos` | PK `(playlist_pk, video_id)`, `position` (0..n-1), per-entry `title`, `channel`, `duration_sec`, `added_at` (cascade on playlist delete) |
| `watch_progress` | PK `(user_id, video_id)`, `pos_sec`, `dur_sec`, `done`, `updated_ms` |
| `notes_jobs` | `video_id`, `job_id` (Python), `status` queued/running/done/error/expired, `pct`, `stage`, `message`, `error`, `requested_by`, `checked_at`. Partial UNIQUE index on `video_id` where status in (queued, running, done) = one live job per video |

All SQL is parameterized (`?`); there is no string-built SQL with user input. New migrations: add `sql/002_*.sql`.

## Security notes

- Binds `127.0.0.1` only; `Host` must be `localhost` / `127.0.0.1` / `[::1]` (DNS-rebinding guard).
- CORS: only `http://localhost|127.0.0.1[:port]` origins; a non-local `Origin` on POST/PUT/PATCH/DELETE is rejected (403). Bodies must be `application/json` (forms are not parsed).
- Headers written by hand (`src/middleware/security.js`): nosniff, frame options, referrer policy, CORP/COOP, permissions policy, CSP (strict for the API; the UI gets a CSP that allows only itself, Google Fonts, YouTube embeds/thumbnails/oEmbed), `Cache-Control: no-store` on `/api`.
- In-memory per-IP rate limit (general + a stricter one for notes start / imports); JSON body limits; errors never include stack traces.
- Static serving only for web asset extensions, never dot-files, `_landing-backup`, `*.ps1` or docs.
- Python is called only on fixed paths with validated ids; `PY_NOTES_URL` must be loopback; redirects from Python are refused.
- Logs contain method, path, status, time only.

## Plugging in OAuth later

Every `/api/v1` route (except `health`) runs one middleware, `authenticate(req, res, next)` (`src/middleware/auth.js`), and then only uses
`req.user.id`. Today it is `localAuth` (always user 1, `local`). To use the OAuth app (`D:\AQspace\backend`):

1. Write an authenticator, e.g. verify the session cookie / `Authorization: Bearer` token the OAuth app issued (shared secret or JWKS), read `sub`, `name`, `email`.
2. Map it to a row: `const id = repo.upsertExternalUser(sub, name, email)` (uses `users.external_id`; `app.locals.repo` exposes the repo).
3. `req.user = { id, name }; next()` - or `next(new HttpError(401, "Sign in required."))`.
4. Pass it in: `createApp(config, { authenticate: myAuth })` in `src/server.js`.

Nothing else changes: every query is already filtered by `user_id`, and notes records are shared on purpose (one job per video).
Because the session will be cookie-based, keep the `Origin` check in `cors` (it is the CSRF defence) and add `SameSite=Lax; HttpOnly` on the cookie.
The built-in local user can be migrated by setting `external_id` on row 1 to the owner's OAuth subject.

## UI integration (`lecture-notes-ui`)

- `api.js` (new) detects the API (same origin, else `http://127.0.0.1:5180`), loads playlists and progress on start, imports the old localStorage data once (`/sync/import`, decided by `bootstrapped`), and writes every change through in order. If a write cannot be sent it sets `aq.dirty.v1` and the whole local state is pushed on the next successful connection.
- `store.js` calls `AQ.api.record(...)` after each mutation; localStorage stays the offline cache / fallback, and every store function is still synchronous.
- `notes.js` uses `/api/v1/notes/*` when the API is available (server-side cache, one job per video), else talks to `:5055` directly. `importpl.js` uses `/api/v1/import/youtube` in the same way.

Conflict policy: the server wins on start when nothing is pending; local wins when there are unsent (offline) edits.
