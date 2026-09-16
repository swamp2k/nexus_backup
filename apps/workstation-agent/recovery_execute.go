package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxRecoveryReportEntries = 128
	maxRecoveryReportLogs    = 128
)

func (a *agent) execute(run workstationRun) {
	operation := strings.TrimSpace(run.Operation)
	if operation == "" || operation == "backup" {
		a.executeBackup(run)
		return
	}
	a.executeRecovery(run, operation)
}

func (a *agent) executeRecovery(run workstationRun, operation string) {
	logPrefix := fmt.Sprintf("workstation %s run %s", operation, run.ID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Same rule as backup: only an explicit stale-lease rejection (409) stops
	// local work. A restore in particular must never be left to finish
	// unobserved after the controller has moved on, even though it is never
	// auto-retried either way (write restore is always manual-retry-only).
	onLeaseResponse := func(err error) {
		if err != nil && isStaleLease(err) {
			fmt.Printf("%s lease rejected as stale; cancelling local operation\n", logPrefix)
			cancel()
		}
	}

	// TreeSize has its own throttled progress stream (files/folders/bytes/current
	// path), which also renews the lease. Do not overwrite that useful payload
	// every 60 seconds with a phase-only heartbeat. Other recovery operations
	// retain the generic lease heartbeat.
	heartbeatStop := make(chan struct{})
	heartbeatDone := make(chan struct{})
	if operation == "source-scan" {
		close(heartbeatDone)
	} else {
		go func() {
			defer close(heartbeatDone)
			ticker := time.NewTicker(60 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-heartbeatStop:
					return
				case <-ticker.C:
					err := a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: operation})
					if err != nil {
						fmt.Printf("%s lease heartbeat failed: %v\n", logPrefix, err)
					}
					onLeaseResponse(err)
				}
			}
		}()
	}

	onLeaseResponse(a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: operation}))
	result, err := a.runRecoveryOperation(ctx, run, operation)
	close(heartbeatStop)
	<-heartbeatDone

	status := "success"
	errText := ""
	if err != nil {
		status = "failure"
		errText = err.Error()
	}
	if finishErr := a.client.finishRun(run.ID, run.LeaseToken, status, result, errText); finishErr != nil {
		fmt.Printf("%s result report failed: %v\n", logPrefix, finishErr)
	}
}

func (a *agent) runRecoveryOperation(ctx context.Context, run workstationRun, operation string) (map[string]any, error) {
	switch operation {
	case "source-scan":
		result, err := scanSourceTree(ctx, run.Request.Drives, func(progress sourceScanProgress) error {
			reportErr := a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{
				Phase: "source-scan", BytesDone: progress.Bytes, FilesDone: progress.Files,
				DirectoriesDone: progress.Directories, CurrentPath: progress.CurrentPath,
			})
			if reportErr != nil {
				if isStaleLease(reportErr) {
					return reportErr
				}
				fmt.Printf("workstation source-scan run %s progress report failed: %v\n", run.ID, reportErr)
			}
			return nil
		})
		if err != nil {
			return map[string]any{"operation": operation, "drives": run.Request.Drives}, err
		}
		nodes := make([]map[string]any, 0, len(result.Nodes))
		for _, node := range result.Nodes {
			nodes = append(nodes, map[string]any{
				"path": node.Path, "parent": node.Parent, "name": node.Name, "bytes": node.Bytes,
				"files": node.Files, "directories": node.Directories, "inaccessible": node.Inaccessible,
			})
		}
		return map[string]any{"operation": operation, "drives": result.Drives, "nodes": nodes, "truncated": result.Truncated}, nil

	case "check":
		if err := checkWorkstationRepository(ctx, a.cfg); err != nil {
			return map[string]any{"operation": operation}, err
		}
		return map[string]any{
			"operation": operation,
			"integrity": "ok",
		}, nil

	case "inventory":
		snapshots, err := listRecoverySnapshots(ctx, a.cfg, run.DeviceID)
		if err != nil {
			return map[string]any{"operation": operation}, err
		}
		compact := make([]map[string]any, 0, len(snapshots))
		for _, snapshot := range snapshots {
			compact = append(compact, map[string]any{
				"id":       snapshot.ID,
				"shortId":  snapshot.ShortID,
				"time":     snapshot.Time,
				"hostname": snapshot.Hostname,
			})
		}
		return map[string]any{
			"operation": operation,
			"snapshots": compact,
		}, nil

	case "browse":
		result, err := browseRecoverySnapshot(ctx, a.cfg, run.Request.SnapshotID, run.Request.Path)
		if err != nil {
			return map[string]any{"operation": operation}, err
		}
		entries := result.Entries
		truncated := result.Truncated
		if len(entries) > maxRecoveryReportEntries {
			entries = entries[:maxRecoveryReportEntries]
			truncated = true
		}
		return map[string]any{
			"operation":  operation,
			"snapshotId": result.SnapshotID,
			"path":       result.Path,
			"entries":    entries,
			"entryLimit": maxRecoveryReportEntries,
			"truncated":  truncated,
		}, nil

	case "restore-preview", "restore":
		restoreRoot := filepath.Join(filepath.Dir(a.configPath), "restores")
		var result restoreResult
		if operation == "restore-preview" {
			result = previewRecoveryRestore(ctx, a.cfg, restoreRoot, run.ID, run.Request.SnapshotID, run.Request.Path)
		} else {
			result = executeRecoveryRestore(ctx, a.cfg, restoreRoot, run.ID, run.Request.SnapshotID, run.Request.Path)
		}
		logs := result.ChangedLogs
		logsTruncated := result.ChangedLogsTruncated
		if len(logs) > maxRecoveryReportLogs {
			logs = logs[:maxRecoveryReportLogs]
			logsTruncated = true
		}
		payload := map[string]any{
			"operation":            operation,
			"snapshotId":           strings.ToLower(strings.TrimSpace(run.Request.SnapshotID)),
			"path":                 run.Request.Path,
			"stagingId":            run.ID,
			"dryRun":               result.DryRun,
			"restored":             result.Restored,
			"updated":              result.Updated,
			"unchanged":            result.Unchanged,
			"changedLogs":          logs,
			"changedLogsTruncated": logsTruncated,
		}
		if result.Err != nil {
			return payload, result.Err
		}
		return payload, nil

	default:
		return map[string]any{"operation": operation}, fmt.Errorf("unsupported workstation operation %q", operation)
	}
}
