ALTER TABLE transfer_rules ADD COLUMN rtorrent_gate_id TEXT;
CREATE INDEX idx_transfer_rules_rtorrent_gate ON transfer_rules(rtorrent_gate_id);
