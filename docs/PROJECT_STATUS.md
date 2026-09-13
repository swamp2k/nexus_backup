# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**Pre-acceptance hardening – fresh install + isolated acceptance procedure**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid repository integrity health, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native repository integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- self-contained emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`

Active branch: `fresh-install-acceptance-docs`

Active PR: **#24 – Fresh install safety and isolated acceptance runbook**. Keep draft until the final head passes full CI and the safety/runbook diff has been reviewed.

Do not call the product ready for real-machine acceptance until M9/final preflight are closed.

## Completed platform/recovery capability

- local authenticated control plane and authoritative SQLite state
- Restic/rclone execution
- self-contained Docker/Unraid packaging
- workstation enrollment, policies, scheduling and Windows agent
- workstation snapshot inventory and non-recursive browse
- dry-run restore preview and staging-only write restore
- exact preview -> restore binding with 30-minute maximum preview age
- repository integrity checks for generic/Unraid repositories
- workstation-native repository integrity checks using only workstation-local repository credentials
- explicit UI health states for integrity not checked / checking / OK / failed
- emergency bundle for Nexus state/config with live-WAL SQLite snapshot, SHA-256 inventory, bundled recovery runbook and offline pinned-image guidance

A standard `restic check` is repository consistency evidence, not proof that selected files can be recovered byte-for-byte. Acceptance still requires an actual staging restore plus independent byte/hash/content verification.

## Recovery safety invariants

These are not negotiable unless the architecture is explicitly redesigned and reviewed.

- write restore is staging-only
- no browser/control-plane supplied Windows destination path
- `restic restore --overwrite never`
- no `--delete`
- write restore requires a recent exact completed dry-run preview
- one active operation per workstation
- interrupted/expired write restore is not automatically requeued; manual retry only
- stale lease tokens cannot mutate a newly leased run
- explicit stale-lease rejection cancels local leased work; transient communication/5xx failures do not
- recovery/failure/integrity jobs must not overwrite successful backup-history fields
- a locally completed backup is not authoritative success until the controller ACKs the exact leased result
- repository credentials stay local to the workstation/agent
- backup payloads never pass through Nexus control plane, Cloudflare or PCWatch
- generic-agent source paths must not be able to descend into their own backup repository or restore staging tree
- a fresh generic Agent must start inert; it must not acquire a source/repository/restore/remote definition from an example config automatically
- the beta Unraid `/data` mapping must default to a narrow placeholder source root, not the whole `/mnt/user` tree

## M8 resilience/failure work – merged

Deterministic torture coverage includes controller recreation during a lease, expired leases/re-leasing, stale-token rejection, offline recovery rejection, backup deferral while recovery owns a workstation, explicit 409 vs transient 5xx/network handling, full descendant process-tree cancellation, repository auth/unavailable/lock/disk-full failures, interrupted write-restore behavior, Windows Job Object kill-on-close containment, and protection of previous successful backup history.

CI runs workstation-agent test/vet on both Linux and native Windows, plus Windows cross-build and full Docker/release validation.

## Emergency recovery – merged

PR #23 / `9eb2e5c3...` provides a self-contained Nexus recovery bundle and `docs/emergency-recovery.md`.

The bundle includes controller SQLite/auth/identity, generic-agent config/secrets, a full hash-verified copy of the runbook, version/revision/migrations and SHA-256 file inventory. It excludes backup payloads, source data, restore staging, disposable caches, workstation-local repository secrets and image archives. The runbook documents a separate offline `docker image save` archive for exact pinned control + agent images.

The first restored controller boot uses disposable inspection volumes on a loopback-only alternate port with no workers connected. Inspection state is discarded; production recovery volumes are recreated from the unchanged verified bundle before reconnecting workers.

The recovery runbook is still not field-proven until its disposable drill is executed.

## Fresh install / acceptance – PR #24

Reviewing the real beta Unraid mappings found a safety hazard before documentation was finalized: the old Agent template exposed `/data -> /mnt/user`, `/backup` mapped a path beneath `/mnt/user`, and the old worked example was also the auto-created starter config with `paths: ["/data"]`. That combination could let a backup source see its own repository through another container path.

PR #24 fixes this in code, packaging and docs rather than relying only on warnings:

- new `config/agent.default.json` has empty sources/repositories/restore targets/rclone endpoints/rTorrent gates and empty tools
- `Dockerfile.agent` uses the inert file for `/app/defaults/agent.json`
- `config/agent.example.json` remains a worked example but narrows its example source to `/data/example-source`
- the Unraid Agent template now defaults `/data` to `/mnt/user/nexus-backup-source`, not all of `/mnt/user`
- regression tests require the starter config to stay inert and prohibit the worked example from using the whole `/data` mount as a source
- Docker image CI verifies the built Agent contains the inert starter config
- Unraid template CI locks the narrow `/data` default and rejects `/mnt/user` as the default
- `unraid/README.md` documents source/repository/restore containment and the deliberate inert first start
- `docs/fresh-install.md` defines a clean Unraid + Windows deployment without chat-history assumptions
- `docs/acceptance-test.md` defines an isolated `C:\NexusBackup-Test` proof with an independent SHA-256 reference manifest, dedicated test repository, backup/inventory/integrity/dry-run/staging restore, byte/hash verification, restart/control-outage/repository-outage/interrupted-restore tests and a final post-fault restore verification
- top-level README roadmap is refreshed; M8, integrity and emergency recovery are no longer shown as unfinished

Important acceptance prerequisite: NexusBackup-Agent's `/backup` mount is **not** a Windows-facing repository service. Final Windows -> Unraid proof requires a dedicated test-only Restic endpoint on Unraid that the Windows SYSTEM task can actually reach through the intended transport. If that endpoint is not provisioned, a local workstation-repository smoke test does not count as final acceptance.

PCWatch-backup and standalone Copyarr remain untouched throughout the acceptance drill, and the Nexus acceptance repository must never be shared with PCWatch.

## Product gaps before a real workstation acceptance test

- finish final CI/review and merge PR #24
- M9 architecture/security review with all high-severity findings resolved
- final preflight review of the exact isolated acceptance procedure

## Real-machine acceptance once code is ready

Use the disposable `NexusBackup-Test` dataset and an isolated test repository defined by `docs/acceptance-test.md`. Required real-world proof includes:

- normal backup
- snapshot inventory and browse
- standard repository integrity check
- dry-run preview
- real staging restore
- independent byte/hash/content verification of restored data
- controller restart
- generic-agent restart
- workstation-agent restart
- temporary Control-path loss
- repository unavailable
- interrupted write restore
- final post-fault integrity + staging restore + byte/hash PASS

Only after that proof should a real workstation be cut over from PCWatch-backup. Cut over one workstation at a time; never run PCWatch and Nexus writes against the same Restic repository concurrently.

## Remaining roadmap after workstation proof

- migrate and prove Martin-PC -> Unraid workload
- migrate and prove Unraid -> Google Drive backup workload
- migrate and prove Seedbox -> Unraid workload, then retire standalone Copyarr only after comparison
- complete global telemetry/activity/health gaps as needed from real testing
- Nexus/PCWatch status integration as appropriate
- first stable release only after real restore proof and M9 sign-off

## Working rule for future sessions

At the end of every substantial milestone, bug batch, merge, or changed next-step decision, update this file in the same PR/commit series. The repo, not chat history, is the source of truth.
