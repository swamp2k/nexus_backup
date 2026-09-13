package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func backupTestConfig(t *testing.T, scriptBody string) config {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-restic")
	content := "#!/bin/sh\n" + scriptBody + "\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	password := filepath.Join(dir, "restic-password")
	if err := os.WriteFile(password, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return config{
		Repository:   "sftp:user@example:/repo",
		PasswordFile: password,
		ResticPath:   script,
		AutoInit:     false,
	}
}

// This is the exact failure mode from the M8 handover: controller disappears,
// agent keeps running restic, the lease expires and gets requeued, the
// controller returns and the old agent's next report is explicitly rejected
// as stale. The local restic process must be killed rather than allowed to
// finish and produce an untracked/duplicate snapshot.
func TestExecuteBackupCancelsResticOnExplicitStaleLease(t *testing.T) {
	cfg := backupTestConfig(t, `if [ "$1" = "cat" ]; then exit 0; fi
printf '%s\n' '{"message_type":"status","percent_done":0.1,"total_bytes":100,"bytes_done":10}'
sleep 5
printf '%s\n' '{"message_type":"summary","snapshot_id":"deadbeef00001111","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10}'
exit 0`)

	finishedCh := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			// Every heartbeat/progress report is an explicit stale-lease rejection.
			w.WriteHeader(http.StatusConflict)
		case http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			w.WriteHeader(http.StatusOK)
			finishedCh <- body
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	a := &agent{
		cfg:       cfg,
		statePath: filepath.Join(t.TempDir(), "workstation-state.json"),
		client:    newAPIClient(server.URL, "nxbdev_test-token-1234567890"),
	}
	run := workstationRun{
		ID: "run-1", DeviceID: "device-1", LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		SourcePaths: []string{t.TempDir()},
	}

	done := make(chan struct{})
	started := time.Now()
	go func() { a.executeBackup(run); close(done) }()

	select {
	case <-done:
		if elapsed := time.Since(started); elapsed >= 3*time.Second {
			t.Fatalf("executeBackup took %v; restic does not appear to have been cancelled on the stale-lease rejection", elapsed)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("executeBackup did not return after an explicit stale-lease rejection")
	}

	select {
	case body := <-finishedCh:
		if body["status"] != "failure" {
			t.Fatalf("expected the cancelled run to finish as failure, got %#v", body)
		}
	default:
		t.Fatal("expected finishRun to still report the cancelled outcome")
	}
}

// A transient heartbeat/progress failure (e.g. a network blip) must never be
// treated the same as an explicit stale-lease rejection - the backup must run
// to completion.
func TestExecuteBackupSurvivesTransientHeartbeatFailure(t *testing.T) {
	cfg := backupTestConfig(t, `if [ "$1" = "cat" ]; then exit 0; fi
printf '%s\n' '{"message_type":"status","percent_done":0.5,"total_bytes":100,"bytes_done":50}'
printf '%s\n' '{"message_type":"summary","snapshot_id":"deadbeef00001111","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10}'
exit 0`)

	finishedCh := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
			// A 500 looks like a transient failure, not an explicit lease rejection.
			w.WriteHeader(http.StatusInternalServerError)
		case http.MethodPost:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			w.WriteHeader(http.StatusOK)
			finishedCh <- body
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()

	a := &agent{
		cfg:       cfg,
		statePath: filepath.Join(t.TempDir(), "workstation-state.json"),
		client:    newAPIClient(server.URL, "nxbdev_test-token-1234567890"),
	}
	run := workstationRun{
		ID: "run-2", DeviceID: "device-1", LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		SourcePaths: []string{t.TempDir()},
	}

	done := make(chan struct{})
	go func() { a.executeBackup(run); close(done) }()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("executeBackup did not return")
	}

	select {
	case body := <-finishedCh:
		if body["status"] != "success" {
			t.Fatalf("a transient heartbeat failure must not cancel the backup, got %#v", body)
		}
	default:
		t.Fatal("expected finishRun to report success")
	}
}
