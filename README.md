# Nexus Backup

Nexus Backup is a self-contained backup and transfer platform for Nexus. The primary deployment is local-first: a Docker control-plane/UI container owns the local API and SQLite database, while separate data-plane agents hold credentials and move backup data directly.

Cloudflare is optional remote control, never a requirement for normal operation and never part of the backup data path.

For the current milestone, active PR and exact next steps, read `docs/PROJECT_STATUS.md`. That file is the durable handoff between development sessions; the roadmap below is intentionally higher level.

## Current capabilities

### Core engine

- shared job state machine and durable job events
- idempotent operation keys
- leases, heartbeats and stale-lease recovery
- compare-and-swap revisions and atomic job/event mutations
- authenticated local UI plus token-authenticated agents/devices
- local SQLite is authoritative in self-contained mode

### Backup and restore

- local Restic backups
- read-only rclone FUSE sources feeding Restic
- local recurring backup plans with timezone-aware scheduling
- plan-scoped Restic retention maintenance with repository locking
- repository inventory and snapshot browsing
- restore preview plus guarded write restore to locally configured targets
- live progress and bounded logs in the dashboard

### Workstation backups and recovery

M6/M7 add Nexus-owned Windows workstation backup and recovery without routing backup bytes or repository credentials through the control plane:

- Windows x64 workstation agent with a direct one-line PowerShell `irm` installer
- self-contained install/repair/update flow served by the local Nexus control container
- the control image bundles the matching workstation executable, pinned Restic binary and SHA-256 checksums
- target workstations do not need GitHub or Internet access to install/repair the agent
- one-shot 15-minute enrollment credentials rotate directly to durable workstation credentials on first contact
- workstation policy in Nexus: source paths, excludes, schedule, timezone and retention
- Restic executes on the workstation and uses VSS filesystem snapshots on Windows
- repository location and Restic password remain only in `C:\ProgramData\NexusBackup`
- endpoint jobs use device authentication plus expiring per-run lease tokens
- expired backup leases are safely requeued; interrupted write restores require manual retry
- Restic exit code 3 is reported as a partial backup rather than success
- repository initialization is automatic only for missing local filesystem repositories; remote repository errors are never treated as permission to initialize
- live workstation progress, last successful backup, snapshot ID, next run and storage readiness appear in the Workstations dashboard
- snapshot inventory, non-recursive browse and dry-run restore preview
- write restore is staging-only, uses `--overwrite never`, never uses `--delete`, and requires a recent exact preview
- workstation repository URLs and passwords are never persisted in Nexus or PCWatch

See `docs/workstations.md` for installation, storage setup and trust boundaries.

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

M6 includes a durable device trust layer for workstation agents and future integrations:

- authenticated local admins can enroll, disable and rotate device credentials
- device bearer secrets are shown once; only SHA-256 hashes are stored
- devices report bounded version, hostname, platform and capability metadata
- online/offline state and capabilities are visible in the dashboard
- device reports do not accept storage credentials or arbitrary shell commands

PCWatch is deliberately outside the Nexus backup data/status path. It may be used to execute the generated workstation `irm` installer command, but Nexus Backup remains the source of truth for workstation backup policy, progress and history.

See `docs/devices.md` for the device trust boundary.

### Self-contained Docker runtime

- `Dockerfile.local` runs the authenticated local API/UI and SQLite database
- `Dockerfile.agent` runs server-side rclone/restic/FUSE execution
- `compose.yaml` joins them into one application
- control and agent tokens are generated automatically and persisted locally
- the agent token is shared through a private runtime volume
- migrations are applied automatically at startup
- the control image carries the matching Windows workstation payload used by local `irm` installs
- coordinated releases use immutable SemVer tags plus a stable `latest` Docker update channel
- SemVer releases may also publish the Windows workstation executable as a GitHub Release asset for standalone distribution; local installs do not depend on it
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
apps/local-server      Authenticated local host, scheduler and dashboard
apps/agent             Server-side rclone/restic/FUSE execution agent
apps/workstation-agent Windows workstation Restic backup agent
config                 Local server-agent configuration example
migrations             Shared SQLite/D1 schema migrations
docs                   Architecture and runtime notes
unraid                  Beta Unraid templates and install notes
```

## Development

Requires Node.js 22+, TypeScript 5.8+ and Go 1.24+ for the workstation agent.

```bash
npm ci
npm test
npm run typecheck
cd apps/workstation-agent && go test ./...
```

CI validates Node tests/typecheck, workstation-agent tests and vet on Linux and Windows, the Windows cross-build, the PowerShell installer, bundled workstation payload checksums, both Docker images, release metadata and the beta Unraid template contracts.

## Remote control

Remote control is an optional capability layered on top of the local installation. The Worker/D1 adapter is retained as a possible remote host, but the local SQLite instance remains authoritative for the self-contained deployment. Remote-control design must not require backup payloads, storage credentials, or raw local filesystem paths to transit the remote service.

## Roadmap

1. M1 - Core engine and agent lifecycle ✅
2. M2 - Portable control-plane API and persistence ✅
3. M3 - rclone + Restic execution pipeline ✅
4. Local-first Docker runtime ✅
5. M4 - dashboard, plans, telemetry, repository browsing and guarded restore ✅
6. M5 - persistent Transfer/Copyarr engine ✅
7. M6 - managed devices + workstation backup ✅
8. M7 - workstation recovery workflow ✅
9. M8 - recovery/failure torture testing 🚧
10. M9 - architecture/security review

See `docs/PROJECT_STATUS.md` for the live handoff and `docs/local-first.md`, `docs/architecture.md`, `docs/control-plane.md`, `docs/dashboard.md`, `docs/transfers.md`, `docs/devices.md`, `docs/workstations.md`, `docs/releases.md`, `unraid/README.md` and `docs/unraid-agent.md` for the invariants later milestones must preserve.
