package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

type runSnapshot struct {
	ID   string   `json:"id"`
	Tags []string `json:"tags"`
}

func backupRunTags(run workstationRun) (deviceTag, runTag, completeTag string, err error) {
	deviceID := strings.TrimSpace(run.DeviceID)
	runID := strings.TrimSpace(run.ID)
	if !safeTagIdentity(deviceID) {
		return "", "", "", errors.New("workstation device id cannot be represented safely as a restic tag")
	}
	if !safeTagIdentity(runID) {
		return "", "", "", errors.New("workstation run id cannot be represented safely as a restic tag")
	}
	return "nexus-workstation:" + deviceID, "nexus-run:" + runID, "nexus-run-complete:" + runID, nil
}

func safeTagIdentity(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// reconcileBackupRunSnapshotContext checks whether this exact Nexus run has
// already produced and locally confirmed a snapshot. This is what makes a
// re-leased backup idempotent after the controller was unreachable while the
// agent tried to report completion.
//
// A snapshot carrying the run tag without the completion tag is deliberately
// treated as ambiguous. It could be a partial backup or a process crash in the
// narrow window after Restic committed the snapshot but before Nexus recorded
// local completion. In that situation we refuse to create another snapshot
// automatically rather than guessing.
func reconcileBackupRunSnapshotContext(ctx context.Context, resticPath string, env []string, runTag, completeTag string) (string, error) {
	snapshots, err := snapshotsForRunTag(ctx, resticPath, env, runTag)
	if err != nil {
		return "", err
	}
	if len(snapshots) == 0 {
		return "", nil
	}
	if len(snapshots) != 1 {
		return "", fmt.Errorf("run tag %q matched %d snapshots; manual reconciliation required", runTag, len(snapshots))
	}
	snapshot := snapshots[0]
	if !hasTag(snapshot.Tags, completeTag) {
		return "", fmt.Errorf("run already has an unconfirmed snapshot %s; manual reconciliation required", shortID(snapshot.ID))
	}
	return snapshot.ID, nil
}

// confirmBackupRunSnapshotContext writes a second, explicit completion marker
// only after Restic backup returned a clean success. The tag command changes
// the snapshot object ID, so we re-resolve the run tag and return the current
// ID instead of handing the controller Restic's now-stale pre-tag ID.
func confirmBackupRunSnapshotContext(ctx context.Context, resticPath string, env []string, snapshotID, runTag, completeTag string) (string, error) {
	if strings.TrimSpace(snapshotID) == "" {
		return "", errors.New("cannot confirm backup run without a snapshot id")
	}
	cmd := commandContextWithTree(ctx, resticPath, "tag", "--add", completeTag, snapshotID)
	cmd.Env = env
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", fmt.Errorf("mark backup run complete cancelled: %w", ctx.Err())
	}
	if err != nil {
		return "", fmt.Errorf("mark backup run complete: %s", commandErrorText(string(output), err))
	}

	snapshots, err := snapshotsForRunTag(ctx, resticPath, env, runTag)
	if err != nil {
		return "", err
	}
	if len(snapshots) != 1 {
		return "", fmt.Errorf("confirmed run tag %q matched %d snapshots; manual reconciliation required", runTag, len(snapshots))
	}
	if !hasTag(snapshots[0].Tags, completeTag) {
		return "", errors.New("restic tag command completed but the completion marker is missing")
	}
	return snapshots[0].ID, nil
}

func snapshotsForRunTag(ctx context.Context, resticPath string, env []string, runTag string) ([]runSnapshot, error) {
	cmd := commandContextWithTree(ctx, resticPath, "snapshots", "--json", "--latest", "2", "--group-by", "", "--tag", runTag)
	cmd.Env = env
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("inspect backup run snapshot cancelled: %w", ctx.Err())
	}
	if err != nil {
		message := err.Error()
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			message = boundedText(exitErr.Stderr, 4000)
		}
		return nil, fmt.Errorf("inspect backup run snapshot: %s", message)
	}
	var snapshots []runSnapshot
	if err := json.Unmarshal(output, &snapshots); err != nil {
		return nil, fmt.Errorf("decode backup run snapshots: %w", err)
	}
	if len(snapshots) > 2 {
		return nil, errors.New("backup run snapshot query returned too many snapshots")
	}
	for i := range snapshots {
		id, err := validateSnapshotID(snapshots[i].ID)
		if err != nil {
			return nil, fmt.Errorf("backup run snapshot has invalid id: %w", err)
		}
		snapshots[i].ID = id
	}
	return snapshots, nil
}

func hasTag(tags []string, want string) bool {
	for _, tag := range tags {
		if tag == want {
			return true
		}
	}
	return false
}
