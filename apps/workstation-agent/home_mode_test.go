package main

import (
    "os"
    "path/filepath"
    "testing"
)

func TestHomeModeRepositoryNeedsNoPasswordFile(t *testing.T) {
    cfg := config{Repository: "rest:http://192.168.1.2:8000/device-home", InsecureNoPassword: true}
    if err := validateRepositoryConfig(cfg); err != nil {
        t.Fatalf("home mode config should be ready without a password file: %v", err)
    }
}

func TestEncryptedRepositoryStillRequiresPasswordFile(t *testing.T) {
    cfg := config{Repository: "rest:https://backup.example.test/device"}
    if err := validateRepositoryConfig(cfg); err == nil {
        t.Fatal("encrypted/remote config should still require passwordFile")
    }
}

func TestHomeModeResticArgsAlwaysCarryNoPasswordFlag(t *testing.T) {
    cfg := config{InsecureNoPassword: true}
    args := resticCLIArgs(cfg, "backup", "C:\\Data")
    if len(args) < 2 || args[0] != "--insecure-no-password" || args[1] != "backup" {
        t.Fatalf("unexpected args: %#v", args)
    }
}

func TestHomeModeEnvironmentDoesNotReferencePasswordFile(t *testing.T) {
    dir := t.TempDir()
    cfg := config{
        Repository: "rest:http://127.0.0.1:8000/test",
        PasswordFile: filepath.Join(dir, "does-not-exist"),
        InsecureNoPassword: true,
    }
    env := resticEnvironment(cfg)
    for _, entry := range env {
        if len(entry) >= len("RESTIC_PASSWORD_FILE=") && entry[:len("RESTIC_PASSWORD_FILE=")] == "RESTIC_PASSWORD_FILE=" {
            t.Fatalf("home mode leaked password-file env: %q", entry)
        }
    }
    if _, err := os.Stat(cfg.PasswordFile); !os.IsNotExist(err) {
        t.Fatalf("test expected missing password file, got %v", err)
    }
}
