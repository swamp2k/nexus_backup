CREATE TABLE IF NOT EXISTS backup_jobs (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'leased', 'preparing', 'running', 'finalizing',
    'completed', 'partial', 'failed', 'cancelled', 'interrupted'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  payload_json TEXT NOT NULL,
  lease_agent_id TEXT,
  lease_token TEXT,
  lease_acquired_at TEXT,
  lease_expires_at TEXT,
  lease_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  last_mutation_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_claim
  ON backup_jobs (state, lease_expires_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_expired_lease
  ON backup_jobs (lease_expires_at, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_jobs_mutation
  ON backup_jobs (last_mutation_id);

CREATE TABLE IF NOT EXISTS backup_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_job_events_job
  ON backup_job_events (job_id, at, id);

CREATE TABLE IF NOT EXISTS backup_agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  version TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_agents_token_hash
  ON backup_agents (token_hash, enabled);
