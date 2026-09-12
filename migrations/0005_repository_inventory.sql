CREATE TABLE IF NOT EXISTS repository_inventory (
  repository_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  snapshot_limit INTEGER NOT NULL,
  returned_snapshots INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
);

CREATE TABLE IF NOT EXISTS repository_snapshots (
  repository_id TEXT NOT NULL REFERENCES repository_inventory(repository_id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  short_id TEXT,
  snapshot_time TEXT NOT NULL,
  parent_id TEXT,
  hostname TEXT,
  username TEXT,
  paths_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  program_version TEXT,
  total_files_processed INTEGER,
  total_bytes_processed REAL,
  data_added REAL,
  data_added_packed REAL,
  PRIMARY KEY (repository_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS repository_snapshots_time_idx
  ON repository_snapshots(repository_id, snapshot_time DESC);
