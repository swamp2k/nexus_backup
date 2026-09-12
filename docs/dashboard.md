# M4 dashboard

The dashboard is served by the local control container at `/`.

## Current sections

- Overview: active/queued jobs, completion health, agent status and configured object counts.
- Jobs: filterable job history backed by local SQLite.
- Job detail: payload, timing and durable lifecycle events.
- Sources: sanitized local source metadata from the agent configuration.
- Destinations: sanitized rclone endpoint metadata.
- Repositories: sanitized restic repository metadata.
- Agent: heartbeat/version status.
- Settings: local-first deployment and security boundary summary.

The dashboard refreshes local data every five seconds. Job creation is available for the implemented execution types:

- `restic-backup`
- `rclone-restic-backup`
- `rclone-transfer` in `copy` mode only

Destructive `move` is intentionally not exposed in the M4 UI.

## Security boundary

The browser never receives the control-plane token, agent token, restic password-file paths or contents, repository environment variables, rclone credential contents, or mount/cache filesystem paths.

`/v1/local/jobs` proxies job creation through the server-side control token. The control and agent containers share only the generated agent token through the private runtime volume.

The local dashboard currently assumes a trusted LAN. Before destructive controls or Internet exposure are added, local UI authentication must be implemented.
