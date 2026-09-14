# Nexus Backup project status

Last updated: 2026-09-14

This is the durable handoff for future sessions. Read it before changing the project. The repository, not chat history, is the source of truth.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery/transfer appliance for Unraid plus Windows workstations. Remote control may be optional later, but it must never be required for normal backup/recovery and backup payloads must never traverse Control, Cloudflare or PCWatch.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not modify or retire them until each corresponding real workload has been migrated and proven, including restore/content verification where applicable.

## Current milestone

**PR #30 – collapse the Unraid product into one app / one container before real acceptance.**

User/product decision: Nexus Backup must present as one Community Apps entry and one normal Unraid container. The previous three-container packaging is no longer the acceptance target.

The new appliance image is:

```text
ghcr.io/swamp2k/nexus-backup:<version>
```

It runs three coordinated internal processes:

```text
Control     :8787  UI/API/auth/SQLite/orchestration
Agent              local Restic/rclone/transfer execution, Control via 127.0.0.1
Repository  :8000  TLS Restic REST endpoint for Windows workstations
```

The supervisor starts Control + Repository, waits for the locally generated Agent token, starts Agent, and terminates the whole appliance if any core process exits. Unraid/Docker restart policy then recovers the coordinated unit.

## Merged history before the packaging pivot

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid integrity, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`
- fresh install + isolated acceptance runbook, PR #24: `3963a17104689ad8bbd63d5d1c7325cf3965df86`
- M9 architecture/security hardening, PR #25: `e375ae4919ebe589be228c399cd133db849ce04b`
- self-contained workstation Repository endpoint, PR #26: `33e06ad6b5ae24eaaf6301fbcfce4fcc64917cf1`
- guarded acceptance RC publishing, PR #27: `515ecbee832c23ad1768b1bcfdf0a282627dc663`
- acceptance RC handoff sync, PR #28: `44554518354babc017c27c4e141c28f459f02844`
- first RC identity status sync, PR #29: `451366016aea577d4edeb6c46b32cc33254bb766`

## Historical three-image RC

`0.7.0-rc.1` was successfully published from `44554518354babc017c27c4e141c28f459f02844` and its three immutable image digests were recorded. It proved the guarded publishing path and GHCR push mechanics.

That RC is now **historical only**. Do not use it for real-machine acceptance because the final Unraid packaging decision changed afterward from three containers to one appliance container.

A new one-image RC must be published only after PR #30 is merged and post-merge main CI is green.

## Single-container architecture under PR #30

Persistent layout inside the one appliance:

```text
/config/control       Control DB/auth/secrets
/config/agent         Agent config and local storage credentials
/config/repository    Repository TLS/auth/client material
/state                Agent caches/state
/backup/generic       Generic Restic repositories
/backup/workstations  Windows workstation Restic repositories
```

Default Unraid mappings:

```text
/config      /mnt/user/appdata/nexus-backup
/state       /mnt/user/appdata/nexus-backup-state
/data        /mnt/user/nexus-backup-source          read-only
/backup      /mnt/user/backups/nexus-backup
/restore     /mnt/user/restore/nexus-backup
/downloads   /mnt/user/downloads
```

The runtime Agent token is no longer a persistent/shared host mapping. It lives beneath `/run/nexus-backup` for the container lifetime.

The appliance remains non-privileged by default. No `SYS_ADMIN` or `/dev/fuse` is granted unless the optional mounted remote-source feature is explicitly enabled.

## Accepted packaging security trade-off

The old three-container model had stronger Docker mount-namespace isolation between Control, Agent and Repository. The one-container Unraid product intentionally gives up that boundary in exchange for one install/update/app surface.

Security therefore relies on the remaining boundaries: read-only source mounts, constrained host mappings, application-level path validation, staging-only restores, credential redaction, local-only Control/Agent transport, TLS/auth for workstation repository traffic and no default elevated container privileges.

This is accepted for the Unraid target. Nexus must not assume the Unraid host itself is a hostile multi-tenant security boundary.

## Workstation data path

The logical data path is unchanged by packaging:

```text
Windows Restic -> TLS -> Repository process -> /backup/workstations
```

Backup payloads still do not pass through Control.

Repository uses official `rest-server` v0.14.0 pinned by SHA-256 at image build, TLS 1.3, bcrypt htpasswd authentication and private per-user namespaces. The local `nexus-repository-client` helper carries the public CA as base64 plus SHA-256 into workstation onboarding; there is no HTTP CA bootstrap endpoint.

REST transport credentials remain local to Repository + workstation. The separate Restic encryption password remains workstation-local. Control receives neither.

## Non-negotiable restore/recovery invariants

- write restores are staging-only; never in-place;
- `restic restore --overwrite never`; no `--delete`;
- browser/controller chooses local restore target IDs, never raw write destinations;
- each generic write restore gets a fresh run/attempt-specific staging tree and refuses reuse;
- workstation restore requires a recent exact successful dry-run preview;
- interrupted/expired write restore is manual retry only;
- stale lease tokens cannot mutate replacement runs;
- failed/partial/integrity/recovery jobs do not replace previous successful backup state;
- locally completed workstation backup is not authoritative success until its leased result is controller-ACKed;
- repository/storage credentials remain local to the execution/storage endpoint;
- fresh Agent starts inert;
- PCWatch-backup and standalone Copyarr remain untouched during isolated acceptance.

## PR #30 CI requirements

Do not merge #30 merely because Node/typecheck are green. Final-head CI must prove:

- Node tests + typecheck;
- Linux Go tests/vet/cross-build;
- native Windows Go tests/vet;
- PowerShell installer syntax + self-contained asset contract;
- exactly one Unraid XML template: `nexus-backup.xml`;
- exactly one default Compose service/image;
- unified image contains Control, Agent, Repository, workstation payloads and emergency recovery assets;
- fresh Agent config remains inert;
- one real appliance container reaches Control health + Agent online + Repository TLS service;
- real Restic can `init` and `cat config` through Repository TLS/auth;
- invalid Repository credentials fail;
- killing one core internal process causes the whole appliance container to terminate;
- version/revision image labels are correct;
- no default `SYS_ADMIN`, `/dev/fuse` or privileged mode.

## Explicit beta / pre-production gaps

These are not silently treated as solved:

- plain-HTTP Control-hosted workstation installation assumes a trusted LAN/host; HTTPS + explicit `NEXUS_BACKUP_PUBLIC_URL` is stronger. Repository traffic itself is TLS/CA-pinned.
- first-run Control setup token is visible to privileged container logs until setup, then removed.
- internal processes currently run in the same non-privileged container namespace; non-root process separation may be considered later but is not a beta acceptance requirement.
- base/build image tags are not all digest-pinned; acceptance must record the exact published one-container RC digest.
- FUSE/SYS_ADMIN remains explicit opt-in only for the optional mounted remote-source feature.

### Production recovery-key gate

Before production cutover Nexus still needs and must prove an off-host recovery procedure for:

- each workstation Restic encryption password/recovery key;
- `/config/repository` TLS/auth/client material, or a documented safe reconstruction flow;
- the relationship between recovered workstation identity/repository namespace and encrypted repository payload.

The isolated acceptance test may use disposable secrets/repositories, but passing it does not waive this production recovery gate.

## Remaining gates before “Nu tester vi”

1. finish PR #30 code/docs and full final-head CI;
2. merge #30 and require full post-merge main CI;
3. publish one exact **single-image** prerelease from that main SHA without moving `latest`;
4. pull that immutable image through the actual Unraid Docker path and verify digest + version/revision labels;
5. rerun the final acceptance runbook preflight against the one-container deployment contract;
6. only then start the isolated real-machine acceptance drill.

## Roadmap after isolated workstation proof

- implement/prove workstation encryption-key + Repository-config off-host recovery;
- cut over Balder-PC only after that production recovery gate;
- prove/cut over Martin-PC -> Unraid separately;
- prove Unraid -> Google Drive;
- prove Seedbox -> Unraid and compare before retiring standalone Copyarr;
- close telemetry/UX gaps found by real use;
- first stable release only after real restore proof and production recovery/security sign-off.

## Working rule

Update this file on every substantial milestone, merge, newly discovered blocker or changed next step. Keep it factual; do not let green CI, a published image or an implemented feature imply real-world proof that has not happened.
