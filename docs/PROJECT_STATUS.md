# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**Pre-acceptance hardening – fresh install + isolated acceptance documentation**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid repository integrity health, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native repository integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- self-contained emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`

Active branch: `fresh-install-acceptance-docs`

Active PR: not opened yet. Build/review the documentation from the actual current templates, installer and runtime contracts before opening it.

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
- emergency bundle for Nexus state/config with live-WAL SQLite snapshot, SHA-256 inventory, bundled recovery runbook and offline pinned-image guidance

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

## Emergency recovery – merged

PR #23 / `9eb2e5c3...` provides a self-contained Nexus recovery bundle and `docs/emergency-recovery.md`.

The bundle includes controller SQLite/auth/identity, generic-agent config/secrets, a full hash-verified copy of the runbook, version/revision/migrations and SHA-256 file inventory. It excludes backup payloads, source data, restore staging, disposable caches, workstation-local repository secrets and image archives. The runbook documents a separate offline `docker image save` archive for exact pinned control + agent images.

The first restored controller boot uses disposable inspection volumes on a loopback-only alternate port with no workers connected. Inspection state is discarded; production recovery volumes are recreated from the unchanged verified bundle before reconnecting workers.

The recovery runbook is still not field-proven until its disposable drill is executed.

## Fresh install + acceptance docs – current work

The current branch must make a clean deployment reproducible without chat history. Documentation must be derived from current code/templates, not memory or guessed production paths.

Required coverage:

- fresh Unraid control + generic-agent deployment and persistent path contract
- first local-admin bootstrap and control/agent token behavior
- creation/validation of generic-agent `agent.json`, Restic password files and rclone config without exposing secrets to the controller
- Windows workstation enrollment through the self-contained direct PowerShell installer
- workstation-local repository/password/config ownership and expected Windows service/task lifecycle
- creation of an emergency bundle immediately after trusted bootstrap/configuration
- isolated `NexusBackup-Test` acceptance dataset and isolated Restic repository
- exact acceptance sequence: backup -> inventory/browse -> integrity -> dry-run -> staging restore -> byte/hash/content verification -> restart/network/repository/interrupted-restore cases
- explicit stop conditions and rollback rules
- PCWatch-backup and Copyarr remain untouched; no cutover or retirement during the acceptance drill

Do not invent Martin's production Unraid host paths in the generic docs. Where host mappings are deployment-specific, show safe placeholders and explain what property the chosen path must have.

## Product gaps before a real workstation acceptance test

- finish/review/merge fresh install + acceptance documentation
- M9 architecture/security review with all high-severity findings resolved
- final preflight review of the exact isolated acceptance procedure

## Real-machine acceptance once code is ready

Use a disposable `NexusBackup-Test` dataset and an isolated test repository first. Required real-world proof includes:

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
