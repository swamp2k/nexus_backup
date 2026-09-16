package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSourceScanNodeJSONUsesBrowserContractFieldNames(t *testing.T) {
	node := sourceScanNode{
		Path:         `C:\\Users`,
		Parent:       `C:\\`,
		Name:         "Users",
		Bytes:        123,
		Files:        4,
		Directories:  5,
		Inaccessible: true,
	}
	payload, err := json.Marshal(node)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, key := range []string{`"path"`, `"parent"`, `"name"`, `"bytes"`, `"files"`, `"directories"`, `"inaccessible"`} {
		if !strings.Contains(text, key) {
			t.Fatalf("source scan JSON missing %s: %s", key, text)
		}
	}
	for _, legacy := range []string{`"Path"`, `"Parent"`, `"Name"`, `"Bytes"`, `"Files"`, `"Directories"`, `"Inaccessible"`} {
		if strings.Contains(text, legacy) {
			t.Fatalf("source scan JSON leaked Go field name %s: %s", legacy, text)
		}
	}
}

func TestSourceScanResultJSONPreservesNestedNodeContract(t *testing.T) {
	result := sourceScanResult{
		Drives:    []string{`C:\\`},
		Nodes:     []sourceScanNode{{Path: `C:\\`, Parent: "", Name: `C:\\`}},
		Truncated: true,
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	for _, key := range []string{`"drives"`, `"nodes"`, `"truncated"`, `"path"`, `"parent"`, `"name"`} {
		if !strings.Contains(text, key) {
			t.Fatalf("source scan result JSON missing %s: %s", key, text)
		}
	}
}
