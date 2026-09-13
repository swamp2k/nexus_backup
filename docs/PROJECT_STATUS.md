# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**M8 – recovery/failure torture testing**

M7 workstation recovery is merged. M8 batch 1 is merged on `main` as `941d138bde505181c3fd36af2e4bcf6e5b0b8736`.

Active branch: `m8-failure-matrix`

Active PR: **#19 – M8: state reconciliation and repository failure matrix**

Keep this batch focused on resilience/state correctness; do not expand product scope here.

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
- recovery/failure must not overwrite successful backup-history fields
- a locally completed backup is not authoritative success until the controller ACKs the exact leased result
- repository credentials stay local to the workstation/agent
- backup payloads never pass through Nexus control plane, Cloudflare or PCWatch

## M8 batch 1 – merged

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

Confirmed bugs fixed in batch 1:

1. `recoverExpired()` requeued/failed a run but left `workstation_status.current_run_id` pointing at the dead lease.
2. `exec.CommandContext()` could kill only the immediate process while descendants retained stdout/stderr pipes.
3. Repository probe and `forget --prune` were outside the cancellable lease context.

CI runs workstation-agent test/vet on both Linux and native Windows, plus Windows cross-build and full Docker/release validation.

## M8 batch 2 – current work

Completed/covered so far:

- **Unacknowledged finish / ghost success:** a Restic backup that completes locally but cannot submit `finish` to the controller no longer advances local `LastSuccessAt` or `LastSnapshotID`. The previous known-good success is preserved and the failed ACK becomes visible in `LastError`.
- **Repository failure matrix:** authentication failure, unavailable repository, repository lock and disk-full style failures are fatal (not success/partial), and local repository/password configuration is redacted from surfaced errors.
- **Interrupted write restore:** cancellation leaves any partial staging output in place as an orphan for inspection; the same run/staging target cannot be reused. Retry requires a fresh manual restore/run id.
- **Hard Windows agent loss:** the workstation agent initializes a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; Restic descendants inherit containment, so killing/restarting the Scheduled Task/agent cannot leave an orphan `restic.exe` continuing against the repository. Native Windows CI includes a real parent-death/child-survival regression test.
- Unix explicit cancellation still uses isolated process groups; platform-independent command wrappers retain bounded wait behavior.

Remaining M8 batch 2 review points:

- verify final CI for latest Job Object implementation and image build
- review controller-side last-success/last-snapshot semantics for failed/partial results
- confirm no high-severity state-reconciliation gaps remain

## Product gaps to close before asking for a real acceptance test

The aim is not merely green M8 tests. Before telling the user the product is ready for a real end-to-end test, also close/review these known gaps:

- finish M8 production-focused failure matrix
- repository integrity operation (`restic check`) distinct from read-only inventory
- storage/repository health presentation sufficient to surface unavailable/locked/full/auth failures clearly
- emergency recovery runbook: how to restore data if Nexus Backup itself is unavailable
- M9 architecture/security review with high-severity findings resolved
- deployment/install/acceptance docs accurate enough to perform a fresh Unraid + Windows workstation install without chat history

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
