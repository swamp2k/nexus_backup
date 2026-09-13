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
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procGetCurrentProcess        = kernel32.NewProc("GetCurrentProcess")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
	agentJobOnce                 sync.Once
	agentJobHandle               syscall.Handle
	agentJobErr                  error
)

// initializeAgentProcessTree places the workstation agent itself in a Windows
// Job Object with KILL_ON_JOB_CLOSE. Descendants inherit job membership, so a
// Scheduled Task stop, crash, update or hard agent restart cannot leave an
// orphaned restic.exe continuing against a repository or staging directory.
// The handle intentionally stays open for the lifetime of the agent process.
func initializeAgentProcessTree() error {
	agentJobOnce.Do(func() {
		rawJob, _, createErr := procCreateJobObjectW.Call(0, 0)
		if rawJob == 0 {
			agentJobErr = windowsCallError(createErr)
			return
		}
		job := syscall.Handle(rawJob)

		info := jobObjectExtendedLimitInfo{}
		info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
		ret, _, setErr := procSetInformationJobObject.Call(
			uintptr(job),
			uintptr(jobObjectExtendedLimitInformation),
			uintptr(unsafe.Pointer(&info)),
			unsafe.Sizeof(info),
		)
		if ret == 0 {
			_ = syscall.CloseHandle(job)
			agentJobErr = windowsCallError(setErr)
			return
		}

		currentProcess, _, currentErr := procGetCurrentProcess.Call()
		if currentProcess == 0 {
			_ = syscall.CloseHandle(job)
			agentJobErr = windowsCallError(currentErr)
			return
		}
		ret, _, assignErr := procAssignProcessToJobObject.Call(uintptr(job), currentProcess)
		if ret == 0 {
			_ = syscall.CloseHandle(job)
			agentJobErr = windowsCallError(assignErr)
			return
		}
		agentJobHandle = job
	})
	return agentJobErr
}

func configureProcessTree(cmd *exec.Cmd) {
	// Individual children are already contained because the agent itself is in
	// a kill-on-close Job Object. Explicit cancellation still uses taskkill /T.
}

func bindProcessTree(cmd *exec.Cmd) error { return nil }
func releaseProcessTree(cmd *exec.Cmd)    {}

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

func terminateAllAgentChildrenForTest() error {
	if agentJobHandle == 0 {
		return errors.New("agent job object is not initialized")
	}
	ret, _, err := procTerminateJobObject.Call(uintptr(agentJobHandle), 1)
	if ret == 0 {
		return windowsCallError(err)
	}
	return nil
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
