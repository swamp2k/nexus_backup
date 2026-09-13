package main

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// TestHelperProcess is not a real test on its own. Other tests re-exec the
// current test binary as a subprocess (the standard os/exec helper-process
// idiom) and point resticPath at os.Args[0], so cancellation and repository
// failures can be exercised against a real process on every platform.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	mode := os.Getenv("HELPER_MODE")
	isCat := helperHasArg("cat")

	switch mode {
	case "sleep":
		time.Sleep(30 * time.Second)
	case "backup-success":
		if isCat {
			os.Exit(0)
		}
		fmt.Println(`{"message_type":"summary","snapshot_id":"deadbeef00001111","files_new":1,"files_changed":0,"files_unmodified":0,"data_added":10}`)
	case "repo-auth-fail":
		if isCat {
			fmt.Fprintln(os.Stderr, "Fatal: wrong password or no key found")
			os.Exit(1)
		}
	case "repo-unavailable":
		if isCat {
			fmt.Fprintln(os.Stderr, "Fatal: unable to open repository: connection refused")
			os.Exit(1)
		}
	case "backup-locked":
		if isCat {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "Fatal: unable to create lock in backend: repository is already locked")
		os.Exit(1)
	case "backup-disk-full":
		if isCat {
			os.Exit(0)
		}
		fmt.Fprintln(os.Stderr, "Fatal: write backend: no space left on device")
		os.Exit(1)
	case "restore-partial-sleep":
		if isCat {
			os.Exit(0)
		}
		target := helperArgAfter("--target")
		if target == "" {
			fmt.Fprintln(os.Stderr, "missing --target")
			os.Exit(2)
		}
		if err := os.MkdirAll(target, 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if err := os.WriteFile(target+string(os.PathSeparator)+"partial.txt", []byte("partial restore\n"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		fmt.Println("restored /partial.txt")
		time.Sleep(30 * time.Second)
	}
	os.Exit(0)
}

func helperHasArg(want string) bool {
	for _, arg := range os.Args[1:] {
		if arg == want {
			return true
		}
	}
	return false
}

func helperArgAfter(flag string) string {
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == flag {
			return os.Args[i+1]
		}
	}
	return ""
}

// helperProcessArgs returns the resticPath/env/args triple that invokes this
// same test binary as a fake restic process running in the given HELPER_MODE.
func helperProcessArgs(mode string) (resticPath string, env []string, args []string) {
	env = append(os.Environ(), "GO_WANT_HELPER_PROCESS=1", "HELPER_MODE="+mode)
	return os.Args[0], env, []string{"-test.run=^TestHelperProcess$"}
}
