# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**Pre-acceptance hardening – recover Nexus Backup itself**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid repository integrity health, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native repository integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`

Active branch: `emergency-recovery-kit`

Active PR: **#23 – Emergency recovery kit for Nexus Backup**. Keep it draft until the final branch head has passed the full Node/typecheck, Linux/native-Windows workstation, installer/template and Docker-image CI gates.

Do not call the product ready for real-machine acceptance until the remaining pre-acceptance gates below are closed.

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

A standard `restic check` is repository consistency evidence, not proof that selected files can be recovered byte-for-byte. Acceptance still requires an actual staging restore plus byte/hash/content verification.

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

## M8 resilience/failure work – merged

Deterministic torture coverage includes controller recreation during a lease, expired leases/re-leasing, stale-token rejection, offline recovery rejection, backup deferral while recovery owns a workstation, explicit 409 vs transient 5xx/network handling, full descendant process-tree cancellation, repository auth/unavailable/lock/disk-full failures, interrupted write-restore behavior, Windows Job Object kill-on-close containment, and protection of previous successful backup history.

CI runs workstation-agent test/vet on both Linux and native Windows, plus Windows cross-build and full Docker/release validation.

## Emergency recovery – PR #23

`emergency-recovery-kit` adds a recovery path for losing Nexus Backup itself while repositories/persistent state survive.

Implemented on the branch:

- `apps/local-server/bin/emergency-export.mjs`
- consistent live SQLite snapshot using `quick_check` + `VACUUM INTO` + snapshot `integrity_check`
- control identity/auth files copied into the bundle
- complete generic-agent config/secrets tree copied into the bundle
- SHA-256 + size manifest for every bundled file
- Nexus version/revision and applied migration list in the manifest
- verification rejects changed/missing/extra files and bad SQLite integrity
- manifest database paths must be safe relative paths inside the hash-verified bundle inventory
- database snapshot names cannot escape control config
- source/output overlap checks resolve real filesystem paths, including symlinked ancestors, before creating directories
- nested symlink-parent overlap is rejected without leaving directories inside source config
- bundle content symlinks are rejected so a bundle cannot silently depend on another host path
- existing bundle directories are never overwritten
- emergency exporter CLI/library are included in the normal JS syntax gate
- tests cover live WAL state, preserved secrets, corruption/tamper detection, manifest path traversal, database-name traversal, direct/symlinked/prospective overlap, existing-output refusal and symlink refusal
- `docs/emergency-recovery.md` describes healthy export, stopped-stack export, immutable off-host storage, isolated disaster inspection, rollback and direct repository recovery

Important recovery design decision: the first restored controller boot uses **disposable inspection volumes** on a loopback-only alternate port with no workers connected. Normal schedulers are not given a special recovery mode; if they mutate scheduler/job state during inspection, that state is thrown away. Production recovery volumes are recreated a second time from the unchanged verified emergency bundle before any worker reconnects.

The emergency bundle intentionally excludes backup payloads/source data/restore staging/disposable caches and workstation-local repository secrets. It contains privileged secrets and must be stored encrypted off-host. Its SHA-256 manifest detects corruption/inventory changes relative to the manifest; it is not a cryptographic signature against an attacker able to replace both bundle contents and manifest.

The runbook is not considered proven until the disposable recovery drill in the document has actually been performed.

## Product gaps before a real workstation acceptance test

- finish final CI/review and merge PR #23
- fresh deployment/install/acceptance docs for Unraid + Windows without relying on chat history
- M9 architecture/security review with all high-severity findings resolved
- final preflight review of the exact isolated acceptance procedure

## Real-machine acceptance once code is ready

Use a disposable `NexusBackup-Test` dataset and preferably an isolated test repository first. Required real-world proof includes:

- normal backup
- snapshot inventory and browse
- standard repository integrity check
- dry-run preview
- real staging restore
- byte/hash/content verification of restored data
- controller restart
- agent restart
- temporary network loss
- repository unavailable
- interrupted write restore

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
