# Nexus Backup

Nexus Backup is the backup and transfer engine for Nexus. Nexus is the control plane; local agents hold credentials and move backup payloads directly between sources and destinations.

## Status

M1-M3 are implemented, including the remote rclone -> restic pipeline. The first runnable Unraid-oriented agent service and Docker image definition are also in the repository.

### M1 - job engine and agent lifecycle

- shared job state machine
- idempotent operation keys
- leases and heartbeat ownership
- stale-lease recovery
- durable job events
- agent runner with execution cancellation on heartbeat failure

### M2 - control plane

- Cloudflare Worker-compatible HTTP API
- D1 repository and initial schema migration
- compare-and-swap revisions for persistent job mutations
- atomic job mutation + event persistence using D1 batch transactions
- token-authenticated agents with SHA-256 token hashes at rest
- separate control-plane authentication
- atomic next-job claim
- heartbeat and lifecycle transition endpoints
- scheduled stale-lease recovery
- HTTP control-plane client for the agent
- SQLite-backed contract and end-to-end tests

### M3 - execution pipeline

- cancellable child-process runner with TERM -> KILL escalation
- local-only source, repository and rclone endpoint registry
- restic backup executor with JSON progress parsing
- restic exit code 3 mapped to `partial`
- rclone copy/move executor with JSON stats parsing
- destructive rclone `move` requires local source opt-in
- read-only rclone FUSE mount lifecycle for remote backup sources
- configurable local VFS cache/mount policy
- guaranteed unmount on completed, partial and failed remote backups
- cleanup uses its own timeout and surfaces leaked-mount failures
- raw source/repository/mount paths cannot be supplied by control-plane jobs

### Agent runtime

- local JSON configuration loader
- long-running claim/poll/retry loop
- JSON-line execution logging
- SIGTERM/SIGINT shutdown
- configuration validation mode
- Docker image definition with Node, rclone, restic and fuse3
- CI image-build gate

Backup payloads must never pass through the Nexus control plane.

## Repository layout

```text
packages/core          Domain model, state machine, leases and repository contracts
apps/agent             Agent runner, runtime process and execution adapters
apps/control-plane     Worker-compatible API, D1 repository and agent auth
config                 Local agent configuration example
migrations             D1 schema migrations
docs                   Architecture, control-plane and Unraid runtime notes
```

## Development

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm ci
npm test
npm run typecheck
```

CI also builds `Dockerfile.agent` after the test gate.

## Cloudflare deployment

No Cloudflare database or Worker target is committed yet. The Worker contract expects:

- a D1 binding named `DB`
- a secret named `CONTROL_PLANE_TOKEN`
- optionally `DEFAULT_LEASE_TTL_MS`

The actual D1 database name/id and deployment target must be selected before a Wrangler configuration is added.

## Roadmap

1. M1 - Core engine and agent lifecycle ✅
2. M2 - Control-plane API, D1 persistence and agent authentication ✅
3. M3 - rclone + restic pipeline ✅
4. M4 - Nexus UI
5. M5 - transfer engine / Copyarr capabilities
6. M6 - device / PCWatch integration
7. M7 - restore
8. M8 - recovery torture testing
9. M9 - architecture/security review

Before M4, deploy the control plane and agent on the actual infrastructure so the full path can be exercised end-to-end with chosen D1/Worker and Unraid values.

See `docs/architecture.md`, `docs/control-plane.md` and `docs/unraid-agent.md` for the invariants later milestones must preserve.
