ALTER TABLE backup_plans
  ADD COLUMN last_maintenance_source_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL;
ALTER TABLE backup_plans
  ADD COLUMN last_maintenance_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS backup_plans_maintenance_idx
  ON backup_plans(last_job_id, last_maintenance_source_job_id);
