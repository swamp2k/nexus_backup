//go:build windows

package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsAgentJobKillsChildrenWhenParentDies(t *testing.T) {
	sentinel := filepath.Join(t.TempDir(), "orphan-survived.txt")
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(),
		"GO_WANT_HELPER_PROCESS=1",
		"HELPER_MODE=agent-job-parent",
		"HELPER_SENTINEL="+sentinel,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if scanner.Text() == "READY" {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	select {
	case ok := <-ready:
		if !ok {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatal("job-object helper exited before becoming ready")
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatal("job-object helper did not become ready")
	}

	// Simulate Scheduled Task / agent process termination. The helper's child
	// would create the sentinel after 1.5s if it survived the parent.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(sentinel); err == nil {
		t.Fatal("child process survived hard agent termination")
	} else if !os.IsNotExist(err) {
		t.Fatalf("stat sentinel: %v", err)
	}
}
