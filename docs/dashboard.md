# M4 dashboard

The dashboard is served by the local control container at `/`.

## Current sections

- Overview: active/queued jobs, completion health, agent status and configured object counts.
- Jobs: filterable job history backed by local SQLite.
- Job detail: payload, timing, durable lifecycle events, live progress and runtime logs.
- Sources: sanitized local source metadata from the agent configuration.
- Destinations: sanitized rclone endpoint metadata.
- Repositories: sanitized restic repository metadata.
- Agent: heartbeat/version status.
- Settings: local-first deployment and security boundary summary.

The dashboard refreshes general local data every five seconds. While a job drawer is open, runtime telemetry refreshes every second. Job creation is available for the implemented execution types:

- `restic-backup`
- `rclone-restic-backup`
- `rclone-transfer` in `copy` mode only

Destructive `move` is intentionally not exposed in the M4 UI.

## Runtime telemetry

Execution telemetry is deliberately separate from durable lifecycle events. Lifecycle rows are part of the job state/audit model; runtime telemetry is noisy operational data that may be trimmed without mutating job state.

The agent batches execution events before sending them to the local control container. Consecutive progress samples for the same tool are coalesced, while log lines are retained in order. Telemetry delivery is best-effort: a telemetry transport failure is logged by the agent but never fails an otherwise healthy backup.

SQLite stores:

- one latest progress/summary row per job attempt;
- a bounded runtime log per job attempt (500 lines retained server-side);
- bytes/files completed and total, transfer speed, ETA and tool error count when available.

Attempt scoping prevents stale progress from an interrupted run being shown as current after the same job is recovered and leased again.

## Security boundary

The browser never receives the control-plane token, agent token, restic password-file paths or contents, repository environment variables, rclone credential contents, or mount/cache filesystem paths.

`/v1/local/jobs` proxies job creation through the server-side control token. Runtime telemetry writes require both a valid agent bearer token and the currently active per-job lease token. The browser only receives the sanitized read model through `/v1/local/jobs/:id/runtime`.

The control and agent containers share only the generated agent token through the private runtime volume.

The local dashboard currently assumes a trusted LAN. Before destructive controls or Internet exposure are added, local UI authentication must be implemented.
