# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**M8 – workstation resilience / torture testing**

M7 workstation recovery is merged on `main` at `05310c07ba38c35728c7f6621087754ad09a11e9`.

Active branch: `m8-recovery-torture`

Active PR: **#18 – M8: begin workstation recovery torture testing**

PR #18 remains draft until the first coherent M8 batch is green and reviewed.

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
- recovery must not overwrite successful backup-history fields
- repository credentials stay local to the workstation/agent

## M8 batch 1 findings

Initial deterministic torture tests cover:

- controller/service recreation during an active lease
- expired workstation leases and re-leasing
- stale lease-token rejection
- offline workstation recovery rejection
- due backup deferral while recovery owns the workstation
- workstation status consistency after lease recovery

Confirmed bug found and fixed on PR #18:

- `recoverExpired()` requeued/failed a run but left `workstation_status.current_run_id` pointing at the dead lease. The fix clears status only if it still references the exact recovered run, so a newer run cannot be clobbered.

The agent was also changed to distinguish an explicit stale-lease rejection (HTTP 409) from a transient communication/5xx failure. Only explicit lease loss should cancel local Restic execution.

## Current blocker on PR #18

Latest known CI before the current fix attempt: run #103 failed in the Go workstation-agent tests while Node tests were 134/134 green and typecheck was green.

Failure:

`TestExecuteBackupCancelsResticOnExplicitStaleLease`

Root cause discovered by Linux CI: cancelling `exec.CommandContext()` killed the immediate shell process, but a descendant (`sleep`) retained inherited stdout/stderr pipes. The operation therefore did not terminate promptly even though lease loss was correctly detected.

Current fix in progress on PR #18:

- added a small process-tree command abstraction
- Unix commands run in their own process group and cancellation kills the whole group
- Windows cancellation uses `taskkill /T /F` with direct process-kill fallback
- workstation backup now uses the process-tree-aware cancellable command

Do not weaken the stale-lease cancellation test to make CI green.

## Immediate next steps

1. Get PR #18 fully green on GitHub CI.
2. Apply the same process-tree cancellation semantics to cancellable recovery commands, especially write restore, and add/retain regression coverage.
3. Review the PR diff for race/state regressions and recovery-safety violations.
4. Merge M8 batch 1 as a small coherent unit.
5. Start M8 batch 2 rather than growing PR #18 indefinitely.

Suggested M8 batch 2 focus:

- agent process restart during backup/recovery
- controller unavailable shorter/longer than lease duration
- repository unavailable/authentication failure/lock
- controller unreachable during finish
- write restore interruption/orphaned staging behavior
- scheduler interactions with inventory/browse/preview/restore
- last-known-success state preservation under failures

## Real-machine acceptance still required

Automated tests do not make workstation backup/recovery proven.

Use a disposable `NexusBackup-Test` dataset and preferably an isolated test repository. Required real-world proof includes:

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

Do not retire PCWatch-backup before an actual restored workstation file has been inspected and verified successfully.

## Remaining product roadmap after workstation proof

- migrate and prove Martin-PC -> Unraid workload
- migrate and prove Unraid -> Google Drive backup workload
- migrate and prove Seedbox -> Unraid workload, then retire standalone Copyarr only after comparison
- add repository integrity checking (`restic check`) and stronger storage-health reporting
- complete global telemetry/activity/health gaps
- emergency/self-recovery runbook so Nexus Backup can be recovered without relying on Nexus Backup itself
- Nexus/PCWatch integration as appropriate
- M9 architecture/security review before calling the first release stable

## Working rule for future sessions

At the end of every substantial milestone, bug batch, merge, or changed next-step decision, update this file in the same PR/commit series. The repo, not chat history, is the source of truth.
