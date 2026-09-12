ALTER TABLE transfer_objects ADD COLUMN cleanup_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL;
ALTER TABLE transfer_objects ADD COLUMN cleanup_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transfer_objects ADD COLUMN next_cleanup_retry_at TEXT;

CREATE INDEX idx_transfer_objects_cleanup_due
  ON transfer_objects(state, cleanup_after, next_cleanup_retry_at, cleanup_job_id);
