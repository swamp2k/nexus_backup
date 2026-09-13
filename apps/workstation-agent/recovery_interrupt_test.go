package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInterruptedWriteRestoreLeavesOrphanedStagingAndRefusesSameTargetRetry(t *testing.T) {
	cfg := helperBackupTestConfig(t, "restore-partial-sleep")
	root := filepath.Join(t.TempDir(), "restores")
	runID := "restore-interrupted-1"
	target := filepath.Join(root, runID)
	marker := filepath.Join(target, "partial.txt")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan restoreResult, 1)
	go func() {
		done <- executeRecoveryRestore(ctx, cfg, root, runID, "abcdef1234567890", "")
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("fake restore never produced partial staging content")
		}
		time.Sleep(25 * time.Millisecond)
	}
	cancel()

	select {
	case result := <-done:
		if !result.Cancelled || result.Err == nil {
			t.Fatalf("expected interrupted write restore, got %#v", result)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("interrupted write restore did not terminate")
	}

	data, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("orphaned staging content was removed: %v", err)
	}
	if string(data) != "partial restore\n" {
		t.Fatalf("unexpected orphaned staging content: %q", data)
	}

	// A write restore is never resumed into the same staging directory. The
	// controller must issue a fresh manual retry with a new run id/target.
	retry := executeRecoveryRestore(context.Background(), cfg, root, runID, "abcdef1234567890", "")
	if retry.Err == nil || !strings.Contains(retry.Err.Error(), "already exists") {
		t.Fatalf("same-target retry was not refused: %#v", retry)
	}
}
