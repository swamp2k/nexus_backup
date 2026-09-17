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
	nodes := make([]map[string]any, 0, len(result.Nodes))
	for _, node := range result.Nodes {
		nodes = append(nodes, map[string]any{"path": node.Path, "parent": node.Parent, "name": node.Name, "bytes": node.Bytes, "files": node.Files, "directories": node.Directories, "inaccessible": node.Inaccessible})
	}
	_ = a.client.finishRun(run.ID, run.LeaseToken, "success", map[string]any{"operation": operation, "drives": result.Drives, "nodes": nodes, "truncated": result.Truncated}, "")
}
