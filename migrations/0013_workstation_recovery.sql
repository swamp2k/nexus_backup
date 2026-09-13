ALTER TABLE workstation_runs ADD COLUMN operation TEXT NOT NULL DEFAULT 'backup'
  CHECK (operation IN ('backup','inventory','browse','restore-preview','restore'));

ALTER TABLE workstation_runs ADD COLUMN request_json TEXT;

CREATE INDEX idx_workstation_runs_device_operation
  ON workstation_runs(device_id, operation, state, queued_at);

CREATE TABLE workstation_snapshot_inventory (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  snapshots_json TEXT NOT NULL
);

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

CREATE INDEX idx_workstation_snapshot_browse_scan
  ON workstation_snapshot_browse(device_id, scanned_at DESC);
