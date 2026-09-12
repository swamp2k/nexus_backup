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
	"sync"
	"time"
)

type backupResult struct {
	SnapshotID       string
	FilesNew         int64
	FilesChanged     int64
	FilesUnmodified  int64
	DataAdded        int64
	Duration         time.Duration
	Partial          bool
	Err              error
}

type resticJSON struct {
	MessageType       string   `json:"message_type"`
	PercentDone       float64  `json:"percent_done"`
	TotalBytes        int64    `json:"total_bytes"`
	BytesDone         int64    `json:"bytes_done"`
	TotalFiles        int64    `json:"total_files"`
	FilesDone         int64    `json:"files_done"`
	CurrentFiles      []string `json:"current_files"`
	SnapshotID        string   `json:"snapshot_id"`
	FilesNew          int64    `json:"files_new"`
	FilesChanged      int64    `json:"files_changed"`
	FilesUnmodified   int64    `json:"files_unmodified"`
	DataAdded         int64    `json:"data_added"`
	Error             string   `json:"error"`
	During            string   `json:"during"`
	Item              string   `json:"item"`
}

func executeResticBackup(cfg config, run workstationRun, report func(backupProgress)) backupResult {
	started := time.Now()
	if err := validateRun(run); err != nil {
		return backupResult{Duration: time.Since(started), Err: err}
	}
	if err := validateRepositoryConfig(cfg); err != nil {
		return backupResult{Duration: time.Since(started), Err: err}
	}
	env := append(os.Environ(),
		"RESTIC_REPOSITORY="+cfg.Repository,
		"RESTIC_PASSWORD_FILE="+cfg.PasswordFile,
	)
	if cfg.AutoInit {
		if err := ensureRepository(cfg.ResticPath, env); err != nil {
			return backupResult{Duration: time.Since(started), Err: err}
		}
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

	result := runBackupCommand(cfg.ResticPath, env, args, report)
	result.Duration = time.Since(started)
	if result.Err != nil {
		return result
	}
	if err := applyRetention(cfg.ResticPath, env, tag, run.Retention); err != nil {
		result.Err = fmt.Errorf("retention: %w", err)
	}
	return result
}

func runBackupCommand(resticPath string, env, args []string, report func(backupProgress)) backupResult {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, resticPath, args...)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return backupResult{Err: err}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return backupResult{Err: err}
	}
	if err := cmd.Start(); err != nil {
		return backupResult{Err: err}
	}

	var mu sync.Mutex
	var stderrText strings.Builder
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(&limitedWriter{w: &stderrText, remaining: 64 * 1024}, stderr)
	}()

	var result backupResult
	var parseErr error
	lastReport := time.Time{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var message resticJSON
		if err := json.Unmarshal(line, &message); err != nil {
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
			mu.Lock()
			if message.Error != "" {
				if stderrText.Len() > 0 {
					stderrText.WriteString("; ")
				}
				stderrText.WriteString(message.Error)
			}
			mu.Unlock()
		}
	}
	if err := scanner.Err(); err != nil {
		parseErr = err
	}
	waitErr := cmd.Wait()
	<-stderrDone
	if parseErr != nil {
		return backupResult{Err: fmt.Errorf("read restic output: %w", parseErr)}
	}
	if waitErr != nil {
		message := strings.TrimSpace(stderrText.String())
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

func ensureRepository(resticPath string, env []string) error {
	check := exec.Command(resticPath, "cat", "config")
	check.Env = env
	if err := check.Run(); err == nil {
		return nil
	}
	initCmd := exec.Command(resticPath, "init")
	initCmd.Env = env
	output, err := initCmd.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if len(text) > 4000 {
			text = text[:4000]
		}
		return fmt.Errorf("initialize restic repository: %s", text)
	}
	return nil
}

func applyRetention(resticPath string, env []string, tag string, retention retentionPolicy) error {
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
	cmd := exec.Command(resticPath, args...)
	cmd.Env = env
	output, err := cmd.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if len(text) > 4000 {
			text = text[:4000]
		}
		return fmt.Errorf("restic forget/prune: %s", text)
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
	return nil
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
