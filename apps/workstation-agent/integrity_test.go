package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckWorkstationRepositoryRunsReadOnlyResticCheck(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "checked")
	cfg := backupTestConfig(t, `if [ "$1" = "cat" ]; then exit 0; fi
if [ "$1" = "check" ]; then printf checked > "`+marker+`"; exit 0; fi
exit 91`)

	if err := checkWorkstationRepository(context.Background(), cfg); err != nil {
		t.Fatalf("checkWorkstationRepository failed: %v", err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "checked" {
		t.Fatalf("restic check was not executed: data=%q err=%v", data, err)
	}
}

func TestCheckWorkstationRepositoryFailureIsBoundedAndRedacted(t *testing.T) {
	cfg := backupTestConfig(t, `if [ "$1" = "cat" ]; then exit 0; fi
if [ "$1" = "check" ]; then printf '%s\n' 'repository `+"sftp:user@example:/repo"+` password `+filepath.ToSlash("PLACEHOLDER")+`'; exit 7; fi
exit 91`)
	// Put the real password-file path in command output without embedding a
	// platform-specific path in the shell literal above.
	scriptData, err := os.ReadFile(cfg.ResticPath)
	if err != nil { t.Fatal(err) }
	script := strings.ReplaceAll(string(scriptData), filepath.ToSlash("PLACEHOLDER"), cfg.PasswordFile)
	if err := os.WriteFile(cfg.ResticPath, []byte(script), 0o755); err != nil { t.Fatal(err) }

	err = checkWorkstationRepository(context.Background(), cfg)
	if err == nil {
		t.Fatal("expected failed restic check")
	}
	text := err.Error()
	if strings.Contains(text, cfg.Repository) || strings.Contains(text, cfg.PasswordFile) {
		t.Fatalf("integrity error leaked local repository secret material: %q", text)
	}
	if !strings.Contains(text, "[repository]") || !strings.Contains(text, "[password-file]") {
		t.Fatalf("expected redacted repository and password file, got %q", text)
	}
}

func TestCheckWorkstationRepositoryCancellationTerminatesProcessTree(t *testing.T) {
	cfg := backupTestConfig(t, `if [ "$1" = "cat" ]; then exit 0; fi
if [ "$1" = "check" ]; then sleep 10; exit 0; fi
exit 91`)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	started := time.Now()
	go func() { done <- checkWorkstationRepository(ctx, cfg) }()
	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "cancelled") {
			t.Fatalf("expected cancelled integrity check, got %v", err)
		}
		if elapsed := time.Since(started); elapsed >= 3*time.Second {
			t.Fatalf("integrity process tree was not terminated promptly: %v", elapsed)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("integrity check did not return after context cancellation")
	}
}
