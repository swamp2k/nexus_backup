-- Store workstation TreeSize/source-scan data as streamed artifacts instead of large JSON blobs in SQLite.
ALTER TABLE workstation_source_scans ADD COLUMN artifact_key TEXT;
ALTER TABLE workstation_source_scans ADD COLUMN artifact_format TEXT;
ALTER TABLE workstation_source_scans ADD COLUMN schema_version INTEGER;
ALTER TABLE workstation_source_scans ADD COLUMN directory_count INTEGER;
ALTER TABLE workstation_source_scans ADD COLUMN file_count INTEGER;
ALTER TABLE workstation_source_scans ADD COLUMN total_bytes INTEGER;
ALTER TABLE workstation_source_scans ADD COLUMN error_count INTEGER;
