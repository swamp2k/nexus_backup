# Nexus Backup project status

Last updated: 2026-09-14

This is the durable handoff for future sessions. Read it before changing the project. The repository, not chat history, is the source of truth.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery/transfer system for Docker/Unraid plus Windows workstations. Remote control may be optional later, but it must never be required for normal backup/recovery and backup payloads must never traverse Control, Cloudflare or PCWatch.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not modify or retire them until each corresponding real workload has been migrated and proven, including restore/content verification where applicable.

## Current milestone

**Final acceptance preflight – publish and verify an exact coordinated RC image set**

Merged on `main`:

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid integrity, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`
- fresh install + isolated acceptance runbook, PR #24: `3963a17104689ad8bbd63d5d1c7325cf3965df86`
- M9 architecture/security hardening, PR #25: `e375ae4919ebe589be228c399cd133db849ce04b`
- self-contained workstation Repository endpoint, PR #26: `33e06ad6b5ae24eaaf6301fbcfce4fcc64917cf1`
- guarded acceptance RC publishing, PR #27: `515ecbee832c23ad1768b1bcfdf0a282627dc663`

PR #26 final-head CI #252 and post-merge `main` CI #253 were fully green, including real authenticated TLS Restic init/open against the built Repository image.

PR #27 final-head CI #254 and post-merge `main` CI #255 were also fully green. The release-identity guard, native Windows tests, all three image builds, real Repository TLS/auth Restic integration, metadata and Compose gates passed on `515ecbee832c23ad1768b1bcfdf0a282627dc663`.

Active branch: `acceptance-rc-handoff`

The code and distribution workflow are now ready for one explicit acceptance RC publish. No RC has been published yet, and no production workload has been moved.

Do not call the product ready for real-machine acceptance until the exact published RC image set has been pulled through the actual Unraid deployment path, its immutable digests recorded, and the final runbook preflight repeated against those identities.

## Architecture now on main

The local Unraid product consists of three coordinated containers:

1. **NexusBackup-Control** — UI/API/auth/SQLite/orchestration only.
2. **NexusBackup-Agent** — generic Restic/rclone/transfer execution and generic storage credentials.
3. **NexusBackup-Repository** — TLS-authenticated Restic REST endpoint dedicated to Windows workstation repositories.

Windows backup data path:

```text
Windows Restic -> TLS -> NexusBackup-Repository -> dedicated Unraid repository storage
```

Control is not in this path.

Repository uses official `rest-server` v0.14.0 pinned to the Linux-amd64 release SHA-256 at image build. It generates a self-signed TLS certificate, requires TLS 1.3, bcrypt htpasswd authentication and private per-user repository namespaces.

Repository exposes only the TLS Restic service on port 8000 by default. There is deliberately **no HTTP CA/bootstrap service**. The local `nexus-repository-client` helper carries the public CA certificate as base64 plus its SHA-256 into the same elevated PowerShell session used for workstation onboarding. The installer decodes the CA, verifies the hash locally and only then allows Restic to connect.

REST transport credentials remain local to Repository + workstation. The separate Restic encryption password remains workstation-local. Control receives neither.

## Repository / workstation safety rules now on main

- Repository `/data` defaults to `/mnt/user/backups/nexus-backup/workstations`.
- generic Agent `/backup` defaults to `/mnt/user/backups/nexus-backup/generic`.
- CI requires those roots to be distinct and neither may contain the other.
- Repository container has no Control DB, generic source, generic restore or FUSE access.
- Repository is non-privileged and receives no `SYS_ADMIN`/`/dev/fuse`.
- Repository exposes only its TLS data port by default; no unauthenticated HTTP CA endpoint exists.
- workstation REST credentials require `rest:https://`.
- authenticated Nexus Repository onboarding requires a locally supplied SHA-256-verified CA file.
- REST username/password + CA + repository URL are local workstation config only.
- Restic child processes receive authoritative local REST/TLS env; stale process `RESTIC_*` values are removed.
- normal workstation runtime **never auto-initializes a remote repository after a failed probe**.
- remote Repository initialization happens only during explicit installer provisioning of the exact CA-pinned/authenticated endpoint; afterward remote `autoInit=false`.
- repository/auth/TLS/network failures fail closed.
- Repository URL/username/password/CA path/encryption password remain absent from Control/browser-visible telemetry/errors.

## Acceptance RC publishing path now on main

PR #27 added a guarded manual `workflow_dispatch` path to `.github/workflows/release-images.yml` without changing normal tag-release semantics.

Manual acceptance publishing must:

- run from `main` only;
- receive the exact expected 40-character source SHA and reject a mismatch;
- use a SemVer prerelease such as `0.7.0-rc.1`;
- force `stable=false`, so a manual acceptance publish cannot move `latest`;
- publish Control, Agent and Repository with the same version/source revision;
- record each image digest in the GitHub Actions step summary.

The identity decision lives in `.github/scripts/resolve-release-version.sh` and is covered by the normal Node test suite for allowed and rejected cases. Third-party release Actions are pinned to reviewed commit SHAs.

Normal `v*` tag releases continue to determine stable/prerelease status from the tag and can move `latest` only for a stable SemVer tag.

No image is published merely by merging the workflow. The next acceptance action is one explicit manual prerelease publish from the then-current final `main` SHA.

## Completed M9 security review

`docs/security-review-m9.md` is the review matrix. PR #25 fixed the important pre-acceptance findings:

- local Agent telemetry/failure credential redaction;
- sanitized browser config no longer exposes raw Restic/rclone locations;
- generic write restore is fresh staging-only with `--overwrite never`;
- forwarded Host/Proto are not trusted for installer/public-origin security decisions;
- destructive managed cleanup requires exact size + modification-time provenance;
- default Agent no longer gets SYS_ADMIN/FUSE;
- main and release workflow third-party Actions used in the current paths are pinned to reviewed commit SHAs.

There were no known open HIGH findings when #25 merged. PR #26 final sensitive-diff review found no new open HIGH finding.

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

`docs/fresh-install.md` documents Control + Agent + Repository deployment and per-workstation Repository onboarding through local CA base64/hash transfer, with no HTTP bootstrap service.

`docs/acceptance-test.md` tests the intended path:

```text
Balder-PC -> TLS -> NexusBackup-Repository -> isolated Unraid storage
```

Required real proof includes normal backup, inventory/browse, repository integrity, dry-run, real fresh staging restore, independent byte/hash verification, Control/Agent/Repository/workstation restarts, temporary Control-path loss, Repository outage, interrupted write restore and a final post-fault staging restore/hash PASS.

CI is only a prerequisite; it does not replace this real restore proof.

## Explicit beta / pre-production gaps

These are not silently treated as solved:

- plain-HTTP Control-hosted workstation installation assumes a trusted LAN/host; HTTPS + explicit `NEXUS_BACKUP_PUBLIC_URL` is stronger. Repository traffic itself is TLS/CA-pinned from local helper output.
- first-run Control setup token is visible to privileged container logs until setup, then removed.
- Control/Agent/Repository run as root inside non-privileged containers; default mounts/capabilities are constrained. Non-root runtime remains later Unraid-compatibility hardening.
- base/build image tags are not all digest-pinned; acceptance must record the exact published RC image digests.
- generic FUSE/SYS_ADMIN remains explicit opt-in only for the optional mounted remote-source feature.
- GHCR package visibility/pullability from the actual Unraid host must be verified after the first RC image publish; do not assume a successful workflow push means anonymous Unraid pull works.

### Production recovery-key gate

Nexus deliberately keeps workstation encryption secrets out of Control. Total workstation loss therefore cannot be recovered solely from the current Control/generic-Agent emergency bundle.

Before **production cutover**, Nexus still needs and must prove an off-host recovery procedure for:

- each workstation Restic encryption password/recovery key;
- NexusBackup-Repository `/config` (TLS key/certificate, htpasswd and local transport credential material), or a documented safe credential/certificate reconstruction flow;
- the relationship between the recovered workstation identity/repository namespace and the encrypted repository payload.

The isolated acceptance test may use disposable secrets/repositories, but passing that test does not waive this production recovery gate.

## Remaining gates before “Nu tester vi”

1. merge this handoff-only status sync so the RC source SHA includes the current source-of-truth;
2. publish one exact prerelease image set from that merged `main` SHA without moving `latest`;
3. verify Control, Agent and Repository can all be pulled by the actual Unraid deployment path and record their immutable digests;
4. rerun the final acceptance runbook preflight against those exact image identities;
5. only then start the isolated real-machine acceptance drill.

## Roadmap after isolated workstation proof

- implement/prove workstation encryption-key + Repository-config off-host recovery;
- cut over Balder-PC only after that production recovery gate;
- prove/cut over Martin-PC -> Unraid separately;
- prove Unraid -> Google Drive;
- prove Seedbox -> Unraid and compare before retiring standalone Copyarr;
- close telemetry/UX gaps found by real use;
- first stable release only after real restore proof and production recovery/security sign-off.

## Working rule

Update this file on every substantial milestone, merge, newly discovered blocker or changed next step. Keep it factual; do not let green CI, a published image or an implemented feature imply real-world proof that has not happened.
