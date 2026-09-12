ALTER TABLE transfer_objects ADD COLUMN group_kind TEXT;
ALTER TABLE transfer_objects ADD COLUMN group_key TEXT;
ALTER TABLE transfer_objects ADD COLUMN group_name TEXT;
ALTER TABLE transfer_objects ADD COLUMN group_root TEXT;

CREATE INDEX idx_transfer_objects_group
  ON transfer_objects(rule_id, group_kind, group_key, state, last_seen_at);
