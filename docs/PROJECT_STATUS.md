# Nexus Backup project status

Last updated: 2026-09-13

This is the durable handoff for future sessions. Read it before changing the project. The repository, not chat history, is the source of truth.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery/transfer system for Docker/Unraid plus Windows workstations. Remote control may be optional later, but it must never be required for normal backup/recovery and backup payloads must never traverse Control, Cloudflare or PCWatch.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not modify or retire them until each corresponding real workload has been migrated and proven, including restore/content verification where applicable.

## Current milestone

**Final acceptance preflight – self-contained Windows -> Unraid Repository path**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid integrity, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`
- fresh install + isolated acceptance runbook, PR #24: `3963a17104689ad8bbd63d5d1c7325cf3965df86`
- M9 architecture/security hardening, PR #25: `e375ae4919ebe589be228c399cd133db849ce04b`

Active branch: `self-contained-repository-endpoint`

Active draft PR: **#26 – Self-contained workstation Repository endpoint**.

M9 is complete. The final preflight of the merged architecture found one genuine product gap: the generic Agent `/backup` mapping is not a Windows-accessible repository service, so the intended Balder-PC -> Unraid path still depended on an external service. PR #26 closes that gap with NexusBackup-Repository rather than documenting around it.

Do not call the product ready for real-machine acceptance until #26 final-head CI, security/diff review and a repeated acceptance preflight are complete.

## Architecture after PR #26

The local Unraid product consists of three coordinated containers:

1. **NexusBackup-Control** — UI/API/auth/SQLite/orchestration only.
2. **NexusBackup-Agent** — generic Restic/rclone/transfer execution and generic storage credentials.
3. **NexusBackup-Repository** — TLS-authenticated Restic REST endpoint dedicated to Windows workstation repositories.

Windows backup data path:

```text
Windows Restic -> TLS -> NexusBackup-Repository -> dedicated Unraid repository storage
```

Control is not in this path.

Repository uses official `rest-server` v0.14.0 pinned to the Linux-amd64 release SHA-256 at image build. It generates a self-signed TLS certificate, requires TLS 1.3, bcrypt htpasswd authentication and private per-user repository namespaces. A CA-only bootstrap port exposes no secrets; the workstation installer pins the downloaded certificate to the SHA-256 copied from the local Repository helper.

REST transport credentials remain local to Repository + workstation. The separate Restic encryption password remains workstation-local. Control receives neither.

## Current PR #26 safety rules

- Repository `/data` defaults to `/mnt/user/backups/nexus-backup/workstations`.
- generic Agent `/backup` defaults to `/mnt/user/backups/nexus-backup/generic`.
- CI requires those roots to be distinct and neither may contain the other.
- Repository container has no Control DB, generic source, generic restore or FUSE access.
- Repository is non-privileged and receives no `SYS_ADMIN`/`/dev/fuse`.
- workstation REST credentials require `rest:https://`.
- workstation CA must be a local pinned certificate file.
- REST username/password + CA + repository URL are local workstation config only.
- Restic child processes receive authoritative local REST/TLS env; stale process `RESTIC_*` values are removed.
- normal workstation runtime **never auto-initializes a remote repository after a failed probe**.
- remote Repository initialization happens only during explicit installer provisioning of the exact CA-pinned/authenticated endpoint; afterward remote `autoInit=false`.
- repository/auth/TLS/network failures therefore fail closed.
- Repository URL/username/password/CA path/encryption password must remain absent from Control/browser-visible telemetry/errors.

## Current CI state for PR #26

Node/typecheck, Linux Go, native Windows Go, PowerShell installer parse, Unraid template validation and all three image builds have passed on recent PR heads.

The remaining active failure is isolated to the live Repository integration test: the Repository container exits during startup before the CA bootstrap endpoint remains available. Current head adds explicit CI diagnostics (`docker inspect`, Repository logs and `rest-server --help`) so the next run identifies the exact runtime failure rather than only showing curl connection resets.

Do not treat the Repository path as implemented until CI performs a real authenticated TLS `restic init` + `restic cat config` against the built Repository image and rejects invalid credentials.

## Completed M9 security review

`docs/security-review-m9.md` is the review matrix. PR #25 fixed the important pre-acceptance findings:

- local Agent telemetry/failure credential redaction;
- sanitized browser config no longer exposes raw Restic/rclone locations;
- generic write restore is fresh staging-only with `--overwrite never`;
- forwarded Host/Proto are not trusted for installer/public-origin security decisions;
- destructive managed cleanup requires exact size + modification-time provenance;
- default Agent no longer gets SYS_ADMIN/FUSE;
- CI action dependencies used by the main CI workflow are commit-pinned.

There were no known open HIGH findings when #25 merged. Re-evaluate if #26 creates a new boundary regression.

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

`docs/fresh-install.md` now documents Control + Agent + Repository deployment and per-workstation Repository onboarding.

`docs/acceptance-test.md` now tests the actual intended path:

```text
Balder-PC -> TLS -> NexusBackup-Repository -> isolated Unraid storage
```

Required real proof still includes normal backup, inventory/browse, repository integrity, dry-run, real fresh staging restore, independent byte/hash verification, Control/Agent/Repository/workstation restarts, temporary Control-path loss, Repository outage, interrupted write restore and a final post-fault staging restore/hash PASS.

CI is only a prerequisite; it does not replace this real restore proof.

## Explicit beta / pre-production gaps

These are not silently treated as solved:

- plain-HTTP Control-hosted workstation installation assumes a trusted LAN/host; HTTPS + explicit `NEXUS_BACKUP_PUBLIC_URL` is stronger. Repository traffic itself is TLS/CA-pinned.
- first-run Control setup token is visible to privileged container logs until setup, then removed.
- Control/Agent/Repository run as root inside non-privileged containers; default mounts/capabilities are constrained. Non-root runtime remains later Unraid-compatibility hardening.
- base/build image tags are not all digest-pinned; acceptance must record exact built image digests.
- generic FUSE/SYS_ADMIN remains explicit opt-in only for the optional mounted remote-source feature.

### Production recovery-key gate

PR #26 deliberately keeps workstation encryption secrets out of Control. That means total workstation loss cannot be recovered solely from the existing Control/generic-Agent emergency bundle.

Before **production cutover**, Nexus still needs and must prove an off-host recovery procedure for:

- each workstation Restic encryption password/recovery key;
- NexusBackup-Repository `/config` (TLS key/certificate, htpasswd and local transport credential material), or a documented safe credential/certificate reconstruction flow;
- the relationship between the recovered workstation identity/repository namespace and the encrypted repository payload.

The isolated acceptance test may use disposable secrets/repositories, but passing that test does not waive this production recovery gate.

## Remaining gates before “Nu tester vi”

1. diagnose/fix the Repository container startup failure in PR #26;
2. require final-head CI green, including real TLS/authenticated Restic init/open against NexusBackup-Repository;
3. finish Unraid/package/status documentation and release-image wiring;
4. review sensitive #26 patches and clear review threads;
5. merge #26;
6. rerun the complete acceptance-preflight against merged `main` and exact coordinated image set;
7. only then invite the isolated real-machine acceptance drill.

## Roadmap after isolated workstation proof

- implement/prove workstation encryption-key + Repository-config off-host recovery;
- cut over Balder-PC only after that production recovery gate;
- prove/cut over Martin-PC -> Unraid separately;
- prove Unraid -> Google Drive;
- prove Seedbox -> Unraid and compare before retiring standalone Copyarr;
- close telemetry/UX gaps found by real use;
- first stable release only after real restore proof and production recovery/security sign-off.

## Working rule

Update this file on every substantial milestone, merge, newly discovered blocker or changed next step. Keep it factual; do not let green CI or an implemented feature imply real-world proof that has not happened.
