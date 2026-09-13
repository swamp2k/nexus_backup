package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestExecuteRecoveryCancelsOnExplicitStaleLease(t *testing.T) {
	cfg := backupTestConfig(t, `sleep 5`)
	finishedCh := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
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

	root := t.TempDir()
	a := &agent{
		cfg:        cfg,
		configPath: filepath.Join(root, "config.json"),
		statePath:  filepath.Join(root, "state.json"),
		client:     newAPIClient(server.URL, "nxbdev_test-token-1234567890"),
	}
	run := workstationRun{
		ID: "restore-stale-1", DeviceID: "device-1", Operation: "restore",
		LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		Request: recoveryRequest{SnapshotID: "abcdef1234567890"},
	}

	started := time.Now()
	a.executeRecovery(run, "restore")
	if elapsed := time.Since(started); elapsed >= 3*time.Second {
		t.Fatalf("stale-lease recovery took %v; local work was not cancelled promptly", elapsed)
	}

	select {
	case body := <-finishedCh:
		if body["status"] != "failure" {
			t.Fatalf("expected stale restore to finish as failure, got %#v", body)
		}
	default:
		t.Fatal("expected cancelled recovery outcome to be reported")
	}
}

func TestExecuteRecoverySurvivesTransientProgressFailure(t *testing.T) {
	cfg := backupTestConfig(t, `printf '%s\n' 'restored /C/Users/Balder/file.txt'`)
	finishedCh := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPatch:
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

	root := t.TempDir()
	a := &agent{
		cfg:        cfg,
		configPath: filepath.Join(root, "config.json"),
		statePath:  filepath.Join(root, "state.json"),
		client:     newAPIClient(server.URL, "nxbdev_test-token-1234567890"),
	}
	run := workstationRun{
		ID: "restore-transient-1", DeviceID: "device-1", Operation: "restore",
		LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		Request: recoveryRequest{SnapshotID: "abcdef1234567890"},
	}

	a.executeRecovery(run, "restore")

	select {
	case body := <-finishedCh:
		if body["status"] != "success" {
			t.Fatalf("transient progress failure must not cancel recovery, got %#v", body)
		}
	default:
		t.Fatal("expected successful recovery outcome to be reported")
	}
}
