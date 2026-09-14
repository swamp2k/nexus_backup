# Nexus Backup project status

Last updated: 2026-09-14

This is the durable handoff for future sessions. Read it before changing the project. The repository, not chat history, is the source of truth.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery/transfer system for Docker/Unraid plus Windows workstations. Remote control may be optional later, but it must never be required for normal backup/recovery and backup payloads must never traverse Control, Cloudflare or PCWatch.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not modify or retire them until each corresponding real workload has been migrated and proven, including restore/content verification where applicable.

## Current milestone

**Final acceptance preflight – verify the published RC through the actual Unraid deployment path.**

Merged on `main`:

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

PR #28 post-merge CI #258 was fully green on `44554518354babc017c27c4e141c28f459f02844`, including release-guard tests, native Windows, all three image builds, metadata/Compose gates and real Repository TLS/auth Restic integration.

## Published acceptance RC

GitHub Actions workflow **Publish release images #1** (run id `34822376934`) completed successfully from `main` source:

```text
version: 0.7.0-rc.1
source:  44554518354babc017c27c4e141c28f459f02844
```

Published immutable image identities:

```text
Control
  ghcr.io/swamp2k/nexus-backup-control:0.7.0-rc.1
  sha256:0bcd056540bfee4f7dd41fa68ce703ea52eb1db97bd781beb21814ca824daae7

Agent
  ghcr.io/swamp2k/nexus-backup-agent:0.7.0-rc.1
  sha256:a2a917486f50ecbff5c2bc10fd3a54753dbe9e0631457d98ee6dedab6ca2fc7c

Repository
  ghcr.io/swamp2k/nexus-backup-repository:0.7.0-rc.1
  sha256:3e2cb91a71923206541f1118fef33253b796b7302f6fb3bf307199b02e899c16
```

The manual RC path forced `stable=false`; release logs show `latest,enable=false`. The RC therefore did **not** move `latest`.

The next gate is not another build. The exact three images above must be pulled through the real Unraid/Docker path and the local image identities/labels must match the published source/version/digests.

Do not call the product ready for the isolated real-machine acceptance drill until that Unraid pull/digest gate and the final runbook preflight both pass.

## Architecture now on main / in RC

The local Unraid product consists of three coordinated containers:

1. **NexusBackup-Control** — UI/API/auth/SQLite/orchestration only.
2. **NexusBackup-Agent** — generic Restic/rclone/transfer execution and generic storage credentials.
3. **NexusBackup-Repository** — TLS-authenticated Restic REST endpoint dedicated to Windows workstation repositories.

Windows backup data path:

```text
Windows Restic -> TLS -> NexusBackup-Repository -> dedicated Unraid repository storage
```

Control is not in this path.

Repository uses official `rest-server` v0.14.0 pinned by SHA-256 at image build. It generates a self-signed TLS certificate, requires TLS 1.3, bcrypt htpasswd authentication and private per-user repository namespaces.

Repository exposes only TLS Restic on port 8000 by default. There is deliberately no HTTP CA/bootstrap service. The local `nexus-repository-client` helper carries the public CA certificate as base64 plus its SHA-256 into the same elevated PowerShell session used for workstation onboarding. The installer decodes the CA, verifies the hash locally and only then allows Restic to connect.

REST transport credentials remain local to Repository + workstation. The separate Restic encryption password remains workstation-local. Control receives neither.

## Repository / workstation safety rules

- Repository `/data` defaults to `/mnt/user/backups/nexus-backup/workstations`.
- generic Agent `/backup` defaults to `/mnt/user/backups/nexus-backup/generic`.
- CI requires those roots to be distinct and neither may contain the other.
- Repository has no Control DB, generic source, generic restore or FUSE access.
- Repository is non-privileged and receives no `SYS_ADMIN`/`/dev/fuse`.
- workstation REST credentials require `rest:https://` plus the locally supplied SHA-256-verified CA.
- REST username/password + CA + repository URL are local workstation config only.
- Restic child processes receive authoritative local REST/TLS env; stale process `RESTIC_*` values are removed.
- normal workstation runtime never auto-initializes a failed remote repository.
- remote Repository initialization happens only during explicit installer provisioning of the exact CA-pinned/authenticated endpoint; afterward remote `autoInit=false`.
- repository/auth/TLS/network failures fail closed.
- Repository URL/username/password/CA path/encryption password remain absent from Control/browser-visible telemetry/errors.

## Completed M9 security review

`docs/security-review-m9.md` is the review matrix. PR #25 fixed the important pre-acceptance findings, including Agent-side credential redaction, sanitized browser config, staging-only generic restore with `--overwrite never`, no forwarded-header trust for public origin, stronger destructive cleanup provenance, removal of default SYS_ADMIN/FUSE and pinned CI/release Actions.

There were no known open HIGH findings when #25 merged. PR #26 final sensitive-diff review found no new open HIGH finding.

## Non-negotiable recovery/restore invariants

- write restores are staging-only; never in-place;
- `restic restore --overwrite never`; no `--delete`;
- browser/controller chooses local restore target IDs, never raw write destinations;
- each generic write restore gets a fresh run/attempt-specific 0700 staging tree and refuses reuse;
- workstation restore requires a recent exact successful dry-run preview;
- interrupted/expired write restore is manual retry only;
- stale lease tokens cannot mutate replacement runs;
- failed/partial/integrity/recovery jobs do not replace previous successful backup state;
- locally completed workstation backup is not authoritative success until exact leased result is controller-ACKed;
- repository/storage credentials remain local to the execution/storage endpoint;
- fresh generic Agent starts inert;
- PCWatch-backup and standalone Copyarr remain untouched during isolated acceptance.

## Fresh install and acceptance docs

`docs/fresh-install.md` documents Control + Agent + Repository deployment and per-workstation Repository onboarding.

`docs/acceptance-test.md` tests the intended path:

```text
Balder-PC -> TLS -> NexusBackup-Repository -> isolated Unraid storage
```

Required real proof includes normal backup, inventory/browse, repository integrity, dry-run, real fresh staging restore, independent byte/hash verification, Control/Agent/Repository/workstation restarts, temporary Control-path loss, Repository outage, interrupted write restore and a final post-fault staging restore/hash PASS.

CI and the RC publish are prerequisites; neither replaces this real restore proof.

## Explicit beta / pre-production gaps

These are not silently treated as solved:

- plain-HTTP Control-hosted workstation installation assumes a trusted LAN/host; HTTPS + explicit `NEXUS_BACKUP_PUBLIC_URL` is stronger. Repository traffic itself is TLS/CA-pinned.
- first-run Control setup token is visible to privileged container logs until setup, then removed.
- Control/Agent/Repository run as root inside non-privileged containers; default mounts/capabilities are constrained. Non-root runtime remains later hardening.
- base/build image tags are not all digest-pinned; this acceptance RC is recorded by immutable published digest.
- generic FUSE/SYS_ADMIN remains explicit opt-in only for the optional mounted remote-source feature.
- actual anonymous/package pullability from the Unraid host is still unproven until the next gate is run.

### Production recovery-key gate

Nexus deliberately keeps workstation encryption secrets out of Control. Total workstation loss therefore cannot be recovered solely from the current Control/generic-Agent emergency bundle.

Before **production cutover**, Nexus still needs and must prove an off-host recovery procedure for:

- each workstation Restic encryption password/recovery key;
- NexusBackup-Repository `/config` (TLS key/certificate, htpasswd and local transport credential material), or a documented safe reconstruction flow;
- the relationship between recovered workstation identity/repository namespace and encrypted repository payload.

The isolated acceptance test may use disposable secrets/repositories, but passing it does not waive this production recovery gate.

## Remaining gates before “Nu tester vi”

1. pull Control, Agent and Repository `0.7.0-rc.1` through the actual Unraid Docker path and verify the pulled identities against the three immutable digests above;
2. verify the image version/revision labels are `0.7.0-rc.1` and `44554518354babc017c27c4e141c28f459f02844`;
3. rerun the final acceptance runbook preflight against those exact image identities;
4. only then start the isolated real-machine acceptance drill.

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
