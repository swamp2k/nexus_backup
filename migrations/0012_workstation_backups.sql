CREATE TABLE workstation_policies (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source_paths_json TEXT NOT NULL DEFAULT '[]',
  exclude_patterns_json TEXT NOT NULL DEFAULT '[]',
  schedule_json TEXT NOT NULL DEFAULT '{"kind":"daily","time":"02:00"}',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  retention_json TEXT NOT NULL DEFAULT '{"keepDaily":7,"keepWeekly":4,"keepMonthly":12}',
  next_run_at TEXT,
  last_scheduled_at TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workstation_runs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','running','completed','partial','failed','cancelled')),
  lease_token TEXT,
  lease_expires_at TEXT,
  scheduled_for TEXT,
  source_paths_json TEXT NOT NULL,
  exclude_patterns_json TEXT NOT NULL DEFAULT '[]',
  retention_json TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  leased_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  progress_json TEXT,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_workstation_runs_device_state ON workstation_runs(device_id,state,queued_at);
CREATE INDEX idx_workstation_runs_lease ON workstation_runs(state,lease_expires_at);
CREATE UNIQUE INDEX idx_workstation_runs_one_active_per_device
  ON workstation_runs(device_id)
  WHERE state IN ('queued','leased','running');
CREATE INDEX idx_workstation_policies_due ON workstation_policies(enabled,next_run_at);

CREATE TABLE workstation_status (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  repository_configured INTEGER NOT NULL DEFAULT 0 CHECK (repository_configured IN (0,1)),
  repository_kind TEXT CHECK (
    repository_kind IS NULL OR (
      length(repository_kind) BETWEEN 1 AND 32
      AND repository_kind NOT GLOB '*[^A-Za-z0-9._-]*'
    )
  ),
  agent_state TEXT,
  current_run_id TEXT,
  last_backup_at TEXT,
  last_success_at TEXT,
  last_snapshot_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
