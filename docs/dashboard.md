# M4 dashboard

The dashboard is served by the local control container at `/`.

## Current sections

- Overview: active/queued jobs, completion health, agent status and configured object counts.
- Jobs: filterable job history backed by local SQLite, including live progress for active jobs.
- Plans: persistent local backup schedules with next/last-run status and retention policy metadata.
- Job detail: payload, timing, durable lifecycle events, live progress and runtime logs.
- Sources: sanitized local source metadata from the agent configuration.
- Destinations: sanitized rclone endpoint metadata.
- Repositories: sanitized restic repository metadata.
- Agent: heartbeat/version status.
- Settings: local-first deployment and security boundary summary.

General dashboard data refreshes every five seconds. Active job progress and an open job drawer refresh about once per second.

Manual job creation supports:

- `restic-backup`
- `rclone-restic-backup`
- `rclone-transfer` in `copy` mode only

Destructive `move` is intentionally not exposed in the M4 UI.

## Backup plans

Backup plans are stored in local SQLite and scheduled by the local control container; no external cron, Cloudflare service or Internet connection is required.

Plan schedules intentionally use a small user-facing model rather than raw cron syntax:

- daily at a local `HH:MM` time;
- weekly at a local `HH:MM` time on one or more weekdays;
- every plan stores an IANA timezone such as `Europe/Copenhagen`.

The browser timezone is the editor default, but it can be changed per plan. Local wall-clock scheduling follows daylight-saving changes. If a configured local time does not exist during a spring-forward transition, Nexus Backup advances to the first valid local minute on that date.

Each scheduled occurrence uses a deterministic operation key derived from the plan ID and scheduled timestamp. This preserves job idempotency across control-container crashes or restarts: if the scheduler retries the same occurrence, the existing job is reused instead of duplicated. Missed occurrences are coalesced into one catch-up job; after a successful enqueue, the next run is calculated strictly in the future.

Plans support:

- create/edit;
- pause/resume;
- Run now;
- next scheduled run;
- last job state/result;
- local-to-Restic, remote-mount-to-Restic and rclone-copy templates.

Scheduled rclone plans are copy-only. Move/delete is not available from Plans.

### Retention boundary

Restic plans store `keepDaily`, `keepWeekly` and `keepMonthly` policy values (default 7/4/12). This slice deliberately does **not** execute `restic forget` or `restic prune` automatically. Retention enforcement will be a separate maintenance job type with repository-level locking, telemetry and explicit destructive-operation safety gates.

## Runtime telemetry

Execution telemetry is deliberately separate from durable lifecycle events. Lifecycle rows are part of the job state/audit model; runtime telemetry is noisy operational data that may be trimmed without mutating job state.

The agent batches execution events before sending them to the local control container. Consecutive progress samples for the same tool are coalesced, while log lines are retained in order. Telemetry delivery is best-effort: a telemetry transport failure is logged by the agent but never fails an otherwise healthy backup.

SQLite stores one latest progress/summary row per job attempt and a bounded runtime log per job attempt. Attempt scoping prevents stale progress from an interrupted run being shown as current after the same job is recovered and leased again.

## Security boundary

The browser never receives the control-plane token, agent token, restic password-file paths or contents, repository environment variables, rclone credential contents, or mount/cache filesystem paths.

Plan templates contain only local registry IDs, tags, schedule metadata and retention policy. The server validates referenced source/repository/endpoint IDs against the sanitized agent configuration before storing a plan.

Runtime telemetry writes require both a valid agent bearer token and the currently active per-job lease token. The control and agent containers share only the generated agent token through the private runtime volume.

The local dashboard currently assumes a trusted LAN. Before destructive controls or Internet exposure are added, local UI authentication must be implemented.
