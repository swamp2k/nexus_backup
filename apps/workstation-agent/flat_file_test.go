package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFlatFileBackupUsesStableTotalsAndMarksChangedProgressPartial(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "Documents")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "b.txt"), []byte("bbbbbbbbb"), 0o600); err != nil {
		t.Fatal(err)
	}

	puts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", "0")
			w.Header().Set("X-Nexus-Source-Mtime", time.Unix(0, 0).UTC().Format(time.RFC3339Nano))
			return
		}
		if r.Method != http.MethodPut {
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		puts++
		_, _ = io.Copy(io.Discard, r.Body)
		if puts == 2 {
			http.Error(w, "simulated upload failure", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	cfg := config{ServerURL: server.URL, DeviceToken: "nxbdev_test-token-1234567890", RepositoryID: "repo-1"}
	run := workstationRun{ID: "run-1", LeaseToken: "lease-1", SourcePaths: []string{source}}
	var progress []backupProgress
	result := executeFlatFileBackup(context.Background(), cfg, run, func(value backupProgress) {
		progress = append(progress, value)
	})

	if result.Err == nil || !strings.Contains(result.Err.Error(), "upload") {
		t.Fatalf("backup error = %v, want upload error", result.Err)
	}
	if !result.Partial {
		t.Fatal("changed file followed by an error must be partial")
	}
	if result.FilesChanged != 1 || result.FilesNew != 0 {
		t.Fatalf("changed/new counts = %d/%d, want 1/0", result.FilesChanged, result.FilesNew)
	}
	if len(progress) != 1 {
		t.Fatalf("progress reports = %d, want one successful file report", len(progress))
	}
	if progress[0].BytesTotal != 10 || progress[0].FilesTotal != 2 || progress[0].Percent != 10 {
		t.Fatalf("progress = %+v, want total bytes 10, files 2, percent 10", progress[0])
	}
}
