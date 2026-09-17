-- Flat-file product model. Legacy Restic tables/configuration remain readable
-- during upgrade, but new product records use ordinary directories under /backup.
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repositories_name ON repositories(name COLLATE NOCASE);

ALTER TABLE workstation_policies ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE workstation_policies ADD COLUMN destination_folder TEXT;
ALTER TABLE transfer_rules ADD COLUMN destination_repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS receiver_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  bootstrap_password TEXT,
  bootstrap_expires_at TEXT,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  relative_subpath TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'workstation')),
  workstation_id TEXT REFERENCES managed_devices(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receiver_users_repository ON receiver_users(repository_id, enabled);
CREATE INDEX IF NOT EXISTS idx_receiver_users_workstation ON receiver_users(workstation_id);

CREATE TABLE IF NOT EXISTS application_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
