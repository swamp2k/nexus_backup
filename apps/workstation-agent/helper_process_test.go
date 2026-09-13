package main

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// TestHelperProcess is not a real test on its own. Other tests re-exec the
// current test binary as a subprocess (the standard os/exec helper-process
// idiom) and point resticPath at os.Args[0], so restic cancellation can be
// exercised against a real, killable process on every platform - not only
// via the POSIX shell fixtures the rest of this file uses, which cannot run
// on Windows dev machines.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	switch os.Getenv("HELPER_MODE") {
	case "sleep":
		time.Sleep(30 * time.Second)
	case "backup-success":
		fmt.Println(`{"message_type":"summary","snapshot_id":"deadbeef00001111","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10}`)
	}
	os.Exit(0)
}

// helperProcessArgs returns the resticPath/env/args triple that invokes this
// same test binary as a fake restic process running in the given HELPER_MODE.
func helperProcessArgs(mode string) (resticPath string, env []string, args []string) {
	env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1", "HELPER_MODE="+mode)
	return os.Args[0], env, []string{"-test.run=^TestHelperProcess$"}
}
