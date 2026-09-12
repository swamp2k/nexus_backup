CREATE TABLE IF NOT EXISTS backup_job_runtime_progress (
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL CHECK (tool IN ('restic', 'rclone')),
  updated_at TEXT NOT NULL,
  bytes_done INTEGER,
  bytes_total INTEGER,
  files_done INTEGER,
  files_total INTEGER,
  speed_bytes_per_second REAL,
  eta_seconds REAL,
  errors INTEGER,
  summary_json TEXT,
  PRIMARY KEY (job_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_backup_job_runtime_progress_updated
  ON backup_job_runtime_progress (updated_at);

CREATE TABLE IF NOT EXISTS backup_job_runtime_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  agent_id TEXT NOT NULL,
  at TEXT NOT NULL,
  tool TEXT NOT NULL CHECK (tool IN ('restic', 'rclone')),
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_job_runtime_logs_job
  ON backup_job_runtime_logs (job_id, attempt, at, seq);
