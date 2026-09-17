package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAPIClientUsesBearerAndDeviceReportShape(t *testing.T) {
	var seen bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device/report" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer nxbdev_test-token-1234567890" {
			t.Fatalf("authorization = %q", got)
		}
		var report deviceReport
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Fatal(err)
		}
		if report.Version != "1.2.3" || report.Hostname != "test-pc" || report.Platform != "windows/amd64" {
			t.Fatalf("unexpected report: %#v", report)
		}
		seen = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device":{"id":"device-1"},"nextReportSeconds":60,"deviceToken":"nxbdev_rotated-token-abcdefghijklmnopqrstuvwxyz"}`))
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "nxbdev_test-token-1234567890")
	response, err := client.reportDevice(deviceReport{Version: "1.2.3", Hostname: "test-pc", Platform: "windows/amd64", Capabilities: []string{"workstation.backup.v1"}})
	if err != nil {
		t.Fatal(err)
	}
	if !seen || response.Device.ID != "device-1" {
		t.Fatalf("response = %#v", response)
	}
	if response.DeviceToken != "nxbdev_rotated-token-abcdefghijklmnopqrstuvwxyz" {
		t.Fatalf("device token = %q", response.DeviceToken)
	}
}

func TestAPIClientCanRotateBearerToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer nxbdev_rotated-token-abcdefghijklmnopqrstuvwxyz" {
			t.Fatalf("authorization = %q", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "nxbdev_bootstrap-token-1234567890")
	client.setToken("nxbdev_rotated-token-abcdefghijklmnopqrstuvwxyz")
	if err := client.reportWorkstationStatus(workstationStatus{RepositoryConfigured: false, AgentState: "needs-storage"}); err != nil {
		t.Fatal(err)
	}
}

func TestIsStaleLeaseFlagsOnlyExplicitConflictRejection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Workstation run lease is stale or invalid"}`))
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "nxbdev_test-token-1234567890")
	err := client.reportProgress("run-1", "nxbws_abcdefghijklmnopqrstuvwxyz", backupProgress{Phase: "running"})
	if err == nil {
		t.Fatal("expected an error from the 409 response")
	}
	if !isStaleLease(err) {
		t.Fatalf("expected an explicit 409 rejection to be classified as a stale lease: %v", err)
	}
}

func TestIsStaleLeaseIgnoresOtherServerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "nxbdev_test-token-1234567890")
	err := client.reportProgress("run-1", "nxbws_abcdefghijklmnopqrstuvwxyz", backupProgress{Phase: "running"})
	if err == nil {
		t.Fatal("expected an error from the 500 response")
	}
	if isStaleLease(err) {
		t.Fatalf("a 500 must not be classified as an explicit stale-lease rejection: %v", err)
	}
}

func TestIsStaleLeaseIgnoresTransientNetworkFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	client := newAPIClient(server.URL, "nxbdev_test-token-1234567890")
	server.Close() // connections now fail before any HTTP response exists

	err := client.reportProgress("run-1", "nxbws_abcdefghijklmnopqrstuvwxyz", backupProgress{Phase: "running"})
	if err == nil {
		t.Fatal("expected a connection error against a closed server")
	}
	if isStaleLease(err) {
		t.Fatalf("a transient network failure must not be classified as an explicit stale-lease rejection: %v", err)
	}
}

func TestFinishRunCarriesLeaseToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device/workstation/runs/run-1/result" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["leaseToken"] != "nxbws_abcdefghijklmnopqrstuvwxyz" || body["status"] != "success" {
			t.Fatalf("body = %#v", body)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client := newAPIClient(server.URL, "nxbdev_test-token-1234567890")
	if err := client.finishRun("run-1", "nxbws_abcdefghijklmnopqrstuvwxyz", "success", map[string]any{"snapshotId": "abc"}, ""); err != nil {
		t.Fatal(err)
	}
}

func TestUploadUsesStreamingClientWithoutShortTotalTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s, want PUT", r.Method)
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Fatalf("read upload: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	client := newAPIClient(server.URL, "test-token")
	client.http.Timeout = 10 * time.Millisecond
	filePath := filepath.Join(t.TempDir(), "upload.bin")
	if err := os.WriteFile(filePath, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filePath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	if err := client.uploadFileWithMtime(context.Background(), "upload.bin", file, 7, time.Time{}); err != nil {
		t.Fatalf("upload failed despite streaming client: %v", err)
	}
	if client.uploadHTTP.Timeout != 0 {
		t.Fatalf("upload client timeout = %s, want no total timeout", client.uploadHTTP.Timeout)
	}
}
