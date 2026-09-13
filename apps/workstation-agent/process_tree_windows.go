//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unsafe"
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
	processSetQuota                   = 0x0100
	processTerminate                  = 0x0001
)

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectExtendedLimitInfo struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

var (
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW        = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject      = kernel32.NewProc("TerminateJobObject")
	processTreeJobs             sync.Map // map[*exec.Cmd]syscall.Handle
)

func configureProcessTree(cmd *exec.Cmd) {
	// Binding happens immediately after Start, once the child PID is available.
}

func bindProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return errors.New("process has not started")
	}

	rawJob, _, createErr := procCreateJobObjectW.Call(0, 0)
	if rawJob == 0 {
		return windowsCallError(createErr)
	}
	job := syscall.Handle(rawJob)
	closeJob := true
	defer func() {
		if closeJob {
			_ = syscall.CloseHandle(job)
		}
	}()

	info := jobObjectExtendedLimitInfo{}
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ret, _, setErr := procSetInformationJobObject.Call(
		uintptr(job),
		uintptr(jobObjectExtendedLimitInformation),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ret == 0 {
		return windowsCallError(setErr)
	}

	process, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(cmd.Process.Pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	ret, _, assignErr := procAssignProcessToJobObject.Call(uintptr(job), uintptr(process))
	if ret == 0 {
		return windowsCallError(assignErr)
	}

	processTreeJobs.Store(cmd, job)
	closeJob = false
	return nil
}

func releaseProcessTree(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if value, ok := processTreeJobs.LoadAndDelete(cmd); ok {
		_ = syscall.CloseHandle(value.(syscall.Handle))
	}
}

func terminateProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	if value, ok := processTreeJobs.Load(cmd); ok {
		job := value.(syscall.Handle)
		ret, _, err := procTerminateJobObject.Call(uintptr(job), 1)
		if ret != 0 {
			return nil
		}
		if callErr := windowsCallError(err); callErr != nil {
			// Fall through to taskkill/direct kill. The job handle remains open
			// until Wait completes or the agent exits.
		}
	}

	pid := strconv.Itoa(cmd.Process.Pid)
	// /T terminates descendants and /F prevents a child console process from
	// keeping inherited pipes open after the controller revoked the lease.
	if err := exec.Command("taskkill", "/PID", pid, "/T", "/F").Run(); err == nil {
		return nil
	}
	return cmd.Process.Kill()
}

func windowsCallError(err error) error {
	if err == nil {
		return syscall.EINVAL
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == 0 {
		return syscall.EINVAL
	}
	return err
}
