package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxRecoverySnapshots = 250
	maxBrowseEntries     = 1000
	maxRestoreLogs       = 400
	maxRecoveryLine      = 2 * 1024 * 1024
)

var snapshotIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8,64}$`)
var restoreRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type recoverySnapshot struct {
	ID       string   `json:"id"`
	ShortID  string   `json:"shortId,omitempty"`
	Time     string   `json:"time"`
	Hostname string   `json:"hostname,omitempty"`
	Paths    []string `json:"paths,omitempty"`
	Tags     []string `json:"tags,omitempty"`
}

type resticSnapshotJSON struct {
	ID       string   `json:"id"`
	ShortID  string   `json:"short_id"`
	Time     string   `json:"time"`
	Hostname string   `json:"hostname"`
	Paths    []string `json:"paths"`
	Tags     []string `json:"tags"`
}

type browseEntry struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	NodeType    string `json:"nodeType"`
	Size        int64  `json:"size,omitempty"`
	Mtime       string `json:"mtime,omitempty"`
	Permissions string `json:"permissions,omitempty"`
}

type browseResult struct {
	SnapshotID string        `json:"snapshotId"`
	Path       string        `json:"path"`
	Entries    []browseEntry `json:"entries"`
	EntryLimit int           `json:"entryLimit"`
	Truncated  bool          `json:"truncated"`
}

type resticBrowseJSON struct {
	MessageType string `json:"message_type"`
	StructType  string `json:"struct_type"`
	Path        string `json:"path"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	Size        int64  `json:"size"`
	Mtime       string `json:"mtime"`
	Permissions string `json:"permissions"`
}

type restoreResult struct {
	Target               string   `json:"target"`
	DryRun               bool     `json:"dryRun"`
	Restored             int64    `json:"restored"`
	Updated              int64    `json:"updated"`
	Unchanged            int64    `json:"unchanged"`
	ChangedLogs          []string `json:"changedLogs,omitempty"`
	ChangedLogsTruncated bool     `json:"changedLogsTruncated"`
	Err                  error    `json:"-"`
}

func listRecoverySnapshots(cfg config, deviceID string) ([]recoverySnapshot, error) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" || strings.ContainsAny(deviceID, "\r\n\x00") {
		return nil, errors.New("device id is invalid")
	}
	if err := validateRepositoryConfig(cfg); err != nil {
		return nil, redactBackupError(cfg, err)
	}
	env := recoveryEnvironment(cfg)
	if err := ensureRepository(cfg.ResticPath, env, cfg.Repository, false); err != nil {
		return nil, redactBackupError(cfg, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, cfg.ResticPath,
		"snapshots", "--json", "--latest", fmt.Sprint(maxRecoverySnapshots), "--group-by", "", "--tag", "nexus-workstation:"+deviceID,
	)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, redactBackupError(cfg, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, redactBackupError(cfg, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, redactBackupError(cfg, err)
	}
	stderrDone := readBoundedAsync(stderr, 64*1024)
	var raw []resticSnapshotJSON
	decodeErr := json.NewDecoder(io.LimitReader(stdout, 4*1024*1024)).Decode(&raw)
	waitErr := cmd.Wait()
	stderrText := <-stderrDone
	if ctx.Err() != nil {
		return nil, redactBackupError(cfg, fmt.Errorf("restic snapshots timed out: %w", ctx.Err()))
	}
	if waitErr != nil {
		return nil, redactBackupError(cfg, fmt.Errorf("restic snapshots: %s", commandErrorText(stderrText, waitErr)))
	}
	if decodeErr != nil {
		return nil, redactBackupError(cfg, fmt.Errorf("decode restic snapshots: %w", decodeErr))
	}
	if len(raw) > maxRecoverySnapshots {
		raw = raw[len(raw)-maxRecoverySnapshots:]
	}
	result := make([]recoverySnapshot, 0, len(raw))
	for _, item := range raw {
		id, err := validateSnapshotID(item.ID)
		if err != nil {
			return nil, fmt.Errorf("restic returned invalid snapshot id: %w", err)
		}
		if !validISOTime(item.Time) {
			return nil, fmt.Errorf("restic returned invalid snapshot time for %s", shortID(id))
		}
		result = append(result, recoverySnapshot{
			ID:       id,
			ShortID:  boundedOptional(item.ShortID, 64),
			Time:     item.Time,
			Hostname: boundedOptional(item.Hostname, 128),
			Paths:    boundedStringList(item.Paths, 32, 4096),
			Tags:     boundedStringList(item.Tags, 32, 128),
		})
	}
	return result, nil
}

func browseRecoverySnapshot(cfg config, snapshotID, snapshotPath string) (browseResult, error) {
	id, err := validateSnapshotID(snapshotID)
	if err != nil {
		return browseResult{}, err
	}
	selectedPath, err := validateSnapshotPath(snapshotPath)
	if err != nil {
		return browseResult{}, err
	}
	if err := validateRepositoryConfig(cfg); err != nil {
		return browseResult{}, redactBackupError(cfg, err)
	}
	env := recoveryEnvironment(cfg)
	if err := ensureRepository(cfg.ResticPath, env, cfg.Repository, false); err != nil {
		return browseResult{}, redactBackupError(cfg, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, cfg.ResticPath, "ls", "--json", id, selectedPath)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return browseResult{}, redactBackupError(cfg, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return browseResult{}, redactBackupError(cfg, err)
	}
	if err := cmd.Start(); err != nil {
		return browseResult{}, redactBackupError(cfg, err)
	}
	stderrDone := readBoundedAsync(stderr, 64*1024)
	result := browseResult{SnapshotID: id, Path: selectedPath, EntryLimit: maxBrowseEntries, Entries: make([]browseEntry, 0)}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxRecoveryLine)
	for scanner.Scan() {
		var node resticBrowseJSON
		if err := json.Unmarshal(scanner.Bytes(), &node); err != nil {
			continue
		}
		if node.MessageType != "node" && node.StructType != "node" {
			continue
		}
		if len(result.Entries) >= maxBrowseEntries {
			result.Truncated = true
			continue
		}
		entryPath, err := validateSnapshotPath(node.Path)
		if err != nil {
			return browseResult{}, fmt.Errorf("restic returned invalid browse path: %w", err)
		}
		name := node.Name
		if name == "" {
			name = path.Base(entryPath)
		}
		if len(name) > 1024 || strings.ContainsAny(name, "\r\n\x00") {
			return browseResult{}, errors.New("restic returned invalid browse name")
		}
		result.Entries = append(result.Entries, browseEntry{
			Path: entryPath, Name: name, NodeType: boundedOptional(node.Type, 32), Size: node.Size,
			Mtime: boundedOptional(node.Mtime, 64), Permissions: boundedOptional(node.Permissions, 32),
		})
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()
	stderrText := <-stderrDone
	if ctx.Err() != nil {
		return browseResult{}, redactBackupError(cfg, fmt.Errorf("restic ls timed out: %w", ctx.Err()))
	}
	if scanErr != nil {
		return browseResult{}, redactBackupError(cfg, fmt.Errorf("read restic ls output: %w", scanErr))
	}
	if waitErr != nil {
		return browseResult{}, redactBackupError(cfg, fmt.Errorf("restic ls: %s", commandErrorText(stderrText, waitErr)))
	}
	sort.SliceStable(result.Entries, func(i, j int) bool {
		leftDir := result.Entries[i].NodeType == "dir"
		rightDir := result.Entries[j].NodeType == "dir"
		if leftDir != rightDir {
			return leftDir
		}
		return strings.ToLower(result.Entries[i].Name) < strings.ToLower(result.Entries[j].Name)
	})
	return result, nil
}

func previewRecoveryRestore(cfg config, restoreRoot, runID, snapshotID, includePath string) restoreResult {
	return runRecoveryRestore(cfg, restoreRoot, runID, snapshotID, includePath, true)
}

func executeRecoveryRestore(cfg config, restoreRoot, runID, snapshotID, includePath string) restoreResult {
	return runRecoveryRestore(cfg, restoreRoot, runID, snapshotID, includePath, false)
}

func runRecoveryRestore(cfg config, restoreRoot, runID, snapshotID, includePath string, dryRun bool) restoreResult {
	started := restoreResult{DryRun: dryRun}
	id, err := validateSnapshotID(snapshotID)
	if err != nil {
		started.Err = err
		return started
	}
	selectedPath := ""
	if includePath != "" {
		selectedPath, err = validateSnapshotPath(includePath)
		if err != nil {
			started.Err = err
			return started
		}
	}
	target, err := recoveryRestoreTarget(restoreRoot, runID)
	if err != nil {
		started.Err = err
		return started
	}
	started.Target = target
	if err := validateRepositoryConfig(cfg); err != nil {
		started.Err = redactBackupError(cfg, err)
		return started
	}
	env := recoveryEnvironment(cfg)
	if err := ensureRepository(cfg.ResticPath, env, cfg.Repository, false); err != nil {
		started.Err = redactBackupError(cfg, err)
		return started
	}
	if !dryRun {
		if _, err := os.Stat(target); err == nil {
			started.Err = errors.New("restore staging target already exists")
			return started
		} else if !errors.Is(err, os.ErrNotExist) {
			started.Err = fmt.Errorf("inspect restore staging target: %w", err)
			return started
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			started.Err = fmt.Errorf("create restore staging root: %w", err)
			return started
		}
	}

	args := []string{"restore", id, "--target", target}
	if dryRun {
		args = append(args, "--dry-run")
	}
	args = append(args, "--verbose=2", "--overwrite", "never")
	if selectedPath != "" {
		args = append(args, "--include", selectedPath)
	}
	result := runRestoreCommand(cfg.ResticPath, env, args, target, dryRun)
	if result.Err != nil {
		result.Err = redactBackupError(cfg, result.Err)
	}
	return result
}

func runRestoreCommand(resticPath string, env, args []string, target string, dryRun bool) restoreResult {
	result := restoreResult{Target: target, DryRun: dryRun, ChangedLogs: make([]string, 0)}
	cmd := exec.Command(resticPath, args...)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		result.Err = err
		return result
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		result.Err = err
		return result
	}
	if err := cmd.Start(); err != nil {
		result.Err = err
		return result
	}

	type line struct { text string; stderr bool }
	lines := make(chan line, 128)
	var wg sync.WaitGroup
	readPipe := func(reader io.Reader, isStderr bool) {
		defer wg.Done()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), maxRecoveryLine)
		for scanner.Scan() {
			lines <- line{text: scanner.Text(), stderr: isStderr}
		}
	}
	wg.Add(2)
	go readPipe(stdout, false)
	go readPipe(stderr, true)
	go func() { wg.Wait(); close(lines) }()

	var stderrText strings.Builder
	for item := range lines {
		text := strings.TrimSpace(item.text)
		if text == "" {
			continue
		}
		if item.stderr && stderrText.Len() < 64*1024 {
			remaining := 64*1024 - stderrText.Len()
			if len(text) > remaining { text = text[:remaining] }
			stderrText.WriteString(text)
			stderrText.WriteByte('\n')
		}
		lower := strings.ToLower(text)
		switch {
		case strings.HasPrefix(lower, "restored "):
			result.Restored++
		case strings.HasPrefix(lower, "updated "):
			result.Updated++
		case strings.HasPrefix(lower, "unchanged "):
			result.Unchanged++
		default:
			continue
		}
		if len(result.ChangedLogs) < maxRestoreLogs {
			if len(text) > 2048 { text = text[:2048] + " [truncated]" }
			result.ChangedLogs = append(result.ChangedLogs, text)
		} else {
			result.ChangedLogsTruncated = true
		}
	}
	waitErr := cmd.Wait()
	if waitErr != nil {
		result.Err = fmt.Errorf("restic restore: %s", commandErrorText(stderrText.String(), waitErr))
	}
	return result
}

func recoveryRestoreTarget(root, runID string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("restore root is required")
	}
	if !restoreRunIDPattern.MatchString(runID) {
		return "", errors.New("restore run id is invalid")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve restore root: %w", err)
	}
	target := filepath.Join(absoluteRoot, runID)
	relative, err := filepath.Rel(absoluteRoot, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("restore target escapes staging root")
	}
	return target, nil
}

func validateSnapshotID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !snapshotIDPattern.MatchString(value) {
		return "", errors.New("snapshot id must be 8-64 hexadecimal characters")
	}
	return strings.ToLower(value), nil
}

func validateSnapshotPath(value string) (string, error) {
	if value == "" || len(value) > 4096 || !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\r\n\x00") {
		return "", errors.New("snapshot path must be an absolute restic path")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return "", errors.New("snapshot path contains a dot segment")
		}
	}
	return value, nil
}

func recoveryEnvironment(cfg config) []string {
	return append(os.Environ(), "RESTIC_REPOSITORY="+cfg.Repository, "RESTIC_PASSWORD_FILE="+cfg.PasswordFile)
}

func readBoundedAsync(reader io.Reader, limit int64) <-chan string {
	result := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(io.LimitReader(reader, limit))
		result <- string(data)
	}()
	return result
}

func commandErrorText(stderr string, err error) string {
	if text := strings.TrimSpace(stderr); text != "" {
		return text
	}
	if err != nil { return err.Error() }
	return "command failed without output"
}

func boundedOptional(value string, max int) string {
	if len(value) > max { return value[:max] }
	return value
}

func boundedStringList(values []string, maxItems, maxLength int) []string {
	if len(values) > maxItems { values = values[:maxItems] }
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.ContainsAny(value, "\r\n\x00") { continue }
		if len(value) > maxLength { value = value[:maxLength] }
		result = append(result, value)
	}
	return result
}

func validISOTime(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}
