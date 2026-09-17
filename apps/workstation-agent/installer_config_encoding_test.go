package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

// TestInstallerWritesBOMFreeWorkstationJSON exercises install.ps1's
// Write-Config helper under real Windows PowerShell 5.1 (powershell.exe, not
// pwsh Core). On PS 5.1, Set-Content -Encoding utf8 prepends a UTF-8 BOM,
// which encoding/json.Unmarshal rejects, breaking a freshly installed or
// repaired workstation with "decode config ... invalid character". Only
// running this under real powershell.exe reproduces that failure mode; pwsh
// Core (used for the "Parse workstation installer" CI syntax check) does not
// add a BOM and would hide a regression.
func TestInstallerWritesBOMFreeWorkstationJSON(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell 5.1 BOM semantics are only reproducible on windows")
	}
	psPath, err := exec.LookPath("powershell.exe")
	if err != nil {
		t.Skip("windows powershell.exe (PowerShell 5.1) not available")
	}

	installerPath := filepath.Join("..", "local-server", "web", "install.ps1")
	source, err := os.ReadFile(installerPath)
	if err != nil {
		t.Fatalf("read install.ps1: %v", err)
	}
	fnRe := regexp.MustCompile(`(?m)^function Write-Config\(.*\)\s*\{.*\}\s*$`)
	fn := fnRe.Find(source)
	if fn == nil {
		t.Fatal("could not locate the Write-Config function definition in install.ps1")
	}

	dir := t.TempDir()
	configPath := filepath.Join(dir, "workstation.json")
	script := string(fn) + "\n" +
		"$cfg = [ordered]@{serverUrl='https://nexus.example.test';deviceToken='nxbdev_abcdefghijklmnopqrstuvwx';repositoryId='repo-1';pollSeconds=15;reportSeconds=60}\n" +
		"Write-Config -Path '" + configPath + "' -Config $cfg\n"
	scriptPath := filepath.Join(dir, "harness.ps1")
	if err := os.WriteFile(scriptPath, []byte(script), 0o644); err != nil {
		t.Fatalf("write harness script: %v", err)
	}

	cmd := exec.Command(psPath, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Write-Config harness failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read generated workstation.json: %v", err)
	}
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatal("workstation.json was written with a UTF-8 BOM; Windows PowerShell 5.1's Set-Content -Encoding utf8 does this and the Go client's encoding/json.Unmarshal rejects it")
	}

	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("go could not decode the installer-written config: %v", err)
	}
	if cfg.ServerURL != "https://nexus.example.test" || cfg.RepositoryID != "repo-1" || cfg.DeviceToken != "nxbdev_abcdefghijklmnopqrstuvwx" {
		t.Fatalf("decoded config does not match what was written: %+v", cfg)
	}
}
