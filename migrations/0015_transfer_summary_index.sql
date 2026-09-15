-- The Transfers dashboard groups all tracked objects by rule/state and sums size.
-- Keep that read index-only so opening/polling Transfers does not force SQLite to
-- visit every transfer_objects table row through the synchronous DatabaseSync API.
CREATE INDEX idx_transfer_objects_summary
  ON transfer_objects(rule_id, state, size);

ANALYZE transfer_objects;
