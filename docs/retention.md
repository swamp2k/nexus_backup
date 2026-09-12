# Retention maintenance

Nexus Backup enforces Restic plan retention through a separate `restic-maintenance` job. Backup execution and retention are deliberately not combined into one process: a completed backup is durable before any snapshots are considered for removal.

## Plan scoping

Every Restic backup created by a backup plan receives an internal tag:

`nexus-plan:<plan-id>`

The maintenance job filters snapshots by that tag and runs the plan's daily/weekly/monthly policy with grouping disabled for the already-filtered snapshot set. This makes the plan tag the ownership boundary for retention and keeps manual snapshots or snapshots from another plan outside the policy.

## Scheduling and failure semantics

- Retention is queued only after the plan's latest backup reaches `completed`.
- `partial`, failed, cancelled, or interrupted backups do not trigger retention.
- A deterministic maintenance operation key prevents duplicate automatic jobs for the same completed backup.
- Once a maintenance job has been created, a failed maintenance run is not automatically retried. The Plans UI exposes an explicit **Run retention** action.
- A plan with all retention counts set to zero is treated as retention-disabled.

## Repository serialization

All Restic executors in the bundled agent share a per-repository execution gate:

- local Restic backup;
- rclone-mounted Restic backup;
- retention maintenance.

This prevents the bundled local agent from running `forget --prune` concurrently with another operation against the same configured repository. Restic's own repository locking remains a second safety layer.

## Command shape

Maintenance resolves the repository from the agent-local repository ID and executes the equivalent of:

```text
restic forget --json \
  --tag nexus-plan:<plan-id> \
  --group-by '' \
  --keep-daily <n> \
  --keep-weekly <n> \
  --keep-monthly <n> \
  --prune
```

Zero-valued keep options are omitted. At least one keep interval must be positive before a maintenance job can execute.

Repository credentials, repository locations, and password files remain agent-local. The browser receives only maintenance status and job IDs.
