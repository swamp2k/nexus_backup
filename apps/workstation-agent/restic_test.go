package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateRunRejectsRelativeSource(t *testing.T) {
	run := workstationRun{ID: "run-1", DeviceID: "device-1", LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz", SourcePaths: []string{"relative/path"}}
	if err := validateRun(run); err == nil {
		t.Fatal("expected relative source to be rejected")
	}
}

func TestRepositoryKind(t *testing.T) {
	if got := repositoryKind(`sftp:user@example:/repo`); got != "sftp" {
		t.Fatalf("sftp kind = %q", got)
	}
	if runtime.GOOS != "windows" {
		if got := repositoryKind(`/srv/repo`); got != "local" {
			t.Fatalf("local kind = %q", got)
		}
	}
}

func TestRunBackupCommandParsesResticJSON(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-restic")
	content := `#!/bin/sh
printf '%s\n' '{"message_type":"status","percent_done":0.5,"total_bytes":100,"bytes_done":50,"total_files":10,"files_done":5,"current_files":["/data/file"]}'
printf '%s\n' '{"message_type":"summary","snapshot_id":"abcdef123456","files_new":3,"files_changed":2,"files_unmodified":5,"data_added":42}'
exit 0
`
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	var reports []backupProgress
	result := runBackupCommand(script, os.Environ(), []string{"backup"}, func(progress backupProgress) { reports = append(reports, progress) })
	if result.Err != nil {
		t.Fatalf("unexpected error: %v", result.Err)
	}
	if result.SnapshotID != "abcdef123456" || result.FilesNew != 3 || result.FilesChanged != 2 || result.FilesUnmodified != 5 || result.DataAdded != 42 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if len(reports) == 0 || reports[0].Percent != 50 || reports[0].BytesDone != 50 {
		t.Fatalf("unexpected progress: %#v", reports)
	}
}

func TestRunBackupCommandMapsExitThreeToPartial(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-restic")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'some files unreadable' >&2\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	result := runBackupCommand(script, os.Environ(), []string{"backup"}, nil)
	if !result.Partial || result.Err == nil {
		t.Fatalf("expected partial result, got %#v", result)
	}
}
