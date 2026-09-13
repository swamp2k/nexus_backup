//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
)

func configureProcessTree(cmd *exec.Cmd) {
	// taskkill /T uses the Windows parent/child process relationship, so no
	// special creation flags are required here.
}

func terminateProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	// /T terminates descendants and /F prevents a child console process from
	// keeping inherited pipes open after the controller revoked the lease.
	if err := exec.Command("taskkill", "/PID", pid, "/T", "/F").Run(); err == nil {
		return nil
	}
	return cmd.Process.Kill()
}
