package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

// commandContextWithTree creates a cancellable command whose cancellation
// terminates the complete subprocess tree, not only the immediate child.
// Platform binding performed immediately after Start also ties child lifetime
// to the workstation-agent process itself (notably via a Windows Job Object).
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

func startCommandTree(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		releaseProcessTree(cmd)
		return err
	}
	if err := bindProcessTree(cmd); err != nil {
		_ = terminateProcessTree(cmd)
		_ = cmd.Wait()
		releaseProcessTree(cmd)
		return fmt.Errorf("bind child process lifetime: %w", err)
	}
	return nil
}

func waitCommandTree(cmd *exec.Cmd) error {
	err := cmd.Wait()
	releaseProcessTree(cmd)
	return err
}

func combinedOutputTree(cmd *exec.Cmd) ([]byte, error) {
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := startCommandTree(cmd); err != nil {
		return nil, err
	}
	err := waitCommandTree(cmd)
	return output.Bytes(), err
}
