# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**Pre-acceptance hardening – repository integrity and health**

M7 workstation recovery is merged. M8 resilience/failure batches are merged on `main`:

- M8 batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`

Active branch: `repository-integrity-health`

Active PR: **#21 – Repository integrity checks and health**

Do not call the product ready for real-machine acceptance until the remaining pre-acceptance gates below are closed.

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

## M8 resilience/failure work – merged

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
- controller-unreachable finish does not create local ghost success
- repository authentication/unavailable/locked/disk-full failures remain failures
- interrupted write restore leaves staging output but never auto-retries or reuses the same target
- hard Windows Scheduled Task/agent death cannot leave inherited Restic children running; Windows Job Object uses kill-on-close containment
- partial/failed backup results cannot replace the controller's last successful snapshot

CI runs workstation-agent test/vet on both Linux and native Windows, plus Windows cross-build and full Docker/release validation.

## Repository integrity/health – current work

Current PR #21 adds a first-class `restic-check` job:

- standard read-only `restic check`
- repository-local credentials only
- same per-repository Restic lock as backup/prune/inventory/restore
- normal lease cancellation and telemetry
- explicit tool failure on non-zero Restic exit
- repository UI derives health from authoritative `restic-check` jobs, separate from inventory state
- UI states distinguish not checked, checking, check OK and check failed
- failed integrity remains visible even if snapshot inventory is still readable

A standard `restic check` is repository consistency evidence, not a substitute for reading every data byte. Real acceptance still requires an actual staging restore plus byte/content/hash verification.

## Product gaps to close before asking for a real acceptance test

The aim is not merely green automated tests. Before telling the user the product is ready for a real end-to-end test, close/review these gates:

- finish and merge repository integrity/health PR #21
- emergency recovery runbook: restore data when Nexus Backup itself is unavailable
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

## Remaining product roadmap after workstation proof

- migrate and prove Martin-PC -> Unraid workload
- migrate and prove Unraid -> Google Drive backup workload
- migrate and prove Seedbox -> Unraid workload, then retire standalone Copyarr only after comparison
- complete global telemetry/activity/health gaps as needed from real testing
- Nexus/PCWatch status integration as appropriate
- first stable release only after real restore proof and M9 sign-off

## Working rule for future sessions

At the end of every substantial milestone, bug batch, merge, or changed next-step decision, update this file in the same PR/commit series. The repo, not chat history, is the source of truth.
