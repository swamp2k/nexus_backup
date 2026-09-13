package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type apiClient struct {
	baseURL string
	mu      sync.RWMutex
	token   string
	http    *http.Client
}

type deviceReport struct {
	Version      string   `json:"version"`
	Hostname     string   `json:"hostname"`
	Platform     string   `json:"platform"`
	Capabilities []string `json:"capabilities"`
	Remotes      []string `json:"remotes,omitempty"`
}

type deviceReportResponse struct {
	Device struct {
		ID string `json:"id"`
	} `json:"device"`
	NextReportSeconds int    `json:"nextReportSeconds"`
	DeviceToken       string `json:"deviceToken,omitempty"`
}

type workstationStatus struct {
	RepositoryConfigured bool   `json:"repositoryConfigured"`
	RepositoryKind       string `json:"repositoryKind,omitempty"`
	AgentState           string `json:"agentState"`
	CurrentRunID         string `json:"currentRunId,omitempty"`
	LastBackupAt         string `json:"lastBackupAt,omitempty"`
	LastSuccessAt        string `json:"lastSuccessAt,omitempty"`
	LastSnapshotID       string `json:"lastSnapshotId,omitempty"`
	LastError            string `json:"lastError,omitempty"`
}

type workstationRun struct {
	ID              string          `json:"id"`
	DeviceID        string          `json:"deviceId"`
	State           string          `json:"state"`
	LeaseToken      string          `json:"leaseToken"`
	LeaseExpiresAt  string          `json:"leaseExpiresAt"`
	SourcePaths     []string        `json:"sourcePaths"`
	ExcludePatterns []string        `json:"excludePatterns"`
	Retention       retentionPolicy `json:"retention"`
}

type retentionPolicy struct {
	KeepDaily   int `json:"keepDaily"`
	KeepWeekly  int `json:"keepWeekly"`
	KeepMonthly int `json:"keepMonthly"`
}

type pollResponse struct {
	Run             *workstationRun `json:"run"`
	NextPollSeconds int             `json:"nextPollSeconds"`
}

type backupProgress struct {
	Phase       string  `json:"phase"`
	Percent     float64 `json:"percent,omitempty"`
	BytesDone   int64   `json:"bytesDone,omitempty"`
	BytesTotal  int64   `json:"bytesTotal,omitempty"`
	FilesDone   int64   `json:"filesDone,omitempty"`
	FilesTotal  int64   `json:"filesTotal,omitempty"`
	CurrentPath string  `json:"currentPath,omitempty"`
}

func newAPIClient(baseURL, token string) *apiClient {
	return &apiClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 45 * time.Second},
	}
}

func (c *apiClient) setToken(token string) {
	c.mu.Lock()
	c.token = token
	c.mu.Unlock()
}

func (c *apiClient) currentToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

func (c *apiClient) reportDevice(report deviceReport) (deviceReportResponse, error) {
	var response deviceReportResponse
	err := c.doJSON(http.MethodPost, "/v1/device/report", report, &response)
	return response, err
}

func (c *apiClient) reportWorkstationStatus(status workstationStatus) error {
	return c.doJSON(http.MethodPost, "/v1/device/workstation/status", status, nil)
}

func (c *apiClient) pollWorkstation() (pollResponse, error) {
	var response pollResponse
	err := c.doJSON(http.MethodPost, "/v1/device/workstation/poll", map[string]any{}, &response)
	return response, err
}

func (c *apiClient) reportProgress(runID, leaseToken string, progress backupProgress) error {
	return c.doJSON(http.MethodPatch, "/v1/device/workstation/runs/"+runID+"/progress", map[string]any{
		"leaseToken": leaseToken,
		"progress":   progress,
	}, nil)
}

func (c *apiClient) finishRun(runID, leaseToken, status string, result map[string]any, errorMessage string) error {
	payload := map[string]any{
		"leaseToken": leaseToken,
		"status":     status,
		"result":     result,
	}
	if errorMessage != "" {
		payload["error"] = errorMessage
	}
	return c.doJSON(http.MethodPost, "/v1/device/workstation/runs/"+runID+"/result", payload, nil)
}

func (c *apiClient) doJSON(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.currentToken())
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return fmt.Errorf("%s %s returned %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
