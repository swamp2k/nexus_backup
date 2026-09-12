# M4 dashboard

The dashboard is served by the local control container at `/`.

## Current sections

- Overview: active/queued jobs, completion health, agent status and configured object counts.
- Jobs: filterable job history backed by local SQLite, including live progress for active jobs.
- Plans: persistent local backup schedules with next/last-run status and retention policy metadata.
- Transfers: persistent Copyarr-style discovery, stability, staged transfer, cleanup and optional rTorrent readiness gates.
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

Destructive `move` is intentionally not exposed in the generic manual-job UI. Managed Transfer Rules may use move only when the local source endpoint explicitly sets `allowMove: true`.

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

Restic plans store `keepDaily`, `keepWeekly` and `keepMonthly` policy values (default 7/4/12). Restic retention is executed as a separate maintenance job with repository locking rather than being hidden inside a successful backup completion.

## Transfer rules

Transfer Rules are the persistent Copyarr-style automation layer. Discovery state lives in local SQLite and is identified by relative path, size and modification time, so a changed file becomes a new generation instead of silently reusing old state.

The default flow is:

1. `rclone lsjson` discovers source files.
2. `ignore_existing` can mark the first scan as a baseline.
3. New generations must survive the configured stability window and still appear in the most recent completed scan.
4. A `managed-transfer` job copies each ready object into hidden destination staging.
5. Nexus verifies the staged byte size, commits it to the final destination and verifies the final byte size again.
6. Move mode deletes the exact source object only after final verification, and only when the local source endpoint opts in with `allowMove: true`.

Per-rule retry policy, include/exclude patterns, multi-thread streams/cutoff and bounded rclone arguments are persisted with the rule. Managed rclone arguments cannot override Nexus safety flags such as config, dry-run, delete behavior, stats or multi-thread control.

### Transfer cleanup

`cleanupDays` is enforced through a separate `managed-cleanup` agent job. The control container never receives storage access. Before deleting a retained destination object, the agent performs a fresh rclone stat and requires the current byte size to equal the size Nexus committed.

If the destination was modified after Nexus committed it, cleanup is permanently refused for that object generation and the object remains `done`. Transient rclone/network failures use the rule's bounded retry policy. A disabled rule does not enqueue destructive cleanup work.

### rTorrent readiness gates

A transfer rule may reference a local `rtorrentGateId`. The gate definition itself stays in `agent.json` and contains the XML-RPC URL, optional Basic Auth credentials, view, required source-base-path mapping and `required` behavior. The browser receives only the sanitized gate ID and whether it is required; RPC URLs, usernames, passwords and source paths are never exposed through dashboard config.

During discovery the agent calls rTorrent `d.multicall2` for hash, name, completion state and base path. Files belonging to a known incomplete torrent are held back and cannot become stable/queued. Files belonging to completed torrents pass discovery. Files not owned by a known torrent continue through the ordinary stability window.

If an optional gate is unavailable, Nexus logs the failure and falls back to stability-only discovery. If `required: true`, the scan fails instead of guessing. This slice is a readiness gate only: completed torrent payloads are not yet grouped into one multi-file transfer job.

## Runtime telemetry

Execution telemetry is deliberately separate from durable lifecycle events. Lifecycle rows are part of the job state/audit model; runtime telemetry is noisy operational data that may be trimmed without mutating job state.

The agent batches execution events before sending them to the local control container. Consecutive progress samples for the same tool are coalesced, while log lines are retained in order. Telemetry delivery is best-effort: a telemetry transport failure is logged by the agent but never fails an otherwise healthy backup.

SQLite stores one latest progress/summary row per job attempt and a bounded runtime log per job attempt. Attempt scoping prevents stale progress from an interrupted run being shown as current after the same job is recovered and leased again.

## Security boundary

The browser never receives the control-plane token, agent token, restic password-file paths or contents, repository environment variables, rclone credential contents, mount/cache filesystem paths, or rTorrent RPC credentials.

Plan templates contain only local registry IDs, tags, schedule metadata and retention policy. Transfer rules contain endpoint IDs and optional rTorrent gate IDs, while secret gate definitions remain local to the agent. Server-side validation checks referenced IDs against sanitized agent configuration before persisting them.

Runtime telemetry writes require both a valid agent bearer token and the currently active per-job lease token. The control and agent containers share only the generated agent token through the private runtime volume.

The local dashboard is protected by local session authentication. Destructive restore and transfer operations remain gated by server-side policy even when the browser UI hides or disables an option.