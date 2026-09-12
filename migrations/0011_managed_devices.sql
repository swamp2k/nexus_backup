CREATE TABLE managed_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pcwatch',
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  version TEXT,
  hostname TEXT,
  platform TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  remotes_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_managed_devices_seen ON managed_devices(enabled, last_seen_at DESC);
