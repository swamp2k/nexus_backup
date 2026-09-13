package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAgentPersistsRotatedDeviceTokenAndUsesItImmediately(t *testing.T) {
	const bootstrapToken = "nxbdev_bootstrap-token-1234567890"
	const rotatedToken = "nxbdev_rotated-token-abcdefghijklmnopqrstuvwxyz"

	var reportSeen bool
	var statusSeen bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/device/report":
			if got := r.Header.Get("Authorization"); got != "Bearer "+bootstrapToken {
				t.Fatalf("bootstrap authorization = %q", got)
			}
			reportSeen = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"device":{"id":"device-workstation-1"},"nextReportSeconds":60,"deviceToken":"` + rotatedToken + `"}`))
		case "/v1/device/workstation/status":
			if got := r.Header.Get("Authorization"); got != "Bearer "+rotatedToken {
				t.Fatalf("rotated authorization = %q", got)
			}
			statusSeen = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	configPath := filepath.Join(dir, "workstation.json")
	statePath := filepath.Join(dir, "workstation-state.json")
	cfg := config{
		ServerURL:     server.URL,
		DeviceToken:   bootstrapToken,
		ResticPath:    "restic.exe",
		PollSeconds:   15,
		ReportSeconds: 60,
		AutoInit:      true,
	}
	if err := saveConfig(configPath, cfg); err != nil {
		t.Fatal(err)
	}

	a := &agent{
		cfg:        cfg,
		configPath: configPath,
		statePath:  statePath,
		client:     newAPIClient(server.URL, bootstrapToken),
	}
	if err := a.report(); err != nil {
		t.Fatal(err)
	}
	if !reportSeen {
		t.Fatal("bootstrap report was not sent")
	}
	if a.cfg.DeviceToken != rotatedToken {
		t.Fatalf("in-memory device token = %q", a.cfg.DeviceToken)
	}
	if got := a.client.currentToken(); got != rotatedToken {
		t.Fatalf("client token = %q", got)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var persisted config
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.DeviceToken != rotatedToken {
		t.Fatalf("persisted device token = %q", persisted.DeviceToken)
	}

	if err := a.reportStatus(); err != nil {
		t.Fatal(err)
	}
	if !statusSeen {
		t.Fatal("status request did not use rotated credential")
	}
}
