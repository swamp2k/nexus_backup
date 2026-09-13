package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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
	result := runBackupCommand(t.Context(), script, os.Environ(), []string{"backup"}, func(progress backupProgress) { reports = append(reports, progress) })
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

func TestRunBackupCommandKillsResticAndReportsCancelledOnContextCancellation(t *testing.T) {
	resticPath, env, args := helperProcessArgs("sleep")
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan backupResult, 1)
	started := time.Now()
	go func() { done <- runBackupCommand(ctx, resticPath, env, args, nil) }()

	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if !result.Cancelled || result.Err == nil {
			t.Fatalf("expected a cancelled result, got %#v", result)
		}
		if elapsed := time.Since(started); elapsed >= 5*time.Second {
			t.Fatalf("runBackupCommand took %v; restic does not appear to have been killed on cancellation", elapsed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runBackupCommand did not return after its context was cancelled")
	}
}

func TestEnsureRepositoryProbeKillsDescendantTreeOnCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-restic")
	content := "#!/bin/sh\nif [ \"$1\" = \"cat\" ]; then sleep 5; exit 0; fi\nexit 0\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	started := time.Now()
	go func() { done <- ensureRepositoryContext(ctx, script, os.Environ(), "sftp:user@example:/repo", false) }()
	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancelled repository probe to fail")
		}
		if elapsed := time.Since(started); elapsed >= 3*time.Second {
			t.Fatalf("repository probe cancellation took %v; descendant process appears to have survived", elapsed)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("repository probe did not stop after cancellation")
	}
}

func TestApplyRetentionKillsDescendantTreeOnCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-restic")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 5\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	started := time.Now()
	go func() {
		done <- applyRetentionContext(ctx, script, os.Environ(), "nexus-workstation:device-1", retentionPolicy{KeepDaily: 1})
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancelled retention to fail")
		}
		if elapsed := time.Since(started); elapsed >= 3*time.Second {
			t.Fatalf("retention cancellation took %v; descendant process appears to have survived", elapsed)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("retention did not stop after cancellation")
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
	result := runBackupCommand(t.Context(), script, os.Environ(), []string{"backup"}, nil)
	if !result.Partial || result.Err == nil {
		t.Fatalf("expected partial result, got %#v", result)
	}
}

func TestRepositoryFailuresAreFatalAndRedacted(t *testing.T) {
	cases := []struct {
		name string
		mode string
		want string
	}{
		{name: "authentication", mode: "repo-auth-fail", want: "wrong password"},
		{name: "unavailable", mode: "repo-unavailable", want: "connection refused"},
		{name: "locked", mode: "backup-locked", want: "locked"},
		{name: "disk-full", mode: "backup-disk-full", want: "no space left"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := helperBackupTestConfig(t, tc.mode)
			run := workstationRun{
				ID: "repo-failure-" + tc.name,
				DeviceID: "device-1",
				LeaseToken: "nxbws_abcdefghijklmnopqrstuvwxyz",
				SourcePaths: []string{t.TempDir()},
			}
			result := executeResticBackup(t.Context(), cfg, run, nil)
			if result.Err == nil {
				t.Fatalf("expected repository failure for %s", tc.name)
			}
			if result.Cancelled || result.Partial {
				t.Fatalf("repository failure misclassified: %#v", result)
			}
			text := strings.ToLower(result.Err.Error())
			if !strings.Contains(text, tc.want) {
				t.Fatalf("error %q does not contain %q", text, tc.want)
			}
			if strings.Contains(text, strings.ToLower(cfg.Repository)) || strings.Contains(text, strings.ToLower(cfg.PasswordFile)) {
				t.Fatalf("repository error leaked local storage configuration: %q", result.Err)
			}
		})
	}
}
