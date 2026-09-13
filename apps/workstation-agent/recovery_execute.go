package main

import (
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
	heartbeatStop := make(chan struct{})
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatStop:
				return
			case <-ticker.C:
				if err := a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: operation}); err != nil {
					fmt.Printf("%s lease heartbeat failed: %v\n", logPrefix, err)
				}
			}
		}
	}()

	_ = a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: operation})
	result, err := a.runRecoveryOperation(run, operation)
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

func (a *agent) runRecoveryOperation(run workstationRun, operation string) (map[string]any, error) {
	switch operation {
	case "inventory":
		snapshots, err := listRecoverySnapshots(a.cfg, run.DeviceID)
		if err != nil { return map[string]any{"operation": operation}, err }
		compact := make([]map[string]any, 0, len(snapshots))
		for _, snapshot := range snapshots {
			compact = append(compact, map[string]any{
				"id": snapshot.ID,
				"shortId": snapshot.ShortID,
				"time": snapshot.Time,
				"hostname": snapshot.Hostname,
			})
		}
		return map[string]any{
			"operation": operation,
			"snapshots": compact,
		}, nil

	case "browse":
		result, err := browseRecoverySnapshot(a.cfg, run.Request.SnapshotID, run.Request.Path)
		if err != nil { return map[string]any{"operation": operation}, err }
		entries := result.Entries
		truncated := result.Truncated
		if len(entries) > maxRecoveryReportEntries {
			entries = entries[:maxRecoveryReportEntries]
			truncated = true
		}
		return map[string]any{
			"operation": operation,
			"snapshotId": result.SnapshotID,
			"path": result.Path,
			"entries": entries,
			"entryLimit": maxRecoveryReportEntries,
			"truncated": truncated,
		}, nil

	case "restore-preview", "restore":
		restoreRoot := filepath.Join(filepath.Dir(a.configPath), "restores")
		var result restoreResult
		if operation == "restore-preview" {
			result = previewRecoveryRestore(a.cfg, restoreRoot, run.ID, run.Request.SnapshotID, run.Request.Path)
		} else {
			result = executeRecoveryRestore(a.cfg, restoreRoot, run.ID, run.Request.SnapshotID, run.Request.Path)
		}
		logs := result.ChangedLogs
		logsTruncated := result.ChangedLogsTruncated
		if len(logs) > maxRecoveryReportLogs {
			logs = logs[:maxRecoveryReportLogs]
			logsTruncated = true
		}
		payload := map[string]any{
			"operation": operation,
			"snapshotId": strings.ToLower(strings.TrimSpace(run.Request.SnapshotID)),
			"path": run.Request.Path,
			"stagingId": run.ID,
			"dryRun": result.DryRun,
			"restored": result.Restored,
			"updated": result.Updated,
			"unchanged": result.Unchanged,
			"changedLogs": logs,
			"changedLogsTruncated": logsTruncated,
		}
		if result.Err != nil { return payload, result.Err }
		return payload, nil

	default:
		return map[string]any{"operation": operation}, fmt.Errorf("unsupported workstation operation %q", operation)
	}
}
