-- SQLite cannot alter the CHECK constraint on workstation_runs.operation in place.
-- Preserve recovery cache rows explicitly while rebuilding the parent table so
-- foreign_keys may remain enabled for the entire atomic migration.

CREATE TABLE workstation_snapshot_inventory_0014 AS
  SELECT device_id,source_run_id,scanned_at,snapshots_json
  FROM workstation_snapshot_inventory;

CREATE TABLE workstation_snapshot_browse_0014 AS
  SELECT device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated
  FROM workstation_snapshot_browse;

DROP TABLE workstation_snapshot_browse;
DROP TABLE workstation_snapshot_inventory;

CREATE TABLE workstation_runs_0014 (
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
  updated_at TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'backup'
    CHECK (operation IN ('backup','check','inventory','browse','restore-preview','restore')),
  request_json TEXT
);

INSERT INTO workstation_runs_0014 (
  id,device_id,operation_key,state,lease_token,lease_expires_at,scheduled_for,
  source_paths_json,exclude_patterns_json,retention_json,queued_at,leased_at,
  started_at,finished_at,progress_json,result_json,error_message,created_at,updated_at,
  operation,request_json
)
SELECT
  id,device_id,operation_key,state,lease_token,lease_expires_at,scheduled_for,
  source_paths_json,exclude_patterns_json,retention_json,queued_at,leased_at,
  started_at,finished_at,progress_json,result_json,error_message,created_at,updated_at,
  operation,request_json
FROM workstation_runs;

DROP TABLE workstation_runs;
ALTER TABLE workstation_runs_0014 RENAME TO workstation_runs;

CREATE INDEX idx_workstation_runs_device_state ON workstation_runs(device_id,state,queued_at);
CREATE INDEX idx_workstation_runs_lease ON workstation_runs(state,lease_expires_at);
CREATE UNIQUE INDEX idx_workstation_runs_one_active_per_device
  ON workstation_runs(device_id)
  WHERE state IN ('queued','leased','running');
CREATE INDEX idx_workstation_runs_device_operation
  ON workstation_runs(device_id, operation, state, queued_at);

CREATE TABLE workstation_snapshot_inventory (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  snapshots_json TEXT NOT NULL
);

INSERT INTO workstation_snapshot_inventory(device_id,source_run_id,scanned_at,snapshots_json)
SELECT device_id,source_run_id,scanned_at,snapshots_json
FROM workstation_snapshot_inventory_0014;

CREATE TABLE workstation_snapshot_browse (
  device_id TEXT NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  browse_path TEXT NOT NULL,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  entry_limit INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY(device_id, snapshot_id, browse_path)
);

INSERT INTO workstation_snapshot_browse(
  device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated
)
SELECT device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated
FROM workstation_snapshot_browse_0014;

CREATE INDEX idx_workstation_snapshot_browse_scan
  ON workstation_snapshot_browse(device_id, scanned_at DESC);

DROP TABLE workstation_snapshot_browse_0014;
DROP TABLE workstation_snapshot_inventory_0014;
