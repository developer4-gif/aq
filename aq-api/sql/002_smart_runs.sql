-- Smart playlist runs (smart arrangement + topics to cover). The Python service does the AI work; this table stores each run
-- and, once the worker reports it done, its result, so it survives worker restarts and page reloads. Applied by src/db.js.
-- Same shape as notes_jobs (status / pct / stage / message / error / checked_at); the result is stored as JSON text.

CREATE TABLE smart_runs (
  id            INTEGER PRIMARY KEY,
  playlist_pk   INTEGER NOT NULL REFERENCES playlists(pk) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,               -- sha256 of the goal (playlist name) + the sorted video ids at start time
  job_id        TEXT,                        -- the Python service's job id (32 hex chars)
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  pct           INTEGER NOT NULL DEFAULT 0,
  stage         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  result_json   TEXT,                        -- the worker's Result (only when status = 'done')
  usage_json    TEXT,                        -- the worker's Usage
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL DEFAULT 0   -- epoch ms of the last contact with the Python service
);
-- At most one queued/running/done run per playlist and fingerprint (a repeated request returns it); error runs stay as history.
CREATE UNIQUE INDEX smart_one_live_run ON smart_runs (playlist_pk, fingerprint) WHERE status IN ('queued','running','done');
CREATE INDEX smart_playlist ON smart_runs (playlist_pk, id);
