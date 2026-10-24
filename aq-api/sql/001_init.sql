-- AQ Learning application database (SQLite via node:sqlite). Applied once, in file-name order, by src/db.js.
-- Timestamps: ISO-8601 UTC text, except watch_progress.updated_ms (epoch milliseconds, as the UI sends it).

CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  external_id      TEXT UNIQUE,              -- subject/id from the OAuth provider (NULL for the built-in local user)
  name             TEXT NOT NULL,
  email            TEXT,
  bootstrapped_at  TEXT,                     -- set once the browser's old localStorage data was imported
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO users (id, name) VALUES (1, 'local');

-- Registry of every YouTube video the app has seen (FK target for playlists, progress and notes).
CREATE TABLE videos (
  id            TEXT PRIMARY KEY CHECK (length(id) = 11),
  title         TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE playlists (
  pk                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                TEXT NOT NULL,         -- the public playlist id used in URLs (#/playlist/<slug>)
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  source_list_id      TEXT,                  -- YouTube playlist id when imported
  source_imported_at  TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (user_id, slug)
);
CREATE UNIQUE INDEX playlists_user_name ON playlists (user_id, name COLLATE NOCASE);

-- A video inside a playlist. title/channel/duration are per-entry (the UI lets users edit them per playlist).
CREATE TABLE playlist_videos (
  playlist_pk   INTEGER NOT NULL REFERENCES playlists(pk) ON DELETE CASCADE,
  video_id      TEXT NOT NULL REFERENCES videos(id),
  position      INTEGER NOT NULL,            -- 0..n-1, contiguous
  title         TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (playlist_pk, video_id)
) WITHOUT ROWID;
CREATE INDEX playlist_videos_order ON playlist_videos (playlist_pk, position);
CREATE INDEX playlist_videos_video ON playlist_videos (video_id);

CREATE TABLE watch_progress (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL REFERENCES videos(id),
  pos_sec     REAL NOT NULL DEFAULT 0,
  dur_sec     REAL NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
) WITHOUT ROWID;

-- Notes generation records. The Python service does the work; this table is the cache/index.
-- "One job per video across users": the partial unique index allows only one queued/running/done row per video.
-- error / expired rows stay as history and let a new job be started.
CREATE TABLE notes_jobs (
  id            INTEGER PRIMARY KEY,
  video_id      TEXT NOT NULL REFERENCES videos(id),
  job_id        TEXT,                        -- the Python service's job id (32 hex chars)
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','error','expired')),
  pct           INTEGER NOT NULL DEFAULT 0,
  stage         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL DEFAULT 0   -- epoch ms of the last contact with the Python service
);
CREATE UNIQUE INDEX notes_one_live_job ON notes_jobs (video_id) WHERE status IN ('queued','running','done');
CREATE INDEX notes_video ON notes_jobs (video_id, id);
