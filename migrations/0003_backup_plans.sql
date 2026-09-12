CREATE TABLE IF NOT EXISTS backup_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  retention_json TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_scheduled_at TEXT,
  last_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS backup_plans_due_idx
  ON backup_plans(enabled, next_run_at);
