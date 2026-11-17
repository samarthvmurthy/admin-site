-- Jobs module: the run queue for the Dell runner, its heartbeat, and a
-- read-only mirror of the career-ops files the runner syncs up.
--
-- Apply with:
--   npx wrangler d1 migrations apply admin-jobs --remote

-- One row per thing the site asked the runner to do.
CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  action           TEXT NOT NULL,
  params           TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled
  source           TEXT NOT NULL DEFAULT 'ui',      -- ui | cron
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  heartbeat_at     TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  log              TEXT NOT NULL DEFAULT '',
  result           TEXT,
  error            TEXT,
  exit_code        INTEGER
);
CREATE INDEX runs_status_created ON runs (status, created_at);
CREATE INDEX runs_created ON runs (created_at);

-- Single row: when the runner last checked in, and what it reported.
CREATE TABLE runner (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen TEXT,
  info      TEXT
);

-- Mirrored text documents: 'tracker', 'pipeline', 'meta', 'report:<file>'.
CREATE TABLE docs (
  key        TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Mirrored PDFs from career-ops' output/ folder.
CREATE TABLE pdfs (
  name       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
