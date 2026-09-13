package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResticEnvironmentUsesLocalTransportConfigWithoutMutatingProcessEnvironment(t *testing.T) {
	dir := t.TempDir()
	passwordFile := filepath.Join(dir, "restic-password")
	caFile := filepath.Join(dir, "repository-ca.pem")
	if err := os.WriteFile(passwordFile, []byte("encryption-secret\n"), 0o600); err != nil { t.Fatal(err) }
	if err := os.WriteFile(caFile, []byte("test-ca\n"), 0o600); err != nil { t.Fatal(err) }

	t.Setenv("RESTIC_REPOSITORY", "stale-repository")
	t.Setenv("RESTIC_PASSWORD_FILE", "stale-password-file")
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
	env := resticEnvironment(cfg)
	for name, want := range map[string]string{
		"RESTIC_REPOSITORY": cfg.Repository,
		"RESTIC_PASSWORD_FILE": passwordFile,
		"RESTIC_REST_USERNAME": "balder-pc",
		"RESTIC_REST_PASSWORD": "transport-secret",
		"RESTIC_CACERT": caFile,
	} {
		if got := envValue(env, name); got != want { t.Fatalf("%s child env = %q, want %q", name, got, want) }
	}
	if got := os.Getenv("RESTIC_REST_PASSWORD"); got != "stale-password" {
		t.Fatalf("validation mutated process environment: %q", got)
	}
}

func TestRepositoryTransportRequiresCredentialPairAndHTTPS(t *testing.T) {
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

func TestRemoteRepositoryNeverAutoInitializesAtRuntime(t *testing.T) {
	if os.PathSeparator == '\\' { t.Skip("fixture uses a POSIX shell") }
	dir := t.TempDir()
	logPath := filepath.Join(dir, "commands.log")
	script := filepath.Join(dir, "fake-restic")
	body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + logPath + "'\nif [ \"$1\" = \"cat\" ]; then echo unavailable >&2; exit 1; fi\nif [ \"$1\" = \"init\" ]; then exit 0; fi\nexit 2\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil { t.Fatal(err) }
	repository := "rest:https://backup.lan:8000/user/main"

	for _, autoInit := range []bool{false, true} {
		if err := ensureRepository(script, os.Environ(), repository, autoInit); err == nil {
			t.Fatalf("expected remote repository failure with autoInit=%t", autoInit)
		}
	}
	commands, err := os.ReadFile(logPath)
	if err != nil { t.Fatal(err) }
	if strings.Contains(string(commands), "init") {
		t.Fatalf("remote runtime failure triggered unsafe init: %s", commands)
	}
	if count := strings.Count(string(commands), "cat config"); count != 2 {
		t.Fatalf("expected two read-only probes, got %d: %s", count, commands)
	}
}

func envValue(env []string, name string) string {
	prefix := strings.ToUpper(name) + "="
	for i := len(env) - 1; i >= 0; i-- {
		entry := env[i]
		if strings.HasPrefix(strings.ToUpper(entry), prefix) {
			return entry[len(name)+1:]
		}
	}
	return ""
}
