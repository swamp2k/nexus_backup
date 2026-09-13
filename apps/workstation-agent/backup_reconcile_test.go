package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBackupRunTagsAreStableAndBounded(t *testing.T) {
	run := workstationRun{ID: "wsrun-1234.abcd", DeviceID: "device_1"}
	deviceTag, runTag, completeTag, err := backupRunTags(run)
	if err != nil {
		t.Fatal(err)
	}
	if deviceTag != "nexus-workstation:device_1" || runTag != "nexus-run:wsrun-1234.abcd" || completeTag != "nexus-run-complete:wsrun-1234.abcd" {
		t.Fatalf("unexpected tags: %q %q %q", deviceTag, runTag, completeTag)
	}

	run.ID = "bad\nrun"
	if _, _, _, err := backupRunTags(run); err == nil {
		t.Fatal("expected unsafe run id to be rejected")
	}
}

func TestCompletedRunSnapshotIsReconciledWithoutSecondBackup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake restic fixture uses a POSIX shell; native Windows CI still compiles the reconciliation path")
	}

	dir := t.TempDir()
	statePath := filepath.Join(dir, "state")
	callsPath := filepath.Join(dir, "calls")
	script := filepath.Join(dir, "fake-restic")
	passwordFile := filepath.Join(dir, "password")
	if err := os.WriteFile(passwordFile, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, []byte("none\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := `#!/bin/sh
set -eu
echo "$*" >> "$FAKE_CALLS"
case "$1" in
  cat)
    exit 0
    ;;
  snapshots)
    state="$(cat "$FAKE_STATE")"
    case "$state" in
      none)
        printf '%s\n' '[]'
        ;;
      unconfirmed)
        printf '%s\n' '[{"id":"deadbeef11112222","tags":["nexus-workstation:device-1","nexus-run:run-1"]}]'
        ;;
      confirmed)
        printf '%s\n' '[{"id":"feedface22223333","tags":["nexus-workstation:device-1","nexus-run:run-1","nexus-run-complete:run-1"]}]'
        ;;
    esac
    exit 0
    ;;
  backup)
    printf '%s\n' unconfirmed > "$FAKE_STATE"
    printf '%s\n' '{"message_type":"summary","snapshot_id":"deadbeef11112222","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10}'
    exit 0
    ;;
  tag)
    printf '%s\n' confirmed > "$FAKE_STATE"
    exit 0
    ;;
  *)
    echo "unexpected fake restic command: $*" >&2
    exit 2
    ;;
esac
`
	if err := os.WriteFile(script, []byte(fixture), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("FAKE_STATE", statePath)
	t.Setenv("FAKE_CALLS", callsPath)
	cfg := config{
		Repository:   "sftp:test@example:/repo",
		PasswordFile: passwordFile,
		ResticPath:   script,
	}
	run := workstationRun{
		ID:         "run-1",
		DeviceID:   "device-1",
		LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		SourcePaths: []string{dir},
		Retention: retentionPolicy{},
	}

	first := executeResticBackup(context.Background(), cfg, run, nil)
	if first.Err != nil {
		t.Fatalf("first backup failed: %v", first.Err)
	}
	if first.SnapshotID != "feedface22223333" {
		t.Fatalf("first backup reported stale snapshot id %q", first.SnapshotID)
	}

	second := executeResticBackup(context.Background(), cfg, run, nil)
	if second.Err != nil {
		t.Fatalf("reconciliation failed: %v", second.Err)
	}
	if second.SnapshotID != first.SnapshotID {
		t.Fatalf("reconciled snapshot = %q, want %q", second.SnapshotID, first.SnapshotID)
	}

	calls, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(calls)
	if got := strings.Count(text, "backup --json"); got != 1 {
		t.Fatalf("backup command ran %d times; calls:\n%s", got, text)
	}
	if !strings.Contains(text, "--tag nexus-workstation:device-1 --tag nexus-run:run-1") {
		t.Fatalf("backup did not carry both device and run tags; calls:\n%s", text)
	}
	if !strings.Contains(text, "tag --add nexus-run-complete:run-1 deadbeef11112222") {
		t.Fatalf("backup completion marker was not written; calls:\n%s", text)
	}
}

func TestUnconfirmedRunSnapshotRefusesAutomaticDuplicate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake restic fixture uses a POSIX shell")
	}

	dir := t.TempDir()
	callsPath := filepath.Join(dir, "calls")
	script := filepath.Join(dir, "fake-restic")
	passwordFile := filepath.Join(dir, "password")
	if err := os.WriteFile(passwordFile, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := `#!/bin/sh
set -eu
echo "$*" >> "$FAKE_CALLS"
case "$1" in
  cat) exit 0 ;;
  snapshots)
    printf '%s\n' '[{"id":"deadbeef11112222","tags":["nexus-workstation:device-1","nexus-run:run-1"]}]'
    exit 0
    ;;
  backup)
    echo "backup must not run" >&2
    exit 99
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(script, []byte(fixture), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CALLS", callsPath)

	cfg := config{Repository: "sftp:test@example:/repo", PasswordFile: passwordFile, ResticPath: script}
	run := workstationRun{
		ID: "run-1", DeviceID: "device-1", LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
		SourcePaths: []string{dir}, Retention: retentionPolicy{},
	}
	result := executeResticBackup(context.Background(), cfg, run, nil)
	if result.Err == nil || !strings.Contains(result.Err.Error(), "unconfirmed snapshot") {
		t.Fatalf("expected ambiguous snapshot refusal, got %#v", result)
	}
	calls, err := os.ReadFile(callsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(calls), "backup --json") {
		t.Fatalf("ambiguous run wrote another snapshot; calls:\n%s", calls)
	}
}
