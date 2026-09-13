package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateRepositoryConfigAppliesPinnedRESTTransportLocally(t *testing.T) {
	dir := t.TempDir()
	passwordFile := filepath.Join(dir, "restic-password")
	caFile := filepath.Join(dir, "repository-ca.pem")
	if err := os.WriteFile(passwordFile, []byte("encryption-secret\n"), 0o600); err != nil { t.Fatal(err) }
	if err := os.WriteFile(caFile, []byte("test-ca\n"), 0o600); err != nil { t.Fatal(err) }

	t.Setenv("RESTIC_REST_USERNAME", "stale-user")
	t.Setenv("RESTIC_REST_PASSWORD", "stale-password")
	t.Setenv("RESTIC_CACERT", "stale-ca")
	cfg := config{
		Repository:   "rest:https://backup.lan:8000/balder-pc/main",
		PasswordFile: passwordFile,
		RestUsername: "balder-pc",
		RestPassword: "transport-secret",
		CACertPath:   caFile,
	}
	if err := validateRepositoryConfig(cfg); err != nil { t.Fatal(err) }
	if got := os.Getenv("RESTIC_REST_USERNAME"); got != "balder-pc" { t.Fatalf("username env = %q", got) }
	if got := os.Getenv("RESTIC_REST_PASSWORD"); got != "transport-secret" { t.Fatalf("password env = %q", got) }
	if got := os.Getenv("RESTIC_CACERT"); got != caFile { t.Fatalf("cacert env = %q", got) }
	if !isPinnedManagedRestRepository(cfg) { t.Fatal("expected pinned authenticated HTTPS repository to be managed") }
}

func TestRepositoryTransportRequiresPairHTTPSAndPinnedCAForManagedInit(t *testing.T) {
	dir := t.TempDir()
	passwordFile := filepath.Join(dir, "restic-password")
	caFile := filepath.Join(dir, "repository-ca.pem")
	if err := os.WriteFile(passwordFile, []byte("secret\n"), 0o600); err != nil { t.Fatal(err) }
	if err := os.WriteFile(caFile, []byte("ca\n"), 0o600); err != nil { t.Fatal(err) }

	base := config{Repository: "rest:https://backup.lan:8000/user/main", PasswordFile: passwordFile, CACertPath: caFile}
	badPair := base
	badPair.RestUsername = "user"
	if err := validateRepositoryConfig(badPair); err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("expected credential-pair rejection, got %v", err)
	}
	plainHTTP := base
	plainHTTP.Repository = "rest:http://backup.lan:8000/user/main"
	plainHTTP.RestUsername = "user"
	plainHTTP.RestPassword = "secret"
	if err := validateRepositoryConfig(plainHTTP); err == nil || !strings.Contains(err.Error(), "rest:https://") {
		t.Fatalf("expected HTTPS rejection, got %v", err)
	}
	unpinned := base
	unpinned.RestUsername = "user"
	unpinned.RestPassword = "secret"
	unpinned.CACertPath = ""
	if isPinnedManagedRestRepository(unpinned) { t.Fatal("remote init must not be allowed without a pinned CA") }
}

func TestRepositoryTransportSecretsAreRedacted(t *testing.T) {
	cfg := config{
		Repository:   "rest:https://backup.lan:8000/balder-pc/main",
		PasswordFile: `C:\ProgramData\NexusBackup\restic-password`,
		RestUsername: "balder-pc",
		RestPassword: "transport-secret",
		CACertPath:   `C:\ProgramData\NexusBackup\repository-ca.pem`,
	}
	err := redactBackupError(cfg, errors.New("open rest:https://backup.lan:8000/balder-pc/main as balder-pc password=transport-secret using C:\\ProgramData\\NexusBackup\\repository-ca.pem"))
	text := err.Error()
	for _, secret := range []string{cfg.Repository, cfg.RestUsername, cfg.RestPassword, cfg.CACertPath} {
		if strings.Contains(text, secret) { t.Fatalf("redacted error leaked %q: %s", secret, text) }
	}
}

func TestRemoteAutoInitOnlyRunsWhenExplicitlyAllowed(t *testing.T) {
	if runtime.GOOS == "windows" { t.Skip("fixture uses a POSIX shell") }
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	script := filepath.Join(dir, "fake-restic")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\nif [ \"$1\" = \"cat\" ]; then echo missing >&2; exit 1; fi\nif [ \"$1\" = \"init\" ]; then exit 0; fi\nexit 2\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil { t.Fatal(err) }
	repository := "rest:https://backup.lan:8000/user/main"

	if err := ensureRepository(script, os.Environ(), repository, false); err == nil { t.Fatal("expected missing remote repository to fail when auto-init is disabled") }
	first, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(first), "init") { t.Fatalf("unsafe init happened with auto-init disabled: %s", first) }

	if err := ensureRepository(script, os.Environ(), repository, true); err != nil { t.Fatalf("allowed remote init failed: %v", err) }
	all, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	if !strings.Contains(string(all), "cat config") || !strings.Contains(string(all), "init") {
		t.Fatalf("expected probe followed by init, got %s", all)
	}
}
