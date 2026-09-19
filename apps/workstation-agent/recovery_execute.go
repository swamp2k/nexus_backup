package main

import (
	"context"
	"fmt"
)

// execute is intentionally limited to backup and source discovery. Inventory,
// integrity and restore operations are retired with the legacy
// repository model and must not be dispatched by a flat-file client.
func (a *agent) execute(run workstationRun) {
	operation := run.Operation
	if operation == "" || operation == "backup" {
		a.executeBackup(run)
		return
	}
	if operation != "source-scan" {
		_ = a.client.finishRun(run.ID, run.LeaseToken, "failure", map[string]any{"operation": operation}, fmt.Sprintf("operation %q is not supported by flat-file workstation clients", operation))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result, err := scanSourceTree(ctx, run.Request.Drives, func(progress sourceScanProgress) error {
		return a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: "source-scan", BytesDone: progress.Bytes, FilesDone: progress.Files, DirectoriesDone: progress.Directories, CurrentPath: progress.CurrentPath})
	})
	if err != nil {
		_ = a.client.finishRun(run.ID, run.LeaseToken, "failure", map[string]any{"operation": operation}, err.Error())
		return
	}
	if err := a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{
		Phase: "source-scan-upload",
		BytesDone: result.TotalBytes,
		FilesDone: result.FileCount,
		DirectoriesDone: result.DirectoryCount,
	}); err != nil {
		_ = a.client.finishRun(run.ID, run.LeaseToken, "failure", map[string]any{"operation": operation}, err.Error())
		return
	}
	if err := uploadSourceScanArtifact(ctx, a.client, run, result); err != nil {
		_ = a.client.finishRun(run.ID, run.LeaseToken, "failure", map[string]any{"operation": operation}, err.Error())
		return
	}
	_ = a.client.finishRun(run.ID, run.LeaseToken, "success", map[string]any{
		"operation": operation,
		"drives": result.Drives,
		"artifactFormat": "gzip-ndjson-v1",
		"schemaVersion": 1,
		"directoryCount": result.DirectoryCount,
		"fileCount": result.FileCount,
		"totalBytes": result.TotalBytes,
		"errorCount": result.ErrorCount,
		"truncated": result.Truncated,
	}, "")
}
