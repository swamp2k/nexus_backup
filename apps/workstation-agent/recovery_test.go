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

func recoveryTestConfig(t *testing.T, scriptBody string) (config, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args.log")
	script := filepath.Join(dir, "fake-restic")
	content := "#!/bin/sh\n" +
		"if [ \"$1\" = \"cat\" ]; then exit 0; fi\n" +
		"printf '%s\\n' \"$@\" > \"$FAKE_RESTIC_LOG\"\n" +
		scriptBody + "\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	password := filepath.Join(dir, "restic-password")
	if err := os.WriteFile(password, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_RESTIC_LOG", logPath)
	return config{
		Repository:   "sftp:user@example:/repo",
		PasswordFile: password,
		ResticPath:   script,
		AutoInit:     false,
	}, logPath
}

func readRecoveryArgs(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" { return nil }
	return strings.Split(text, "\n")
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want { return true }
	}
	return false
}

func argAfter(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag { return args[i+1] }
	}
	return ""
}

func TestListRecoverySnapshotsUsesPlanTagAndBoundsMetadata(t *testing.T) {
	cfg, logPath := recoveryTestConfig(t, `cat <<'JSON'
[{"id":"abcdef1234567890","short_id":"abcdef12","time":"2026-09-13T08:00:00Z","hostname":"BALDER-PC","paths":["C:\\\\Users\\\\Balder"],"tags":["nexus-workstation:device-1"]}]
JSON`)

	snapshots, err := listRecoverySnapshots(t.Context(), cfg, "device-1")
	if err != nil { t.Fatalf("list snapshots: %v", err) }
	if len(snapshots) != 1 || snapshots[0].ID != "abcdef1234567890" || snapshots[0].Hostname != "BALDER-PC" {
		t.Fatalf("unexpected snapshots: %#v", snapshots)
	}
	args := readRecoveryArgs(t, logPath)
	want := []string{"snapshots", "--json", "--latest", "250", "--group-by", "", "--tag", "nexus-workstation:device-1"}
	if len(args) != len(want) {
		t.Fatalf("snapshot args = %#v, want %#v", args, want)
	}
	for i := range want {
		if args[i] != want[i] { t.Fatalf("snapshot arg %d = %q, want %q", i, args[i], want[i]) }
	}
}

func TestBrowseRecoverySnapshotIsNonRecursiveAndSortsDirectoriesFirst(t *testing.T) {
	cfg, logPath := recoveryTestConfig(t, `cat <<'JSON'
{"message_type":"snapshot","id":"abcdef1234567890"}
{"message_type":"node","path":"/C/Users/Balder/z.txt","name":"z.txt","type":"file","size":42,"mtime":"2026-09-13T08:00:00Z"}
{"struct_type":"node","path":"/C/Users/Balder/Documents","name":"Documents","type":"dir","mtime":"2026-09-13T07:00:00Z"}
JSON`)

	result, err := browseRecoverySnapshot(t.Context(), cfg, "ABCDEF1234567890", "/C/Users/Balder")
	if err != nil { t.Fatalf("browse: %v", err) }
	if result.SnapshotID != "abcdef1234567890" || len(result.Entries) != 2 {
		t.Fatalf("unexpected browse result: %#v", result)
	}
	if result.Entries[0].NodeType != "dir" || result.Entries[0].Name != "Documents" {
		t.Fatalf("directory was not sorted first: %#v", result.Entries)
	}
	args := readRecoveryArgs(t, logPath)
	if containsArg(args, "--recursive") { t.Fatalf("browse must not be recursive: %#v", args) }
	want := []string{"ls", "--json", "abcdef1234567890", "/C/Users/Balder"}
	if strings.Join(args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("browse args = %#v, want %#v", args, want)
	}
}

func TestPreviewRecoveryRestoreHardCodesDryRunAndVerbatimInclude(t *testing.T) {
	cfg, logPath := recoveryTestConfig(t, `printf '%s\n' 'restored /C/Users/Balder/[draft].txt' 'updated /C/Users/Balder/file.txt' 'unchanged /C/Users/Balder/old.txt'`)
	root := filepath.Join(t.TempDir(), "restores")
	include := "/C/Users/Balder/[draft].txt"
	result := previewRecoveryRestore(t.Context(), cfg, root, "restore-1", "abcdef1234567890", include)
	if result.Err != nil { t.Fatalf("preview: %v", result.Err) }
	if !result.DryRun || result.Restored != 1 || result.Updated != 1 || result.Unchanged != 1 {
		t.Fatalf("unexpected preview: %#v", result)
	}
	args := readRecoveryArgs(t, logPath)
	if !containsArg(args, "--dry-run") { t.Fatalf("preview missing --dry-run: %#v", args) }
	if containsArg(args, "--delete") { t.Fatalf("preview must never use --delete: %#v", args) }
	if got := argAfter(args, "--overwrite"); got != "never" { t.Fatalf("overwrite = %q", got) }
	if got := argAfter(args, "--include"); got != include { t.Fatalf("include = %q, want verbatim %q", got, include) }
	if got := argAfter(args, "--target"); got != filepath.Join(root, "restore-1") { t.Fatalf("target = %q", got) }
}

func TestExecuteRecoveryRestoreIsStagingOnlyAndNeverDelete(t *testing.T) {
	cfg, logPath := recoveryTestConfig(t, `printf '%s\n' 'restored /C/Users/Balder/file.txt'`)
	root := filepath.Join(t.TempDir(), "restores")
	result := executeRecoveryRestore(t.Context(), cfg, root, "restore-2", "abcdef1234567890", "")
	if result.Err != nil { t.Fatalf("restore: %v", result.Err) }
	if result.DryRun { t.Fatal("write restore unexpectedly marked dry-run") }
	args := readRecoveryArgs(t, logPath)
	if containsArg(args, "--dry-run") { t.Fatalf("write restore contains --dry-run: %#v", args) }
	if containsArg(args, "--delete") { t.Fatalf("write restore must never use --delete: %#v", args) }
	if got := argAfter(args, "--overwrite"); got != "never" { t.Fatalf("overwrite = %q", got) }
	if got := argAfter(args, "--target"); got != filepath.Join(root, "restore-2") { t.Fatalf("target = %q", got) }
}

func TestExecuteRecoveryRestoreRefusesExistingTarget(t *testing.T) {
	cfg, logPath := recoveryTestConfig(t, `printf '%s\n' 'restored should-not-run'`)
	root := filepath.Join(t.TempDir(), "restores")
	target := filepath.Join(root, "restore-3")
	if err := os.MkdirAll(target, 0o700); err != nil { t.Fatal(err) }
	_ = os.Remove(logPath)

	result := executeRecoveryRestore(t.Context(), cfg, root, "restore-3", "abcdef1234567890", "")
	if result.Err == nil || !strings.Contains(result.Err.Error(), "already exists") {
		t.Fatalf("expected existing-target refusal, got %#v", result)
	}
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatalf("restore command should not have run, stat err=%v", err)
	}
}

func TestRunRestoreCommandKillsResticAndReportsCancelledOnContextCancellation(t *testing.T) {
	resticPath, env, args := helperProcessArgs("sleep")
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan restoreResult, 1)
	started := time.Now()
	go func() { done <- runRestoreCommand(ctx, resticPath, env, args, t.TempDir(), false) }()

	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if !result.Cancelled || result.Err == nil {
			t.Fatalf("expected a cancelled restore result, got %#v", result)
		}
		if elapsed := time.Since(started); elapsed >= 5*time.Second {
			t.Fatalf("runRestoreCommand took %v; restic does not appear to have been killed on cancellation", elapsed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runRestoreCommand did not return after its context was cancelled")
	}
}

func TestRunRestoreCommandKillsDescendantProcessTreeOnCancellation(t *testing.T) {
	cfg, _ := recoveryTestConfig(t, `sleep 5`)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan restoreResult, 1)
	started := time.Now()
	go func() {
		done <- runRestoreCommand(ctx, cfg.ResticPath, recoveryEnvironment(cfg), []string{"restore", "abcdef1234567890", "--target", t.TempDir()}, t.TempDir(), false)
	}()

	time.Sleep(200 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if !result.Cancelled || result.Err == nil {
			t.Fatalf("expected cancelled descendant-tree restore, got %#v", result)
		}
		if elapsed := time.Since(started); elapsed >= 3*time.Second {
			t.Fatalf("restore cancellation took %v; descendant process appears to have kept pipes open", elapsed)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("restore process tree did not terminate after cancellation")
	}
}

func TestRecoveryRestoreTargetRejectsUnsafeRunID(t *testing.T) {
	if _, err := recoveryRestoreTarget(t.TempDir(), "../escape"); err == nil {
		t.Fatal("expected traversal run id to be rejected")
	}
	if _, err := recoveryRestoreTarget(t.TempDir(), "drive:C"); err == nil {
		t.Fatal("expected Windows-unsafe colon to be rejected")
	}
}

func TestValidateSnapshotPathPreservesResticPathVerbatim(t *testing.T) {
	input := "/C/Users/Balder/[draft] final.txt"
	got, err := validateSnapshotPath(input)
	if err != nil { t.Fatal(err) }
	if got != input { t.Fatalf("path changed: %q != %q", got, input) }
	if _, err := validateSnapshotPath("/C/../Windows"); err == nil { t.Fatal("expected dot segment rejection") }
	if _, err := validateSnapshotPath("C:/Users/Balder"); err == nil { t.Fatal("expected non-restic path rejection") }
}
