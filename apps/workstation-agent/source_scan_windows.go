//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

const (
	driveRemovable            = 2
	driveFixed                = 3
	driveRemote               = 4
	driveRamdisk              = 6
	fileAttributeReparsePoint = 0x00000400
)

var (
	scanKernel32         = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives = scanKernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW    = scanKernel32.NewProc("GetDriveTypeW")
)

func availableDriveRoots() []string {
	// GetLogicalDrives returns a bit mask; zero is the only failure sentinel.
	// syscall.Proc.Call's last-error value is not a reliable success indicator
	// for Windows APIs that do not define GetLastError on successful calls.
	mask, _, _ := procGetLogicalDrives.Call()
	if mask == 0 {
		return nil
	}
	roots := make([]string, 0, 8)
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		ptr, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		kind, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(ptr)))
		switch kind {
		case driveRemovable, driveFixed, driveRemote, driveRamdisk:
			roots = append(roots, root)
		}
	}
	return roots
}

func isSourceReparse(entry os.DirEntry) bool {
	info, err := entry.Info()
	if err != nil {
		return false
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && data.FileAttributes&fileAttributeReparsePoint != 0
}
