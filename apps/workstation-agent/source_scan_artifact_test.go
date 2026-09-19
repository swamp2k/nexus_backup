package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"testing"
)

func TestEncodeSourceScanArtifactUsesPCWatchDirectoryRecordContract(t *testing.T) {
	result := sourceScanResult{
		Nodes: []sourceScanNode{
			{Path: `C:\\`, Parent: "", Name: `C:\\`, Bytes: 123, Files: 4, Directories: 1},
			{Path: `C:\\Users`, Parent: `C:\\`, Name: "Users", Bytes: 100, Files: 3, Directories: 0, ErrorCount: 2},
		},
	}
	var compressed bytes.Buffer
	if err := encodeSourceScanArtifact(&compressed, result); err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(compressed.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()

	scanner := bufio.NewScanner(gz)
	var records []sourceScanArtifactRecord
	for scanner.Scan() {
		var record sourceScanArtifactRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("records=%d want 2", len(records))
	}
	if records[0].RecordType != "directory" || records[0].SchemaVersion != 1 {
		t.Fatalf("unexpected artifact record header: %+v", records[0])
	}
	if records[1].ParentPath != `C:\\` || records[1].SizeBytes != 100 || records[1].FileCount != 3 || records[1].ErrorCount != 2 {
		t.Fatalf("unexpected child record: %+v", records[1])
	}
}
