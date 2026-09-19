package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
)

type sourceScanArtifactRecord struct {
	RecordType     string `json:"record_type"`
	SchemaVersion  int    `json:"schema_version"`
	Path           string `json:"path"`
	ParentPath     string `json:"parent_path"`
	Name           string `json:"name"`
	SizeBytes      int64  `json:"size_bytes"`
	FileCount      int64  `json:"file_count"`
	DirectoryCount int64  `json:"directory_count"`
	ErrorCount     int64  `json:"error_count"`
}

func encodeSourceScanArtifact(dst io.Writer, result sourceScanResult) error {
	gz := gzip.NewWriter(dst)
	enc := json.NewEncoder(gz)
	for _, node := range result.Nodes {
		record := sourceScanArtifactRecord{
			RecordType:     "directory",
			SchemaVersion:  1,
			Path:           node.Path,
			ParentPath:     node.Parent,
			Name:           node.Name,
			SizeBytes:      node.Bytes,
			FileCount:      node.Files,
			DirectoryCount: node.Directories,
			ErrorCount:     node.ErrorCount,
		}
		if err := enc.Encode(record); err != nil {
			_ = gz.Close()
			return err
		}
	}
	return gz.Close()
}

func uploadSourceScanArtifact(ctx context.Context, client *apiClient, run workstationRun, result sourceScanResult) error {
	reader, writer := io.Pipe()
	go func() {
		err := encodeSourceScanArtifact(writer, result)
		writer.CloseWithError(err)
	}()
	if err := client.uploadSourceScanArtifact(ctx, run.ID, run.LeaseToken, reader); err != nil {
		_ = reader.CloseWithError(err)
		return fmt.Errorf("upload source scan artifact: %w", err)
	}
	return nil
}
