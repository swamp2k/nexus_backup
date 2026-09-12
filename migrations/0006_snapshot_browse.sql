CREATE TABLE IF NOT EXISTS repository_snapshot_browse (
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  browse_path TEXT NOT NULL,
  job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  entry_limit INTEGER NOT NULL,
  returned_entries INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  PRIMARY KEY (repository_id, snapshot_id, browse_path),
  FOREIGN KEY (repository_id, snapshot_id)
    REFERENCES repository_snapshots(repository_id, snapshot_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS repository_snapshot_browse_scan_idx
  ON repository_snapshot_browse(repository_id, snapshot_id, scanned_at DESC);
