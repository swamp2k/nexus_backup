CREATE TABLE workstation_install_tickets (
  ticket_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workstation_install_tickets_device
  ON workstation_install_tickets(device_id, created_at DESC);
CREATE INDEX idx_workstation_install_tickets_expiry
  ON workstation_install_tickets(expires_at, consumed_at);
