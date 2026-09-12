# Nexus Backup

Nexus Backup is the backup and transfer engine for Nexus. Nexus is the control plane; local agents hold credentials and move backup payloads directly between sources and destinations.

## Status

M1 and M2 are implemented. M3 execution foundation is implemented; host-specific rclone mount orchestration is intentionally deferred until the Unraid agent runtime is selected.

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

### M3 - execution foundation

- cancellable child-process runner with TERM -> KILL escalation
- local-only source, repository and rclone endpoint registry
- restic backup executor with JSON progress parsing
- restic exit code 3 mapped to `partial`
- rclone copy/move executor with JSON stats parsing
- destructive rclone `move` requires local source opt-in
- composite executor dispatch by job type
- raw source/repository paths cannot be supplied by control-plane jobs

The remaining host-specific M3 work is rclone mount lifecycle and cache/unmount policy for remote-as-source backups such as Google Drive -> restic.

Backup payloads must never pass through the Nexus control plane.

## Repository layout

```text
packages/core          Domain model, state machine, leases and repository contracts
apps/agent             Agent runner and HTTP control-plane client
apps/control-plane     Worker-compatible API, D1 repository and agent auth
migrations             D1 schema migrations
docs                   Architecture and control-plane notes
```

## Development

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm ci
npm test
npm run typecheck
```

The control-plane tests use Node's built-in SQLite implementation to exercise the same SQL invariants required by D1, including uniqueness, `UPDATE ... RETURNING`, compare-and-swap revisions and transaction rollback.

## Cloudflare deployment

No Cloudflare database or Worker target is committed yet. The Worker contract expects:

- a D1 binding named `DB`
- a secret named `CONTROL_PLANE_TOKEN`
- optionally `DEFAULT_LEASE_TTL_MS`

The actual D1 database name/id and deployment target must be selected before a Wrangler configuration is added.

## Roadmap

1. M1 - Core engine and agent lifecycle ✅
2. M2 - Control-plane API, D1 persistence and agent authentication ✅
3. M3 - rclone + restic pipeline (execution foundation ✅; mount integration pending)
4. M4 - Nexus UI
5. M5 - transfer engine / Copyarr capabilities
6. M6 - device / PCWatch integration
7. M7 - restore
8. M8 - recovery torture testing
9. M9 - architecture/security review

See `docs/architecture.md` and `docs/control-plane.md` for the invariants later milestones must preserve.
