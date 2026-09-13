package main

import (
	"context"
	"os/exec"
	"time"
)

// commandContextWithTree creates a cancellable command whose cancellation
// terminates the complete subprocess tree, not only the immediate child.
// Restic may be wrapped by scripts/helpers that spawn descendants which can
// otherwise keep inherited stdout/stderr pipes open after the parent exits.
func commandContextWithTree(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	configureProcessTree(cmd)
	cmd.Cancel = func() error {
		return terminateProcessTree(cmd)
	}
	// Do not allow inherited descriptors in a misbehaving descendant to keep
	// Wait blocked indefinitely after cancellation.
	cmd.WaitDelay = 2 * time.Second
	return cmd
}
