package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

var version = "dev"

const defaultConfigName = "workstation.json"

type config struct {
	ServerURL     string `json:"serverUrl"`
	DeviceToken   string `json:"deviceToken"`
	Repository    string `json:"repository"`
	PasswordFile  string `json:"passwordFile"`
	ResticPath    string `json:"resticPath"`
	PollSeconds   int    `json:"pollSeconds"`
	ReportSeconds int    `json:"reportSeconds"`
	AutoInit      bool   `json:"autoInit"`
}

type localState struct {
	DeviceID       string `json:"deviceId,omitempty"`
	LastBackupAt   string `json:"lastBackupAt,omitempty"`
	LastSuccessAt  string `json:"lastSuccessAt,omitempty"`
	LastSnapshotID string `json:"lastSnapshotId,omitempty"`
	LastError      string `json:"lastError,omitempty"`
}

type agent struct {
	cfg        config
	configPath string
	statePath  string
	client     *apiClient
	mu         sync.Mutex
	state      localState
	runningID  string
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Printf("nexus-backup-workstation %s\n", version)
		return
	}
	cfgPath := configPathFromArgs(os.Args[1:])
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatal(err)
	}
	statePath := filepath.Join(filepath.Dir(cfgPath), "workstation-state.json")
	a := &agent{
		cfg:        cfg,
		configPath: cfgPath,
		statePath:  statePath,
		client:     newAPIClient(cfg.ServerURL, cfg.DeviceToken),
	}
	if state, err := loadState(statePath); err == nil {
		a.state = state
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("state load warning: %v", err)
	}
	if err := a.run(); err != nil {
		log.Fatal(err)
	}
}

func (a *agent) run() error {
	hostname, _ := os.Hostname()
	log.Printf("Nexus Backup workstation agent %s starting; server=%s host=%s", version, a.cfg.ServerURL, hostname)

	reportEvery := time.Duration(a.cfg.ReportSeconds) * time.Second
	pollEvery := time.Duration(a.cfg.PollSeconds) * time.Second
	if reportEvery <= 0 {
		reportEvery = 60 * time.Second
	}
	if pollEvery < 5*time.Second {
		pollEvery = 15 * time.Second
	}

	_ = a.report()
	_ = a.reportStatus()
	_ = a.pollOnce()

	reportTicker := time.NewTicker(reportEvery)
	pollTicker := time.NewTicker(pollEvery)
	defer reportTicker.Stop()
	defer pollTicker.Stop()

	for {
		select {
		case <-reportTicker.C:
			if err := a.report(); err != nil {
				log.Printf("report failed: %v", err)
			}
			if err := a.reportStatus(); err != nil {
				log.Printf("status report failed: %v", err)
			}
		case <-pollTicker.C:
			if err := a.pollOnce(); err != nil {
				log.Printf("poll failed: %v", err)
			}
		}
	}
}

func (a *agent) report() error {
	hostname, _ := os.Hostname()
	response, err := a.client.reportDevice(deviceReport{
		Version:      version,
		Hostname:     hostname,
		Platform:     runtime.GOOS + "/" + runtime.GOARCH,
		Capabilities: []string{"workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "restic.v1", "windows-vss.v1"},
	})
	if err != nil {
		return err
	}

	if response.DeviceToken != "" {
		if !strings.HasPrefix(response.DeviceToken, "nxbdev_") || len(response.DeviceToken) < 24 {
			return errors.New("server returned an invalid rotated device token")
		}
		// The enrollment token is intentionally one-shot. Persist the replacement
		// before the agent depends on it for status/poll requests and future restarts.
		a.cfg.DeviceToken = response.DeviceToken
		a.client.setToken(response.DeviceToken)
		if err := saveConfig(a.configPath, a.cfg); err != nil {
			return fmt.Errorf("persist rotated device token: %w", err)
		}
		log.Printf("workstation enrollment credential rotated and persisted")
	}

	if response.Device.ID != "" {
		a.mu.Lock()
		a.state.DeviceID = response.Device.ID
		state := a.state
		a.mu.Unlock()
		_ = saveState(a.statePath, state)
	}
	return nil
}

func (a *agent) reportStatus() error {
	a.mu.Lock()
	state := a.state
	runningID := a.runningID
	a.mu.Unlock()
	status := workstationStatus{
		RepositoryConfigured: a.repositoryReady(),
		RepositoryKind:       repositoryKind(a.cfg.Repository),
		AgentState:           "idle",
		CurrentRunID:         runningID,
		LastBackupAt:         state.LastBackupAt,
		LastSuccessAt:        state.LastSuccessAt,
		LastSnapshotID:       state.LastSnapshotID,
		LastError:            state.LastError,
	}
	if !status.RepositoryConfigured {
		status.AgentState = "needs-storage"
	} else if runningID != "" {
		status.AgentState = "running"
	}
	return a.client.reportWorkstationStatus(status)
}

func (a *agent) pollOnce() error {
	if !a.repositoryReady() {
		return nil
	}
	a.mu.Lock()
	busy := a.runningID != ""
	a.mu.Unlock()
	if busy {
		return nil
	}
	response, err := a.client.pollWorkstation()
	if err != nil {
		return err
	}
	if response.Run == nil {
		return nil
	}
	run := *response.Run
	a.mu.Lock()
	if a.runningID != "" {
		a.mu.Unlock()
		return nil
	}
	a.runningID = run.ID
	a.mu.Unlock()
	go func() {
		defer func() {
			a.mu.Lock()
			a.runningID = ""
			a.mu.Unlock()
			_ = a.reportStatus()
		}()
		a.execute(run)
	}()
	return nil
}

func (a *agent) executeBackup(run workstationRun) {
	log.Printf("workstation backup run %s starting with %d source path(s)", run.ID, len(run.SourcePaths))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// A heartbeat failure alone must never stop local work: it may just be a
	// transient network blip. Only an explicit stale-lease rejection (409)
	// means the controller has moved on and this run must stop, so it cannot
	// keep producing a backup/snapshot the controller no longer tracks.
	onLeaseResponse := func(err error) {
		if err == nil {
			return
		}
		if isStaleLease(err) {
			log.Printf("run %s lease rejected as stale; cancelling local restic process", run.ID)
			cancel()
		}
	}

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
				err := a.client.reportProgress(run.ID, run.LeaseToken, backupProgress{Phase: "running"})
				if err != nil {
					log.Printf("run %s lease heartbeat failed: %v", run.ID, err)
				}
				onLeaseResponse(err)
			}
		}
	}()

	result := executeResticBackup(ctx, a.cfg, run, func(progress backupProgress) {
		err := a.client.reportProgress(run.ID, run.LeaseToken, progress)
		if err != nil {
			log.Printf("run %s progress report failed: %v", run.ID, err)
		}
		onLeaseResponse(err)
	})
	close(heartbeatStop)
	<-heartbeatDone

	finished := time.Now().UTC().Format(time.RFC3339)
	status := "success"
	if result.Partial {
		status = "partial"
	}
	if result.Cancelled {
		status = "failure"
	} else if result.Err != nil && !result.Partial {
		status = "failure"
	}
	payload := map[string]any{
		"snapshotId":      result.SnapshotID,
		"filesNew":        result.FilesNew,
		"filesChanged":    result.FilesChanged,
		"filesUnmodified": result.FilesUnmodified,
		"dataAdded":       result.DataAdded,
		"durationSeconds": result.Duration.Seconds(),
	}
	errText := ""
	if result.Err != nil {
		errText = result.Err.Error()
	}
	finishErr := a.client.finishRun(run.ID, run.LeaseToken, status, payload, errText)
	if finishErr != nil {
		log.Printf("run %s result report failed: %v", run.ID, finishErr)
	}

	a.mu.Lock()
	a.state.LastBackupAt = finished
	// Successful local Restic completion is not authoritative until the
	// controller accepts the exact leased run result. Otherwise a transient
	// finish failure followed by status reporting could falsely advance
	// last-success/snapshot state while the controller later requeues the run.
	if status == "success" && finishErr == nil {
		a.state.LastSuccessAt = finished
		a.state.LastError = ""
		if result.SnapshotID != "" {
			a.state.LastSnapshotID = result.SnapshotID
		}
	} else if finishErr != nil {
		a.state.LastError = fmt.Sprintf("backup result was not acknowledged by controller: %v", finishErr)
	} else {
		a.state.LastError = errText
	}
	state := a.state
	a.mu.Unlock()
	if err := saveState(a.statePath, state); err != nil {
		log.Printf("run %s state save failed: %v", run.ID, err)
	}
	log.Printf("workstation backup run %s finished status=%s snapshot=%s acknowledged=%t", run.ID, status, shortID(result.SnapshotID), finishErr == nil)
}

func (a *agent) repositoryReady() bool {
	if strings.TrimSpace(a.cfg.Repository) == "" || strings.TrimSpace(a.cfg.PasswordFile) == "" {
		return false
	}
	info, err := os.Stat(a.cfg.PasswordFile)
	if err != nil || info.IsDir() {
		return false
	}
	content, err := os.ReadFile(a.cfg.PasswordFile)
	return err == nil && strings.TrimSpace(string(content)) != ""
}

func configPathFromArgs(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--config" && strings.TrimSpace(args[i+1]) != "" {
			return args[i+1]
		}
	}
	if value := strings.TrimSpace(os.Getenv("NEXUS_BACKUP_WORKSTATION_CONFIG")); value != "" {
		return value
	}
	programData := strings.TrimSpace(os.Getenv("PROGRAMDATA"))
	if programData == "" {
		programData = "."
	}
	return filepath.Join(programData, "NexusBackup", defaultConfigName)
}

func loadConfig(path string) (config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return config{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return config{}, fmt.Errorf("decode config %s: %w", path, err)
	}
	cfg.ServerURL = strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/")
	cfg.DeviceToken = strings.TrimSpace(cfg.DeviceToken)
	cfg.Repository = strings.TrimSpace(cfg.Repository)
	cfg.PasswordFile = strings.TrimSpace(cfg.PasswordFile)
	cfg.ResticPath = strings.TrimSpace(cfg.ResticPath)
	if cfg.ServerURL == "" || (!strings.HasPrefix(cfg.ServerURL, "http://") && !strings.HasPrefix(cfg.ServerURL, "https://")) {
		return config{}, errors.New("serverUrl must be http(s)")
	}
	if len(cfg.DeviceToken) < 24 {
		return config{}, errors.New("deviceToken is missing or invalid")
	}
	if cfg.ResticPath == "" {
		cfg.ResticPath = "restic.exe"
	}
	if cfg.PollSeconds < 5 {
		cfg.PollSeconds = 15
	}
	if cfg.ReportSeconds < 15 {
		cfg.ReportSeconds = 60
	}
	return cfg, nil
}

func saveConfig(path string, cfg config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func loadState(path string) (localState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return localState{}, err
	}
	var state localState
	if err := json.Unmarshal(data, &state); err != nil {
		return localState{}, err
	}
	return state, nil
}

func saveState(path string, state localState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func repositoryKind(repository string) string {
	repository = strings.TrimSpace(repository)
	if repository == "" {
		return ""
	}
	if filepath.IsAbs(repository) || strings.HasPrefix(repository, `\\`) {
		return "local"
	}
	if i := strings.Index(repository, ":"); i > 0 {
		kind := strings.ToLower(repository[:i])
		if len(kind) <= 32 {
			return kind
		}
	}
	return "remote"
}

func shortID(value string) string {
	if len(value) <= 12 {
		return value
	}
	return value[:12]
}
