-- Materialize Transfers dashboard counters so page loads never aggregate the full
-- transfer_objects history. The one-time backfill uses the covering index added in
-- 0015; all subsequent changes are maintained transactionally by triggers.

CREATE TABLE transfer_object_summary (
  rule_id TEXT NOT NULL REFERENCES transfer_rules(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (rule_id, state)
);

INSERT INTO transfer_object_summary(rule_id, state, object_count, bytes)
SELECT rule_id, state, COUNT(*), COALESCE(SUM(size), 0)
FROM transfer_objects
GROUP BY rule_id, state;

CREATE TRIGGER transfer_object_summary_insert
AFTER INSERT ON transfer_objects
BEGIN
  INSERT INTO transfer_object_summary(rule_id, state, object_count, bytes)
  VALUES(NEW.rule_id, NEW.state, 1, NEW.size)
  ON CONFLICT(rule_id, state) DO UPDATE SET
    object_count = object_count + 1,
    bytes = bytes + excluded.bytes;
END;

CREATE TRIGGER transfer_object_summary_delete
AFTER DELETE ON transfer_objects
BEGIN
  UPDATE transfer_object_summary
  SET object_count = object_count - 1,
      bytes = bytes - OLD.size
  WHERE rule_id = OLD.rule_id AND state = OLD.state;

  DELETE FROM transfer_object_summary
  WHERE rule_id = OLD.rule_id AND state = OLD.state AND object_count = 0;
END;

CREATE TRIGGER transfer_object_summary_update
AFTER UPDATE OF rule_id, state, size ON transfer_objects
WHEN OLD.rule_id <> NEW.rule_id OR OLD.state <> NEW.state OR OLD.size <> NEW.size
BEGIN
  UPDATE transfer_object_summary
  SET object_count = object_count - 1,
      bytes = bytes - OLD.size
  WHERE rule_id = OLD.rule_id AND state = OLD.state;

  DELETE FROM transfer_object_summary
  WHERE rule_id = OLD.rule_id AND state = OLD.state AND object_count = 0;

  INSERT INTO transfer_object_summary(rule_id, state, object_count, bytes)
  VALUES(NEW.rule_id, NEW.state, 1, NEW.size)
  ON CONFLICT(rule_id, state) DO UPDATE SET
    object_count = object_count + 1,
    bytes = bytes + excluded.bytes;
END;
