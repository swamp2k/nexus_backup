# M9 architecture and security review

Date: 2026-09-13

Scope: pre-acceptance review of Nexus Backup's local-first beta architecture. This review is a gate before real workstation/Unraid acceptance; it is not a claim that the product is universally hardened for hostile multi-tenant or Internet-exposed operation.

Severity meanings:

- **HIGH** — must be fixed before real-machine acceptance.
- **MEDIUM** — important hardening or trust-boundary issue; fix when practical before acceptance, otherwise explicitly document the residual assumption.
- **LOW** — defense-in-depth/future hardening.

## Review matrix

| Area | Threat / invariant | Result | Severity | Evidence / mitigation |
| --- | --- | --- | --- | --- |
| Local admin auth | unauthenticated mutation or weak password/session handling | PASS | — | scrypt password record; HttpOnly + SameSite=Strict session; 12h in-memory sessions; mutation CSRF; login rate limiting |
| Restore authorization | normal admin session alone can trigger arbitrary write restore | PASS | — | exact-scope dry-run <=30m; typed confirmation; 2m single-use restore grant; target resolved locally |
| Public origin / reverse proxy | poisoned Host/forwarded headers alter installer command or cookie policy | FIXED | HIGH | forwarded Host/Proto are not trusted; direct Host is validated; reverse proxy uses explicit validated `NEXUS_BACKUP_PUBLIC_URL`; regression tests cover malicious authorities |
| Device enrollment | reusable/long-lived installer credential | PASS | — | workstation bootstrap token is 15m, one-shot via conditional DB update, then replaced with durable local device token |
| Device token storage | raw durable device tokens stored server-side | PASS | — | server stores SHA-256 token hashes; disabled/unbootstrapped tokens rejected; rotation replaces hash |
| Generic agent auth | unauthenticated job claim/state mutation | PASS | — | agent bearer token required by control plane; lease token binds heartbeat/transitions to claimed job |
| Workstation run auth | stale or foreign workstation can mutate a run | PASS | — | durable device auth + per-run lease token + exact device/run binding; stale lease returns conflict |
| Lease/replay semantics | expired worker reports success into a newer lease | PASS | — | CAS/lease protections and M8 stale-token torture tests; workstation stale lease cannot mutate replacement run |
| Tool telemetry secrets | Restic/rclone output persists local credentials to controller/SQLite/UI | FIXED | HIGH | central Agent-side redacting event sink scrubs local repository URI, URL credentials, password-file paths, secret-like env values and rTorrent credentials before delivery |
| Failure-state secrets | executor exception bypasses telemetry redaction into job error/log | FIXED | HIGH | same local redactor is applied to failed-state/error reporting and Agent loop logging; regression coverage included |
| Browser config secrets | supposedly sanitized config exposes repository/rclone addresses | FIXED | HIGH | browser API now returns IDs, coarse storage kind and capabilities only; raw Restic repository, rclone fs, restore path, password file and rTorrent address/credentials are omitted |
| Generic restore destination | browser/controller selects arbitrary filesystem destination | PASS | — | payload selects local target ID only; configured target path never leaves Agent config |
| Generic restore overwrite | old generic restore writes in-place or overwrites existing files | FIXED | HIGH | restore target config only permits `overwrite=never`; preview/write hard-code `--overwrite never`; no `--delete` |
| Generic restore staging | retry reuses interrupted restore tree | FIXED | HIGH | each job/attempt derives a unique target below configured staging root; write creates it exclusively with mode 0700 and refuses EEXIST |
| Workstation restore | in-place restore / replay after interrupted write | PASS | — | staging-only, locally chosen run target, overwrite never, no delete, exact dry-run binding, expired write restore requires manual retry |
| Snapshot/path input | traversal/dot-segment or raw target injection | PASS | — | snapshot IDs constrained; snapshot paths absolute/no NUL/no dot segments; browse membership checked; transfer paths normalized relative/no dot segments |
| Process command injection | controller data reaches shell command parser | PASS | — | generic Agent uses `spawn(..., shell:false)` with argument arrays; workstation execution uses explicit command construction/process helpers; tool binaries/config are local-only |
| Generic rclone move | remote request can delete source without local opt-in | PASS | — | `move` requires local source endpoint `allowMove:true`; scheduled generic rclone plans support copy only |
| Managed transfer containment | payload escapes local endpoint roots | PASS | — | source/destination endpoint IDs resolve locally; relative path normalization rejects dot segments; staging/verify/commit sequence used |
| Destination cleanup provenance | cleanup deletes a file that changed after Nexus committed it | HARDENED | MEDIUM | cleanup now requires exact expected size **and** modification time; missing/changed modtime fails closed; no delete occurs |
| Repository concurrency | backup/check/maintenance/restore race on same Restic repo | PASS | — | shared per-repository Restic gate covers generic Restic operations |
| Container storage scope | fresh Agent can see all Unraid user shares or recurse into repository | FIXED earlier | HIGH | inert starter config; `/data` default is narrow `/mnt/user/nexus-backup-source`, read-only; repository/restore/download roots separate |
| Container privilege | Agent always receives `SYS_ADMIN` + `/dev/fuse` | FIXED | MEDIUM | default Compose and Unraid template grant neither; CI rejects their reintroduction. FUSE privilege is manual opt-in only for `rclone-restic-backup` mounted-source jobs |
| Control container privilege | Control can access backup storage/FUSE | PASS | — | no backup storage mappings, `/agent-config` read-only, no privileged/SYS_ADMIN/FUSE default |
| Internal local server | unauthenticated LAN bypasses gateway local-admin auth | PASS | — | internal server is forced to loopback/internal port; public gateway owns local session/CSRF; public `/v1/agent/*` still requires agent bearer auth upstream |
| Installer asset consistency | workstation EXE/Restic mismatch or corrupt download | PASS | — | workstation binary built into same Control image; Restic version + upstream archive SHA pinned at image build; installer verifies bundled asset SHA256 before enrollment |
| Installer transport authenticity | same HTTP origin serves script, binary and checksum on hostile LAN | ACCEPTED BETA RISK | MEDIUM | direct-LAN beta assumes trusted host/LAN during installation. For stronger transport authenticity use HTTPS and explicit `NEXUS_BACKUP_PUBLIC_URL`. SHA256 from the same HTTP server is not claimed as independent MITM protection |
| Installer local secret ACL | ordinary Windows user reads durable token/password | PASS | — | `%ProgramData%\NexusBackup` inheritance removed; SYSTEM and local Administrators only; scheduled task runs as SYSTEM |
| CI action supply chain | mutable GitHub Action tags execute changed code | FIXED | MEDIUM | checkout/setup-node/setup-go pinned to concrete commits used by the reviewed CI run |
| Container/base-image reproducibility | base image tags may move before a future build | ACCEPTED BETA RISK | LOW/MEDIUM | acceptance records/pins exact built Control+Agent release/image digest. Digest-pinning all build stages remains release hardening before a stable hostile-supply-chain claim |
| Setup-token visibility | first-run setup secret appears in container log | ACCEPTED BETA RISK | LOW/MEDIUM | token is one-time bootstrap material on the trusted local host, setup file is 0600 and removed after setup. Treat container logs as privileged during first-run bootstrap |
| Container UID | Control/Agent runtime processes execute as root inside containers | ACCEPTED BETA RISK | MEDIUM | containers are not privileged; Agent default has no SYS_ADMIN/FUSE and gets only explicit narrow mounts. Non-root runtime is future hardening and must be validated against Unraid volume ownership/Restic/rclone behavior |
| Emergency recovery | recovery depends on live Nexus/API/cloud | PASS | — | emergency bundle contains control DB/auth/identity + Agent config/secrets + hash manifest/runbook; recovery flow is offline/local and verifies SQLite integrity |
| Emergency bundle disclosure | exported recovery kit becomes a second secret store | PASS WITH OPERATOR REQUIREMENT | — | bundle explicitly marks `containsSecrets`, output mode 0700/files 0600, manifest hashes contents; docs require encrypted/off-host storage |
| Backup data path | payload traverses controller/cloud/PCWatch | PASS | — | Agent/workstation talks directly to repository/storage; controller receives orchestration/metadata only |

## Findings that blocked acceptance

M9 found and fixed these acceptance blockers:

1. generic Agent tool telemetry could leak storage credentials;
2. executor failure messages could bypass telemetry redaction;
3. the browser-facing sanitized Agent config exposed raw storage addresses;
4. generic Restic restore retained historical in-place/overwrite capability instead of the current staging-only contract;
5. public workstation installer origin construction implicitly trusted forwarded request headers.

No known **HIGH** finding remains open after the fixes above. This statement must be re-evaluated if the final PR diff or CI exposes another issue.

## Residual beta assumptions

The isolated acceptance test is allowed to proceed only under these assumptions:

- Nexus Control is used on a trusted home/LAN environment or placed behind correctly configured HTTPS.
- Plain-HTTP workstation installation is not treated as safe against a hostile LAN/MITM.
- Control/Agent container logs and appdata are administrator-only resources.
- The default Agent runs without FUSE/SYS_ADMIN. Enabling mounted remote-source backup is a deliberate privilege expansion.
- Host mappings remain narrow; `/data` is not casually widened to all of `/mnt/user`.
- Emergency bundles are encrypted/off-host because they deliberately contain recovery secrets.
- PCWatch-backup and standalone Copyarr remain untouched during isolated acceptance.

## Acceptance gate after M9

M9 code review is complete only when:

1. final PR head passes Node/typecheck, Linux + native Windows workstation tests, installer/template contracts and both Docker image builds;
2. final per-file diff review finds no accidental broad rewrite or regression;
3. PR review threads are clear;
4. this matrix and `docs/PROJECT_STATUS.md` match the final code;
5. PR #25 is merged before the real-machine acceptance procedure begins.

Passing M9 still does **not** prove backup correctness. `docs/acceptance-test.md` must then demonstrate a real backup, repository integrity, dry-run, fresh staging restore and independent byte/hash verification under normal and failure/restart conditions.
