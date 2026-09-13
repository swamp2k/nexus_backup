# Nexus Backup project status

Last updated: 2026-09-13

This file is the durable handoff for future ChatGPT/Codex/Claude sessions. Read it before starting work. Keep it short, current, and factual.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery and transfer system intended to run primarily from Docker on Unraid. Remote control may be added as an option, but the primary system must remain usable without a cloud control plane.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not remove or modify them until their real workloads have been migrated to Nexus Backup and successfully proven, including restore/verification where relevant.

## Current milestone

**M9 architecture/security review and pre-acceptance hardening**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid repository integrity, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`
- safe fresh install + isolated acceptance runbook, PR #24: `3963a17104689ad8bbd63d5d1c7325cf3965df86`

Active branch: `m9-security-review`

Active PR: **#25 – M9 security review and boundary hardening**. Keep draft until final-head CI and sensitive-file diff review are green. Do not call the product ready for real-machine acceptance until #25 is merged and the exact acceptance procedure gets a final preflight.

The detailed review matrix is `docs/security-review-m9.md`.

## Completed platform/recovery capability

- local authenticated Control + authoritative SQLite state
- Restic/rclone execution with agents owning storage/data path
- self-contained Docker/Unraid packaging
- workstation enrollment, policies, scheduling and Windows agent
- workstation snapshot inventory/non-recursive browse
- dry-run + staging-only write recovery
- exact preview -> restore binding with 30-minute max preview age
- generic/Unraid and workstation-native repository integrity checks
- emergency bundle and offline recovery runbook
- safe inert generic-Agent starter config and narrow `/data` default
- isolated real-machine acceptance runbook with independent SHA-256 verification

A standard `restic check` is repository consistency evidence, not proof that selected files can be recovered byte-for-byte. Acceptance still requires a real fresh staging restore plus independent byte/hash/content verification.

## Non-negotiable safety invariants

- write restore is staging-only; no in-place restore
- `restic restore --overwrite never`; no `--delete`
- browser/controller selects local restore target IDs, never raw destination paths
- each generic write restore uses a fresh run/attempt-specific 0700 staging tree and refuses reuse
- write restore requires a recent exact successful dry-run preview
- one active operation per workstation
- interrupted/expired workstation write restore is manual-retry only
- stale lease tokens cannot mutate a replacement run
- failed/partial/integrity jobs do not overwrite prior successful backup history
- locally completed workstation backup is not authoritative success until exact leased result is controller-ACKed
- repository/storage credentials remain local to Agent/workstation
- backup payloads never pass through Control, Cloudflare or PCWatch
- generic source mappings cannot descend into their own repository/restore staging tree
- fresh generic Agent starts inert
- Unraid `/data` default is narrow, read-only and not all `/mnt/user`
- default Agent deployment has no `SYS_ADMIN` or `/dev/fuse`; FUSE is manual opt-in only for mounted remote-source backup
- PCWatch-backup and standalone Copyarr remain untouched during isolated acceptance

## M9 findings resolved on PR #25

M9 found several real pre-acceptance issues and fixed them in code/tests rather than documenting around them:

- **HIGH:** Restic/rclone telemetry could persist credential-bearing tool output. Agent now redacts locally known repository URI/userinfo/password-file/secret-env/rTorrent secrets before telemetry leaves the machine.
- **HIGH:** executor errors could bypass telemetry redaction into failed job state/logs. Failed-state reporting now uses the same redaction boundary.
- **HIGH:** browser-facing “sanitized” Agent config still exposed raw Restic repository and rclone filesystem addresses. Browser responses now contain IDs/coarse kinds/capabilities only.
- **HIGH:** generic restore retained historical direct-target/overwrite behavior. Generic preview/write now use run-specific staging; write creates a fresh exclusive 0700 target; overwrite is hard-coded/config-validated to `never`.
- **HIGH:** workstation installer origin construction implicitly trusted forwarded Host/Proto. Forwarded origin headers are ignored; direct Host is validated and reverse proxy deployments use explicit `NEXUS_BACKUP_PUBLIC_URL`.
- **MEDIUM:** destination cleanup used size-only provenance. It now requires exact size + modification time and fails closed if uncertain.
- **MEDIUM:** Agent always received `SYS_ADMIN` + `/dev/fuse`. Compose and Unraid defaults now grant neither; CI prevents regression. FUSE is explicit opt-in only for `rclone-restic-backup` mounted-source jobs.
- **MEDIUM:** CI used mutable GitHub Action version tags. checkout/setup-node/setup-go are pinned to reviewed commit SHAs.

At the current review point there are **no known open HIGH findings**. Re-evaluate this statement if final CI/diff review finds another issue.

## Explicit residual beta risks

These are documented, not silently treated as solved:

- plain-HTTP workstation installation assumes a trusted LAN/host; checksum files served by the same HTTP origin are consistency checks, not independent MITM authenticity. HTTPS + explicit `NEXUS_BACKUP_PUBLIC_URL` is the stronger transport option.
- first-run setup token is deliberately visible in trusted Control container logs until setup; the token file is 0600 and removed after successful setup.
- Control/Agent currently run as root inside their container namespaces. They are not privileged; Agent has narrow explicit mounts and no default SYS_ADMIN/FUSE. Non-root containers remain future hardening requiring Unraid permission compatibility testing.
- build-stage/base-image tags are not all digest-pinned. Acceptance must record/pin the exact built Control/Agent image digest; full build-chain digest pinning remains stable-release hardening.
- enabling FUSE/SYS_ADMIN for remote-as-mounted-source backup is a deliberate privilege expansion and is outside the default acceptance path.

## Emergency recovery

PR #23 provides `docs/emergency-recovery.md` plus a self-contained emergency bundle containing controller SQLite/auth/identity, generic-Agent config/secrets, migration/version metadata and SHA-256 manifest. It excludes backup payloads, source data, restore staging, caches, workstation-local repository secrets and image archives.

The runbook requires an offline pinned image archive and disposable loopback-only inspection before production recovery. The recovery path remains to be field-proven during the acceptance drill.

## Fresh install / isolated acceptance

PR #24 fixed the recursive source/repository hazard with an inert Agent starter config, narrow `/data` default and CI contracts. `docs/fresh-install.md` is the clean deployment runbook and `docs/acceptance-test.md` is the isolated proof procedure.

Important prerequisite: Agent `/backup` is not automatically a Windows-facing repository service. Final Windows -> Unraid proof requires a dedicated test-only Restic endpoint reachable from the Windows SYSTEM context. A workstation-local repository smoke test does not count as final intended-path acceptance.

## Remaining gates before “Nu tester vi”

1. finish PR #25 final-head CI across Node/typecheck, Linux, native Windows, installer/templates and both images;
2. review final sensitive-file patches for accidental broad rewrites/security regression;
3. clear PR review threads and merge #25;
4. perform one final preflight of `docs/acceptance-test.md` against the merged code and exact pinned test images;
5. then install the isolated beta and execute the real restore/failure drill.

## Required real-machine proof

Use disposable `NexusBackup-Test` data and isolated repositories. Required proof includes:

- normal workstation backup
- snapshot inventory + browse
- native repository integrity check
- exact dry-run preview
- real fresh staging restore
- independent byte/hash/content verification
- Control restart
- generic-Agent restart
- workstation-agent restart
- temporary Control-path loss
- repository unavailable
- interrupted write restore with no automatic unsafe reuse
- final post-fault integrity + fresh staging restore + byte/hash PASS

Only after that proof should a workstation be cut over from PCWatch-backup. Cut over one workload at a time; never run PCWatch and Nexus writes against the same Restic repository concurrently.

## Roadmap after workstation proof

- prove Martin-PC -> Unraid
- prove Unraid -> Google Drive
- prove Seedbox -> Unraid, then compare before retiring standalone Copyarr
- close telemetry/UX gaps found by real testing
- add optional Nexus/PCWatch status integration if useful
- stable release only after real restore proof and security sign-off

## Working rule for future sessions

At the end of every substantial milestone, bug batch, merge, or changed next-step decision, update this file in the same PR/commit series. The repo, not chat history, is the source of truth.
