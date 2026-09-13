//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureProcessTree(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func bindProcessTree(cmd *exec.Cmd) error { return nil }
func releaseProcessTree(cmd *exec.Cmd)    {}

func terminateProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	pid := cmd.Process.Pid
	if pid > 0 {
		if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil {
			return nil
		} else if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
	}
	return cmd.Process.Kill()
}
