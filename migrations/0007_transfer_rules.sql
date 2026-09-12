CREATE TABLE transfer_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source_endpoint_id TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  destination_endpoint_id TEXT NOT NULL,
  destination_path TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'copy' CHECK (mode IN ('copy','move')),
  initial_behavior TEXT NOT NULL DEFAULT 'ignore_existing' CHECK (initial_behavior IN ('ignore_existing','process_existing')),
  stability_seconds INTEGER NOT NULL DEFAULT 600 CHECK (stability_seconds >= 0),
  scan_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (scan_interval_seconds >= 15),
  cleanup_days INTEGER NOT NULL DEFAULT 14 CHECK (cleanup_days >= 0),
  verification TEXT NOT NULL DEFAULT 'size' CHECK (verification = 'size'),
  multi_thread_streams INTEGER NOT NULL DEFAULT 4 CHECK (multi_thread_streams >= 1 AND multi_thread_streams <= 32),
  multi_thread_cutoff TEXT NOT NULL DEFAULT '256M',
  retry_count INTEGER NOT NULL DEFAULT 3 CHECK (retry_count >= 0),
  retry_wait_seconds INTEGER NOT NULL DEFAULT 300 CHECK (retry_wait_seconds >= 0),
  rclone_args_json TEXT NOT NULL DEFAULT '[]',
  includes_json TEXT NOT NULL DEFAULT '[]',
  excludes_json TEXT NOT NULL DEFAULT '[]',
  initialized_at TEXT,
  next_scan_at TEXT,
  last_scan_started_at TEXT,
  last_scan_completed_at TEXT,
  last_scan_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_transfer_rules_due ON transfer_rules(enabled, next_scan_at);

CREATE TABLE transfer_objects (
  rule_id TEXT NOT NULL REFERENCES transfer_rules(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mod_time TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  stable_since TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('discovered','ignored','queued','retry_wait','done','failed','cancelled','superseded','cleaned')),
  last_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  committed_at TEXT,
  destination_rel_path TEXT,
  cleanup_after TEXT,
  last_error TEXT,
  PRIMARY KEY(rule_id, object_key)
);

CREATE INDEX idx_transfer_objects_rule_path ON transfer_objects(rule_id, rel_path, first_seen_at DESC);
CREATE INDEX idx_transfer_objects_ready ON transfer_objects(rule_id, state, stable_since, next_retry_at);
CREATE INDEX idx_transfer_objects_job ON transfer_objects(last_job_id);

CREATE TABLE transfer_discovery_entries (
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES transfer_rules(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mod_time TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY(job_id, object_key)
);

CREATE INDEX idx_transfer_discovery_rule_job ON transfer_discovery_entries(rule_id, job_id);
