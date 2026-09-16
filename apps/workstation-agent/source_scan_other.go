//go:build !windows

package main

import "os"

func availableDriveRoots() []string          { return nil }
func isSourceReparse(entry os.DirEntry) bool { return false }
