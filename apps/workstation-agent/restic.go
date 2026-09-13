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
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type backupResult struct {
	SnapshotID      string
	FilesNew        int64
	FilesChanged    int64
	FilesUnmodified int64
	DataAdded       int64
	Duration        time.Duration
	Partial         bool
	Cancelled       bool
	Err             error
}

type resticJSON struct {
	MessageType     string   `json:"message_type"`
	PercentDone     float64  `json:"percent_done"`
	TotalBytes      int64    `json:"total_bytes"`
	BytesDone       int64    `json:"bytes_done"`
	TotalFiles      int64    `json:"total_files"`
	FilesDone       int64    `json:"files_done"`
	CurrentFiles    []string `json:"current_files"`
	SnapshotID      string   `json:"snapshot_id"`
	FilesNew        int64    `json:"files_new"`
	FilesChanged    int64    `json:"files_changed"`
	FilesUnmodified int64    `json:"files_unmodified"`
	DataAdded       int64    `json:"data_added"`
	Error           string   `json:"error"`
}

func executeResticBackup(ctx context.Context, cfg config, run workstationRun, report func(backupProgress)) backupResult {
	started := time.Now()
	if err := validateRun(run); err != nil {
		return backupResult{Duration: time.Since(started), Err: err}
	}
	if err := validateRepositoryConfig(cfg); err != nil {
		return backupResult{Duration: time.Since(started), Err: redactBackupError(cfg, err)}
	}
	env := append(os.Environ(),
		"RESTIC_REPOSITORY="+cfg.Repository,
		"RESTIC_PASSWORD_FILE="+cfg.PasswordFile,
	)
	allowInit := cfg.AutoInit && (localRepositoryPath(cfg.Repository) != "" || isPinnedManagedRestRepository(cfg))
	if err := ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, allowInit); err != nil {
		result := backupResult{Duration: time.Since(started), Err: redactBackupError(cfg, err)}
		if ctx.Err() != nil {
			result.Cancelled = true
		}
		return result
	}

	hostname, _ := os.Hostname()
	tag := "nexus-workstation:" + run.DeviceID
	args := []string{"backup", "--json", "--host", hostname, "--tag", tag}
	if runtime.GOOS == "windows" {
		args = append(args, "--use-fs-snapshot")
	}
	for _, pattern := range run.ExcludePatterns {
		args = append(args, "--exclude", pattern)
	}
	args = append(args, run.SourcePaths...)

	result := runBackupCommand(ctx, cfg.ResticPath, env, args, report)
	result.Duration = time.Since(started)
	if result.Cancelled {
		return result
	}
	if result.Err != nil {
		result.Err = redactBackupError(cfg, result.Err)
		return result
	}
	// A stale lease can still arrive between the backup finishing and retention
	// starting; skip retention rather than risk pruning under a revoked lease.
	if ctx.Err() != nil {
		result.Cancelled = true
		result.Err = fmt.Errorf("run cancelled: %w", ctx.Err())
		return result
	}
	if err := applyRetentionContext(ctx, cfg.ResticPath, env, tag, run.Retention); err != nil {
		if ctx.Err() != nil {
			result.Cancelled = true
			result.Err = fmt.Errorf("retention cancelled: %w", ctx.Err())
			return result
		}
		result.Err = redactBackupError(cfg, fmt.Errorf("retention: %w", err))
	}
	return result
}

func runBackupCommand(ctx context.Context, resticPath string, env, args []string, report func(backupProgress)) backupResult {
	cmd := commandContextWithTree(ctx, resticPath, args...)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return backupResult{Err: err}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return backupResult{Err: err}
	}
	if err := startCommandTree(cmd); err != nil {
		return backupResult{Err: err}
	}

	stderrDone := make(chan string, 1)
	go func() {
		var text strings.Builder
		_, _ = io.Copy(&limitedWriter{w: &text, remaining: 64 * 1024}, stderr)
		stderrDone <- text.String()
	}()

	var result backupResult
	var parseErr error
	var resticErrors []string
	lastReport := time.Time{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		var message resticJSON
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		switch message.MessageType {
		case "status":
			progress := backupProgress{
				Phase:      "backing-up",
				Percent:    message.PercentDone * 100,
				BytesDone:  message.BytesDone,
				BytesTotal: message.TotalBytes,
				FilesDone:  message.FilesDone,
				FilesTotal: message.TotalFiles,
			}
			if len(message.CurrentFiles) > 0 {
				progress.CurrentPath = message.CurrentFiles[0]
			}
			if report != nil && (lastReport.IsZero() || time.Since(lastReport) >= 2*time.Second || progress.Percent >= 99.9) {
				report(progress)
				lastReport = time.Now()
			}
		case "summary":
			result.SnapshotID = message.SnapshotID
			result.FilesNew = message.FilesNew
			result.FilesChanged = message.FilesChanged
			result.FilesUnmodified = message.FilesUnmodified
			result.DataAdded = message.DataAdded
		case "error":
			if message.Error != "" && len(resticErrors) < 20 {
				resticErrors = append(resticErrors, message.Error)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		parseErr = err
	}
	waitErr := waitCommandTree(cmd)
	stderrText := <-stderrDone
	if ctx.Err() != nil {
		return backupResult{Cancelled: true, Err: fmt.Errorf("restic backup cancelled: %w", ctx.Err())}
	}
	if parseErr != nil {
		return backupResult{Err: fmt.Errorf("read restic output: %w", parseErr)}
	}
	if waitErr != nil {
		parts := make([]string, 0, 2)
		if text := strings.TrimSpace(stderrText); text != "" {
			parts = append(parts, text)
		}
		if len(resticErrors) > 0 {
			parts = append(parts, strings.Join(resticErrors, "; "))
		}
		message := strings.TrimSpace(strings.Join(parts, "; "))
		if message == "" {
			message = waitErr.Error()
		}
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 3 {
			result.Partial = true
			result.Err = fmt.Errorf("restic partial backup: %s", message)
			return result
		}
		result.Err = fmt.Errorf("restic backup: %s", message)
		return result
	}
	if result.SnapshotID == "" {
		result.Err = errors.New("restic completed without returning a snapshot id")
	}
	if report != nil {
		report(backupProgress{Phase: "finalizing", Percent: 100})
	}
	return result
}

func ensureRepository(resticPath string, env []string, repository string, autoInit bool) error {
	return ensureRepositoryContext(context.Background(), resticPath, env, repository, autoInit)
}

func ensureRepositoryContext(ctx context.Context, resticPath string, env []string, repository string, autoInit bool) error {
	if local := localRepositoryPath(repository); local != "" {
		configPath := filepath.Join(local, "config")
		_, statErr := os.Stat(configPath)
		if errors.Is(statErr, os.ErrNotExist) {
			if !autoInit {
				return errors.New("local restic repository does not exist and autoInit is disabled")
			}
			initCmd := commandContextWithTree(ctx, resticPath, "init")
			initCmd.Env = env
			output, err := combinedOutputTree(initCmd)
			if ctx.Err() != nil {
				return fmt.Errorf("initialize local restic repository cancelled: %w", ctx.Err())
			}
			if err != nil {
				return fmt.Errorf("initialize local restic repository: %s", boundedText(output, 4000))
			}
			return nil
		}
		if statErr != nil {
			return fmt.Errorf("inspect local restic repository: %w", statErr)
		}
	}

	check := commandContextWithTree(ctx, resticPath, "cat", "config")
	check.Env = env
	output, err := combinedOutputTree(check)
	if ctx.Err() != nil {
		return fmt.Errorf("open restic repository cancelled: %w", ctx.Err())
	}
	if err == nil {
		return nil
	}
	if !autoInit {
		return fmt.Errorf("open restic repository: %s", boundedText(output, 4000))
	}

	initCmd := commandContextWithTree(ctx, resticPath, "init")
	initCmd.Env = env
	initOutput, initErr := combinedOutputTree(initCmd)
	if ctx.Err() != nil {
		return fmt.Errorf("initialize remote restic repository cancelled: %w", ctx.Err())
	}
	if initErr != nil {
		return fmt.Errorf("initialize remote restic repository: %s", boundedText(initOutput, 4000))
	}
	return nil
}

func localRepositoryPath(repository string) string {
	repository = strings.TrimSpace(repository)
	if repository == "" {
		return ""
	}
	if filepath.IsAbs(repository) || strings.HasPrefix(repository, `\\`) {
		return filepath.Clean(repository)
	}
	return ""
}

func applyRetention(resticPath string, env []string, tag string, retention retentionPolicy) error {
	return applyRetentionContext(context.Background(), resticPath, env, tag, retention)
}

func applyRetentionContext(ctx context.Context, resticPath string, env []string, tag string, retention retentionPolicy) error {
	if retention.KeepDaily == 0 && retention.KeepWeekly == 0 && retention.KeepMonthly == 0 {
		return nil
	}
	args := []string{"forget", "--tag", tag, "--group-by", "", "--prune"}
	if retention.KeepDaily > 0 {
		args = append(args, "--keep-daily", strconv.Itoa(retention.KeepDaily))
	}
	if retention.KeepWeekly > 0 {
		args = append(args, "--keep-weekly", strconv.Itoa(retention.KeepWeekly))
	}
	if retention.KeepMonthly > 0 {
		args = append(args, "--keep-monthly", strconv.Itoa(retention.KeepMonthly))
	}
	cmd := commandContextWithTree(ctx, resticPath, args...)
	cmd.Env = env
	output, err := combinedOutputTree(cmd)
	if ctx.Err() != nil {
		return fmt.Errorf("restic forget/prune cancelled: %w", ctx.Err())
	}
	if err != nil {
		return fmt.Errorf("restic forget/prune: %s", boundedText(output, 4000))
	}
	return nil
}

func validateRun(run workstationRun) error {
	if run.ID == "" || run.DeviceID == "" || run.LeaseToken == "" {
		return errors.New("workstation run is missing required identity")
	}
	if len(run.SourcePaths) == 0 || len(run.SourcePaths) > 32 {
		return errors.New("workstation run must contain 1-32 source paths")
	}
	for _, source := range run.SourcePaths {
		if strings.ContainsAny(source, "\r\n\x00") || !filepath.IsAbs(source) {
			return fmt.Errorf("source path must be absolute and newline-free: %q", source)
		}
	}
	if len(run.ExcludePatterns) > 128 {
		return errors.New("too many exclude patterns")
	}
	for _, pattern := range run.ExcludePatterns {
		if strings.ContainsAny(pattern, "\r\n\x00") {
			return errors.New("exclude pattern contains invalid characters")
		}
	}
	return nil
}

func validateRepositoryConfig(cfg config) error {
	if strings.TrimSpace(cfg.Repository) == "" {
		return errors.New("repository is not configured locally")
	}
	if strings.TrimSpace(cfg.PasswordFile) == "" {
		return errors.New("passwordFile is not configured locally")
	}
	content, err := os.ReadFile(cfg.PasswordFile)
	if err != nil {
		return fmt.Errorf("read restic password file: %w", err)
	}
	if strings.TrimSpace(string(content)) == "" {
		return errors.New("restic password file is empty")
	}
	if (strings.TrimSpace(cfg.RestUsername) == "") != (strings.TrimSpace(cfg.RestPassword) == "") {
		return errors.New("REST transport username and password must be configured together")
	}
	if cfg.RestUsername != "" && !strings.HasPrefix(strings.ToLower(cfg.Repository), "rest:https://") {
		return errors.New("REST transport credentials require a rest:https:// repository")
	}
	if cfg.CACertPath != "" {
		info, statErr := os.Stat(cfg.CACertPath)
		if statErr != nil {
			return fmt.Errorf("read repository CA certificate: %w", statErr)
		}
		if info.IsDir() || info.Size() == 0 {
			return errors.New("repository CA certificate must be a non-empty regular file")
		}
	}
	return applyResticTransportEnvironment(cfg)
}

func applyResticTransportEnvironment(cfg config) error {
	pairs := map[string]string{
		"RESTIC_REST_USERNAME": cfg.RestUsername,
		"RESTIC_REST_PASSWORD": cfg.RestPassword,
		"RESTIC_CACERT":        cfg.CACertPath,
	}
	for name, value := range pairs {
		if value == "" {
			if err := os.Unsetenv(name); err != nil { return fmt.Errorf("clear %s: %w", name, err) }
			continue
		}
		if err := os.Setenv(name, value); err != nil { return fmt.Errorf("set %s: %w", name, err) }
	}
	return nil
}

func isPinnedManagedRestRepository(cfg config) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(cfg.Repository)), "rest:https://") &&
		strings.TrimSpace(cfg.RestUsername) != "" && strings.TrimSpace(cfg.RestPassword) != "" && strings.TrimSpace(cfg.CACertPath) != ""
}

func redactBackupError(cfg config, err error) error {
	if err == nil {
		return nil
	}
	text := err.Error()
	for value, replacement := range map[string]string{
		strings.TrimSpace(cfg.Repository):   "[repository]",
		strings.TrimSpace(cfg.PasswordFile): "[password-file]",
		strings.TrimSpace(cfg.RestUsername): "[rest-user]",
		strings.TrimSpace(cfg.RestPassword): "[rest-password]",
		strings.TrimSpace(cfg.CACertPath):   "[ca-cert]",
	} {
		if value != "" {
			text = strings.ReplaceAll(text, value, replacement)
		}
	}
	return errors.New(text)
}

func boundedText(value []byte, max int) string {
	text := strings.TrimSpace(string(value))
	if text == "" {
		return "command failed without output"
	}
	if len(text) > max {
		return text[:max] + " [truncated]"
	}
	return text
}

type limitedWriter struct {
	w         io.Writer
	remaining int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	original := len(p)
	if w.remaining <= 0 {
		return original, nil
	}
	write := p
	if len(write) > w.remaining {
		write = write[:w.remaining]
	}
	_, err := w.w.Write(write)
	w.remaining -= len(write)
	return original, err
}
