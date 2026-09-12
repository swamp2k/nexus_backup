# Nexus Backup

Nexus Backup is a self-contained backup and transfer platform for Nexus. The primary deployment is local-first: a Docker control-plane/UI container owns the local API and SQLite database, while a separate local agent holds credentials and moves backup data directly between sources and destinations.

Cloudflare is optional remote control, never a requirement for normal operation and never part of the backup data path.

## Status

M1-M3 are implemented. The repository now also contains the local-first runtime needed to run the control plane and agent as one self-contained Docker stack.

### Core engine

- shared job state machine
- idempotent operation keys
- leases and heartbeat ownership
- stale-lease recovery
- durable job events
- agent runner with execution cancellation on heartbeat failure

### Portable control plane

- standard Request/Response API
- SQLite-compatible SQL repository model
- local SQLite adapter using Node's built-in SQLite
- optional Cloudflare Worker/D1 host adapter remains available
- compare-and-swap revisions and atomic job/event mutations
- token-authenticated agents with SHA-256 token hashes at rest
- atomic next-job claim, heartbeat and lifecycle transitions
- local stale-lease recovery timer; no cron service required

### Execution pipeline

- cancellable child-process runner with TERM -> KILL escalation
- local-only source, repository and rclone endpoint registry
- restic backup executor with JSON progress parsing
- restic exit code 3 mapped to `partial`
- rclone copy/move executor with JSON stats parsing
- destructive rclone `move` requires local source opt-in
- read-only rclone FUSE mount lifecycle for remote backup sources
- configurable local VFS cache/mount policy
- guaranteed unmount on completed, partial and failed remote backups
- raw source/repository/mount paths cannot be supplied by control-plane jobs

### Self-contained Docker runtime

- `Dockerfile.local` runs local API + SQLite + future M4 UI
- `Dockerfile.agent` runs rclone/restic/FUSE execution
- `compose.yaml` joins them into one application
- local control and agent tokens are generated automatically and persisted locally
- agent token is shared through a private runtime volume, not copied into Compose
- local SQLite migrations are applied automatically at startup
- agent config is bootstrapped from the bundled example on first start

Backup payloads must never pass through the control plane, Cloudflare, or a remote relay.

## Run locally

```bash
docker compose up --build
```

Then open `http://localhost:8787`. The current page is the local web shell; M4 replaces it with the full dashboard at the same address.

For real storage, set `NEXUS_BACKUP_DATA_PATH` and `NEXUS_BACKUP_BACKUP_PATH` or map the equivalent paths in the Unraid template. The defaults use `./.local/data` and `./.local/backup` only for a safe local/dev install.

## Repository layout

```text
packages/core          Domain model, state machine, leases and repository contracts
apps/control-plane     Portable API plus Cloudflare/D1 adapter
apps/local-server      Local HTTP host and SQLite adapter
apps/agent             Agent runtime and execution adapters
config                 Local agent configuration example
migrations             Shared SQLite/D1 schema migrations
docs                   Architecture and runtime notes
```

## Development

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm ci
npm test
npm run typecheck
```

CI builds and validates both Docker images after the test gate.

## Remote control

Remote control is an optional capability layered on top of the local installation. The existing Worker/D1 adapter is retained as a possible remote host, but the local SQLite instance remains authoritative for the self-contained deployment. Remote-control design must not require backup payloads, storage credentials, or local filesystem paths to transit the remote service.

## Roadmap

1. M1 - Core engine and agent lifecycle ✅
2. M2 - Portable control-plane API and persistence ✅
3. M3 - rclone + restic pipeline ✅
4. Local-first Docker runtime ✅
5. M4 - Nexus Backup UI
6. M5 - transfer engine / Copyarr capabilities
7. M6 - device / PCWatch integration
8. M7 - restore
9. M8 - recovery torture testing
10. M9 - architecture/security review

See `docs/local-first.md`, `docs/architecture.md`, `docs/control-plane.md` and `docs/unraid-agent.md` for the invariants later milestones must preserve.
