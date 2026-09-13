# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove their underlying working implementations until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant. PCWatch's top-level legacy Backup/Destinations routes now point users toward the Nexus Software installer flow, but the old engine remains available as a rollback path during acceptance testing.

## Current milestone

**M8 – recovery/failure torture testing**

M7 workstation recovery is merged on `main` at `05310c07ba38c35728c7f6621087754ad09a11e9`.

M8 batch 1 is merged on `main` at `941d138bde505181c3fd36af2e4bcf6e5b0b8736`.

M8 batch 2 is focused on state reconciliation and failure injection. The first active slice is controller/finish outage reconciliation for workstation backups.

## Completed through M7

- local control plane, SQLite state and authenticated UI/API
- Restic/rclone execution
- self-contained Docker/Unraid packaging
- workstation enrollment, policies, scheduling and Windows agent
- workstation snapshot inventory
- non-recursive snapshot browsing
- restore dry-run preview
- write restore to an agent-generated staging directory
- exact preview -> restore binding with 30-minute maximum preview age
- recovery UI in Workstations

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
- recovery must not overwrite successful backup-history fields
- repository credentials stay local to the workstation/agent
- backup payloads never pass through Nexus control plane, Cloudflare or PCWatch
- a locally completed backup is not advertised as the latest Nexus success until the controller has accepted its terminal `finish` transition
- a re-leased backup must not create a second snapshot if the same run already has a durably confirmed Restic snapshot

## M8 batch 1 completed work

Deterministic torture coverage includes:

- controller/service recreation during an active lease
- expired workstation leases and re-leasing
- stale lease-token rejection
- offline workstation recovery rejection
- due backup deferral while recovery owns the workstation
- workstation status consistency after lease recovery
- explicit HTTP 409 lease rejection vs transient 5xx/network-like errors
- local Restic cancellation for backup and recovery
- descendant process-tree termination so wrapper/child processes cannot keep inherited pipes alive
- cancellation of repository probes and retention/prune after explicit lease loss
- recovery write cancellation remains failure/manual-retry-only

Confirmed bugs found and fixed:

1. `recoverExpired()` requeued/failed a run but left `workstation_status.current_run_id` pointing at the dead lease. It now clears status only if it still references the exact recovered run, so a newer run cannot be clobbered.
2. `exec.CommandContext()` killed the immediate process but could leave descendants alive with inherited pipes. Cancellable Restic commands now use a process-tree abstraction: Unix process groups are killed as a unit; Windows uses `taskkill /T /F` with direct-kill fallback and bounded wait.
3. Repository probe and `forget --prune` were outside the cancellable lease context. They are now lease-cancellable as well.

CI includes a real `windows-latest` workstation-agent test/vet job. Windows is not only cross-built.

## M8 batch 2: finish-outage reconciliation

The first batch 2 slice addresses this failure mode:

1. Restic commits a workstation snapshot locally.
2. The controller is unavailable while the agent sends `finish`.
3. The lease later expires and the same run is requeued/re-leased.
4. The agent must not blindly create a duplicate snapshot or advertise an unacknowledged success.

The reconciliation contract is:

- every workstation backup snapshot carries `nexus-run:<runId>` in addition to the workstation/device tag
- after a clean Restic success, the agent adds `nexus-run-complete:<runId>` as a second durable marker
- Restic changes a snapshot ID when tags are modified, so Nexus re-resolves and reports the current post-tag snapshot ID
- a re-leased run with exactly one snapshot carrying both run + completion markers is reconciled instead of backed up again
- a run-tagged snapshot without the completion marker is ambiguous (partial backup or crash window) and automatic duplicate backup is refused; manual reconciliation is required
- multiple snapshots matching one run tag are also an ambiguity/failure, never guessed
- if controller `finish` delivery fails, agent-local `LastBackupAt` / `LastSuccessAt` / `LastSnapshotID` are not advanced; the previous last-known-success remains authoritative until a later lease successfully reconciles and the controller accepts finish
- write restore does not use this reconciliation path; expired/interrupted write restore stays failed/manual-retry-only

Regression coverage includes successful second-lease reconciliation with no second `restic backup`, refusal of unconfirmed snapshots, and preservation of last-known-success when finish delivery is unavailable.

## Immediate next M8 batch 2 work

Continue failure injection rather than new product features:

- agent process restart during backup, including crash before/after snapshot completion marker
- agent process restart during inventory/browse/preview/write restore
- controller unavailable shorter than lease duration
- controller unavailable longer than lease duration (now expected to reconcile confirmed backup snapshots)
- repository unavailable
- repository authentication failure
- repository locked
- repository disappears mid-backup
- local repository disk-full behavior where practical to simulate
- write restore interruption/orphaned staging behavior
- scheduler interactions with inventory/browse/preview/restore
- last-known-success state preservation under all remaining failure cases

Do not fix tests by weakening safety invariants or by extending leases/timeouts to hide races.

## Product gaps to close before asking for a real acceptance test

The aim is not merely green M8 tests. Before telling the user the product is ready for a real end-to-end test, also close/review these known gaps:

- M8 failure matrix at a reasonable production-focused depth
- repository integrity operation (`restic check`) distinct from read-only inventory
- storage/repository health presentation sufficient to surface unavailable/locked/full/auth failures clearly
- emergency recovery runbook: how to restore data if Nexus Backup itself is unavailable
- M9 architecture/security review with high-severity findings resolved
- deployment/install docs accurate enough to perform a fresh Unraid + Windows workstation install without chat history

## Real-machine acceptance once code is ready

Use a disposable `NexusBackup-Test` dataset and preferably an isolated test repository first. Required real-world proof includes:

- normal backup
- snapshot inventory and browse
- dry-run preview
- real staging restore
- byte/content verification of restored data
- controller restart
- agent restart
- temporary network loss
- repository unavailable
- interrupted write restore

Only after that proof should a real workstation be cut over from PCWatch-backup. Cut over one workstation at a time; never run PCWatch and Nexus writes against the same Restic repository concurrently.

## Remaining product roadmap after workstation proof

- migrate and prove Martin-PC -> Unraid workload
- migrate and prove Unraid -> Google Drive backup workload
- migrate and prove Seedbox -> Unraid workload, then retire standalone Copyarr only after comparison
- complete global telemetry/activity/health gaps as needed from real testing
- Nexus/PCWatch status integration as appropriate
- first stable release only after real restore proof and M9 sign-off

## Working rule for future sessions

At the end of every substantial milestone, bug batch, merge, or changed next-step decision, update this file in the same PR/commit series. The repo, not chat history, is the source of truth.
