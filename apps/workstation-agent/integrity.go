package main

import (
	"context"
	"fmt"
	"os"
)

func checkWorkstationRepository(ctx context.Context, cfg config) error {
	if err := validateRepositoryConfig(cfg); err != nil {
		return redactBackupError(cfg, err)
	}
	env := recoveryEnvironment(cfg)
	if err := ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, false); err != nil {
		return redactBackupError(cfg, err)
	}
	cmd := commandContextWithTree(ctx, cfg.ResticPath, "check")
	cmd.Env = env
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return redactBackupError(cfg, fmt.Errorf("restic check cancelled: %w", ctx.Err()))
	}
	if err != nil {
		return redactBackupError(cfg, fmt.Errorf("restic check: %s", boundedText(output, 4000)))
	}
	return nil
}

// Keep os referenced by this file's package-level environment contract explicit
// for gofmt/go vet when platform-specific builds prune other helpers.
var _ = os.PathSeparator
