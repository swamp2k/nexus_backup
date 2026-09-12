ALTER TABLE transfer_rules ADD COLUMN rtorrent_endpoint_id TEXT;
ALTER TABLE transfer_rules ADD COLUMN rtorrent_required INTEGER NOT NULL DEFAULT 0 CHECK (rtorrent_required IN (0,1));

ALTER TABLE transfer_objects ADD COLUMN readiness TEXT NOT NULL DEFAULT 'stability' CHECK (readiness IN ('stability','rtorrent_complete','rtorrent_incomplete'));
ALTER TABLE transfer_objects ADD COLUMN torrent_hash TEXT;
ALTER TABLE transfer_objects ADD COLUMN torrent_name TEXT;
ALTER TABLE transfer_objects ADD COLUMN torrent_root TEXT;

ALTER TABLE transfer_discovery_entries ADD COLUMN readiness TEXT NOT NULL DEFAULT 'stability' CHECK (readiness IN ('stability','rtorrent_complete','rtorrent_incomplete'));
ALTER TABLE transfer_discovery_entries ADD COLUMN torrent_hash TEXT;
ALTER TABLE transfer_discovery_entries ADD COLUMN torrent_name TEXT;
ALTER TABLE transfer_discovery_entries ADD COLUMN torrent_root TEXT;

CREATE INDEX idx_transfer_objects_readiness ON transfer_objects(rule_id, readiness, state, stable_since);

-- Structural rule changes reset their persisted object generations. Never allow
-- that reset to erase the provenance row while a managed cleanup job can still
-- delete the corresponding destination object.
CREATE TRIGGER protect_active_transfer_cleanup_provenance
BEFORE DELETE ON transfer_objects
WHEN OLD.cleanup_job_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM backup_jobs
    WHERE id = OLD.cleanup_job_id
      AND state IN ('queued','leased','preparing','running','finalizing')
  )
BEGIN
  SELECT RAISE(ABORT, 'transfer object has active cleanup job');
END;
