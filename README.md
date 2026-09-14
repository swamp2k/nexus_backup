# Nexus Backup

Nexus Backup is a self-contained local-first backup, recovery and transfer appliance for Unraid plus Windows workstations.

The primary deployment is deliberately **one Docker container / one Unraid app**. Inside it, three coordinated internal services run together:

- **Control** — authenticated WebUI/API, SQLite, schedules and orchestration;
- **Agent** — local Restic/rclone/transfer execution;
- **Repository** — TLS-authenticated Restic REST endpoint for Windows workstation backups.

Cloudflare may be an optional remote-control layer later, but it is never required for normal operation and backup payloads must never traverse Control, Cloudflare or PCWatch.

For the exact current milestone read `docs/PROJECT_STATUS.md`. For deployment use `docs/fresh-install.md`; for the isolated real-machine proof use `docs/acceptance-test.md`; for recovery when Nexus itself is unavailable use `docs/emergency-recovery.md`.

## Why one container?

Nexus originally used separate Control, Agent and Repository containers. That gave stronger Docker mount-namespace isolation, but on Unraid it also meant three Community Apps/install/update surfaces for what is conceptually one product.

The final Unraid packaging instead favors the normal appliance experience:

```text
Community Apps -> Nexus Backup -> Install
```

One image, one container, one WebUI and one update action. The internal roles still keep separate config/storage directories and logical credential boundaries, but they share the appliance container namespace. This trade-off is explicit and documented in `docs/single-container-appliance.md`.

The default container is non-privileged and receives no `SYS_ADMIN` or `/dev/fuse`. FUSE remains an explicit advanced opt-in only for the optional rclone-mounted remote-source feature.

## Data paths

Generic local jobs:

```text
/data (read-only source) -> Agent -> Restic/rclone -> /backup/generic or configured remote
```

Windows workstations:

```text
Windows Restic -> TLS :8000 -> Repository -> /backup/workstations
```

Control is not in the workstation backup byte path. Repository REST credentials and workstation Restic encryption passwords remain outside Control/browser-visible state.

## Core capabilities

- durable local SQLite job engine with leases, heartbeats, idempotency and recovery;
- Restic backup, repository inventory, integrity checks and retention;
- staging-only guarded restore with `--overwrite never` and no `--delete`;
- rclone copy/transfer engine with Copyarr-style stability, verification and guarded move/cleanup;
- Windows x64 workstation agent with local Restic/VSS execution;
- one-line Control-hosted PowerShell enrollment/install flow;
- per-workstation TLS-authenticated Repository namespaces on Unraid;
- snapshot inventory/browse, dry-run preview and real staging restore;
- live bounded telemetry with credential redaction;
- local admin auth and CSRF/session protections;
- emergency export/verification of Nexus Control + generic-Agent state;
- optional future remote control without moving backup payloads through it.

Existing PCWatch-backup and standalone Copyarr remain fallback systems until each corresponding real workload has passed actual restore/content verification and an explicit cutover.

## Workstation safety contract

Workstation repository credentials live only in the Windows local config and Repository service. Control does not receive them.

Write restore is staging-only:

- browser never supplies a raw Windows destination;
- restore requires a recent exact successful dry-run preview;
- `restic restore --overwrite never`;
- no delete behavior;
- interrupted write restore requires manual retry;
- failed/partial/integrity/recovery operations cannot replace previous successful backup state.

See `docs/workstations.md` and `docs/acceptance-test.md`.

## Transfer safety contract

Managed transfers use:

- stable object generations based on path/size/modification time;
- staging -> exact verification -> commit -> final verification;
- local `allowMove` opt-in before source deletion;
- size + modification-time provenance before cleanup deletion;
- bounded retries and optional rTorrent readiness gating;
- safety-critical rclone flags reserved by Nexus.

See `docs/transfers.md`.

## Single-container runtime

The root `Dockerfile` builds the complete appliance image:

```text
ghcr.io/swamp2k/nexus-backup:<version>
```

Persistent internal layout:

```text
/config/control       Control DB/auth/secrets
/config/agent         Agent config/storage credentials
/config/repository    Repository TLS/auth/client material
/state                Agent runtime/cache
/backup/generic       generic Restic repositories
/backup/workstations  Windows workstation repositories
```

The appliance supervisor starts Control + Repository, waits for the locally generated Agent token, then starts Agent. If any core service exits, the container exits as a unit so Docker/Unraid restart policy can recover a coordinated appliance rather than leave a half-working UI.

A fresh Agent config is intentionally inert: no source, repository, restore target or remote is preconfigured.

## Run locally

```bash
NEXUS_BACKUP_REPOSITORY_HOST=127.0.0.1 docker compose up --build
```

Then open `http://localhost:8787` and complete local first-run authentication.

For real storage set the path variables used by `compose.yaml`, or use the single beta Unraid template. Never map a source so broadly that it can descend into its own backup repository or restore staging tree.

## Unraid

There is exactly one beta template:

```text
unraid/templates/nexus-backup.xml
```

Default host mappings are deliberately editable and conservative:

```text
/config      /mnt/user/appdata/nexus-backup
/state       /mnt/user/appdata/nexus-backup-state
/data        /mnt/user/nexus-backup-source          read-only
/backup      /mnt/user/backups/nexus-backup
/restore     /mnt/user/restore/nexus-backup
/downloads   /mnt/user/downloads
```

See `unraid/README.md`.

## Recovering Nexus itself

Nexus can export a hash-covered emergency bundle containing a consistent Control SQLite snapshot, local Control identity/auth, generic Agent config/secrets and the complete recovery runbook.

The bundle intentionally does not claim to solve workstation encryption-key or Repository TLS/auth recovery. Those require a separate off-host recovery procedure before production cutover.

Keep an offline archive of the exact **single appliance image** alongside the encrypted emergency bundle so registry availability is not a disaster dependency.

See `docs/emergency-recovery.md`.

## Repository layout

```text
packages/core          domain model, state machine, leases and repository contracts
apps/control-plane     portable API plus optional Cloudflare/D1 adapter
apps/local-server      authenticated local host, scheduler and dashboard
apps/agent             local rclone/restic/transfer execution
apps/workstation-agent Windows workstation Restic agent
appliance              one-container supervisor/bootstrap
repository             internal TLS Restic server bootstrap/client helper
config                 inert Agent starter + worked example
migrations             SQLite/D1 schema migrations
docs                   architecture, install, acceptance and recovery notes
unraid                  single-app beta packaging
```

## Development

Requires Node.js 22+, TypeScript 5.8+ and Go 1.24+.

```bash
npm ci
npm test
npm run typecheck
cd apps/workstation-agent && go test ./...
```

CI validates Node/typecheck, Go on Linux and native Windows, PowerShell installer contracts, the single Unraid template, the unified image, bundled workstation/emergency assets, inert Agent startup, a real authenticated TLS Restic Repository flow, fail-as-one-unit supervision, image metadata and one-service Compose packaging.

## Remote control

The Worker/D1 adapter remains available as a possible future remote host, but local SQLite remains authoritative for the self-contained deployment. Remote-control design must never require backup payloads, storage credentials or raw local filesystem paths to transit the remote service.

## Roadmap

1. Core engine / local runtime / dashboard / plans / restore ✅
2. Transfer/Copyarr engine ✅
3. Managed devices + Windows workstation backup/recovery ✅
4. Failure/resilience + repository integrity + emergency recovery ✅
5. M9 architecture/security review ✅
6. One-container Unraid appliance packaging 🚧
7. Publish exact one-image RC + verify actual Unraid pull
8. Real-machine isolated Balder-PC backup -> restore -> hash proof
9. Off-host workstation encryption-key + Repository-config recovery proof
10. Staged production cutover: Balder-PC, Martin-PC, Unraid->Google Drive, Seedbox->Unraid
11. First stable release only after real restore and recovery sign-off
