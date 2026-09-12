# Nexus Backup

Nexus Backup is a self-contained backup and transfer platform for Nexus. The primary deployment is local-first: a Docker control-plane/UI container owns the local API and SQLite database, while a separate local agent holds credentials and moves data directly between sources and destinations.

Cloudflare is optional remote control, never a requirement for normal operation and never part of the backup data path.

## Current capabilities

### Core engine

- shared job state machine and durable job events
- idempotent operation keys
- leases, heartbeats and stale-lease recovery
- compare-and-swap revisions and atomic job/event mutations
- authenticated local UI plus token-authenticated agents
- local SQLite is authoritative in self-contained mode

### Backup and restore

- local Restic backups
- read-only rclone FUSE sources feeding Restic
- local recurring backup plans with timezone-aware scheduling
- plan-scoped Restic retention maintenance with repository locking
- repository inventory and snapshot browsing
- restore preview plus guarded write restore to locally configured targets
- live progress and bounded logs in the dashboard

### Transfer engine

M5 brings the proven Copyarr model into the Nexus job engine rather than running a second automation stack:

- persistent transfer rules and persistent object generations
- discovery identity based on path + size + modification time
- `ignore_existing` or `process_existing` bootstrap behavior
- stability windows and bounded retries
- Copyarr-style include/exclude filtering
- staged copy -> exact-size verification -> commit -> final verification
- verified move only after local `allowMove: true` opt-in
- Copyarr defaults for multi-thread transfer tuning with single-thread fallback
- per-rule rclone tuning with safety-critical flags reserved by Nexus
- provenance-safe destination cleanup with exact committed-size verification
- optional rTorrent readiness gates with required/fallback modes
- completed rTorrent copy torrents grouped into one multi-file manifest job
- grouped failures retry as one group; verified move remains per-file for source-delete safety
- live object state and transfer progress in the Transfers dashboard

See `docs/transfers.md` for transfer invariants and safety boundaries.

### Managed devices

M6 begins with a durable device trust layer for PCWatch and future clients:

- authenticated local admins can enroll, disable and rotate device credentials
- device bearer secrets are shown once; only SHA-256 hashes are stored
- devices report bounded version, hostname, platform, capability and remote-name metadata
- the initial report shape intentionally matches the useful metadata already emitted by the PCWatch backup agent
- online/offline state and capabilities are visible in the Devices dashboard
- device reports do not accept backup payloads, storage credentials, arbitrary filesystem paths or shell commands

See `docs/devices.md` for the current M6 boundary and PCWatch migration path.

### Self-contained Docker runtime

- `Dockerfile.local` runs the authenticated local API/UI and SQLite database
- `Dockerfile.agent` runs rclone/restic/FUSE execution
- `compose.yaml` joins them into one application
- control and agent tokens are generated automatically and persisted locally
- the agent token is shared through a private runtime volume
- migrations are applied automatically at startup
- coordinated control/agent release images use immutable SemVer tags plus a stable `latest` update channel
- beta Unraid templates preserve the control/agent security boundary and track the coordinated `latest` images
- storage paths remain parameterized; real deployment paths remain editable

Backup payloads must never pass through the control plane, Cloudflare, PCWatch, or a remote relay.

## Run locally

```bash
docker compose up --build
```

Then open `http://localhost:8787` and complete the local first-run authentication setup.

For real storage, set the path variables used by `compose.yaml` or map the equivalent paths in the beta Unraid templates. The bundled defaults are intended only for safe local/dev use.

## Repository layout

```text
packages/core          Domain model, state machine, leases and repository contracts
apps/control-plane     Portable API plus Cloudflare/D1 adapter
apps/local-server      Authenticated local host, scheduler, UI and SQLite adapter
apps/agent             Agent runtime and execution adapters
config                 Local agent configuration example
migrations             Shared SQLite/D1 schema migrations
docs                   Architecture and runtime notes
unraid                  Beta Unraid templates and install notes
```

## Development

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm ci
npm test
npm run typecheck
```

CI builds and validates both Docker images after the test gate. It also checks release metadata and the beta Unraid template contracts.

## Remote control

Remote control is an optional capability layered on top of the local installation. The Worker/D1 adapter is retained as a possible remote host, but the local SQLite instance remains authoritative for the self-contained deployment. Remote-control design must not require backup payloads, storage credentials, or raw local filesystem paths to transit the remote service.

## Roadmap

1. M1 - Core engine and agent lifecycle ✅
2. M2 - Portable control-plane API and persistence ✅
3. M3 - rclone + Restic execution pipeline ✅
4. Local-first Docker runtime ✅
5. M4 - dashboard, plans, telemetry, repository browsing and guarded restore ✅
6. M5 - persistent Transfer/Copyarr engine ✅
7. M6 - device / PCWatch integration 🚧
8. M7 - richer restore workflows
9. M8 - recovery torture testing
10. M9 - architecture/security review

See `docs/local-first.md`, `docs/architecture.md`, `docs/control-plane.md`, `docs/dashboard.md`, `docs/transfers.md`, `docs/devices.md`, `docs/releases.md`, `unraid/README.md` and `docs/unraid-agent.md` for the invariants later milestones must preserve.
