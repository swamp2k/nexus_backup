package main

import (
	"context"
	"fmt"
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
	output, err := combinedOutputTree(cmd)
	if ctx.Err() != nil {
		return redactBackupError(cfg, fmt.Errorf("restic check cancelled: %w", ctx.Err()))
	}
	if err != nil {
		return redactBackupError(cfg, fmt.Errorf("restic check: %s", boundedText(output, 4000)))
	}
	return nil
}
