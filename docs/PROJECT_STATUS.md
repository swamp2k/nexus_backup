# Nexus Backup project status

Last updated: 2026-09-14

This is the durable handoff for future sessions. Read it before changing the project. The repository, not chat history, is the source of truth.

## Product goal

Nexus Backup is a self-contained, local-first backup/recovery/transfer appliance for Unraid plus Windows workstations. Backup payloads must never traverse Control, Cloudflare or PCWatch. Remote control may use a separate optional HTTPS path.

Existing PCWatch-backup and standalone Copyarr are fallbacks. Do not modify or retire them until each corresponding real workload has been migrated and proven, including restore/content verification where applicable.

## Current milestone — M10 Internet-facing workstation Repository

The first physical acceptance install was paused before creating the Nexus container when a real deployment requirement was identified: several existing workstation backup clients are off-LAN. A LAN-only Repository would not be a viable PCWatch replacement.

Decision: **direct Internet Restic is a first-class Nexus data path.** No VPN overlay and no Cloudflare proxy is required for backup payloads.

Supported off-LAN topology:

```text
control/orchestration (small):
Remote workstation -> HTTPS / optional Cloudflare Tunnel -> Control

backup/recovery payload:
Remote workstation -> direct HTTPS -> Repository -> /backup/workstations
```

Repository and Control endpoints are deliberately independent. A Cloudflare Tunnel is acceptable for Control because it carries only metadata/jobs; Repository backup bytes must bypass it.

M10 PR #33 merged as:

```text
merge:   1be0126a64592b369862c4b39f8a111ed1e323c3
PR CI:   #282 green on exact head acd68c7e99df94f06012a631d887902e9f290a02
main CI: #283 green on exact merge 1be0126a64592b369862c4b39f8a111ed1e323c3
```

The security/diff review was completed before merge. No inline review threads remained, and the unified-image Internet-mode gate passed on both PR and post-merge main CI.

## M10 implementation contract

Repository network policy is persisted beneath:

```text
/config/repository/settings
```

Settings:

- exposure: `lan` or `internet`;
- endpoint host: canonical DNS name/IP pinned into Repository TLS identity;
- listen port: local Tower port, default `8000`;
- endpoint port: advertised workstation port, allowing e.g. WAN `443 -> Tower:8000`;
- append-only: Internet mode defaults `true` on first configuration.

`nexus-repository-settings` provides a local CLI over the same settings source used by the GUI and Repository process. The Repository process publishes its non-secret active policy to `/run/nexus-backup/repository-active.json`, allowing the UI to show configured vs running state and whether a Nexus restart is required.

The Nexus **Settings -> Workstation Repository -> Network & protection** panel manages these values. Listener/TLS identity changes are saved but applied only after restarting the single NexusBackup container; the UI does not receive Docker-socket access.

### Current direct-endpoint protections

Actually enforced:

- TLS minimum 1.3;
- pinned self-signed Repository CA on each workstation;
- random strong per-workstation REST credentials;
- bcrypt server-side authentication material;
- private per-principal namespaces;
- append-only mode, default-on for first-time Internet exposure.

Not currently built into the direct Restic endpoint:

- traffic rate limiting;
- brute-force/IP lockout.

The GUI must state those as unavailable rather than display false protection. `rest-server` does not natively provide those controls; adding them later requires a real edge/gate/firewall implementation.

Append-only means remote clients cannot perform destructive `forget/prune`. That is intentional ransomware/client-compromise protection. Production retention for Internet workstations must ultimately run locally on Tower/Nexus rather than periodically disabling append-only.

## Existing single-container architecture

Nexus Backup presents as one Community Apps entry and one normal Unraid container. Inside it:

```text
Control     :8787  UI/API/auth/SQLite/orchestration
Agent              local Restic/rclone/transfer execution, Control via 127.0.0.1
Repository  :8000  TLS Restic REST endpoint for Windows workstations
```

Persistent layout:

```text
/config/control       Control DB/auth/secrets
/config/agent         Agent config and local storage credentials
/config/repository    Repository TLS/auth/client material + network settings
/state                Agent caches/state
/backup/generic       Generic Restic repositories
/backup/workstations  Windows workstation repositories
```

Default Unraid mappings:

```text
/config      /mnt/user/appdata/nexus-backup
/state       /mnt/user/appdata/nexus-backup-state
/data        /mnt/user/nexus-backup-source          read-only
/backup      /mnt/user/backups/nexus-backup
/restore     /mnt/user/restore/nexus-backup
/downloads   /mnt/user/downloads
```

The appliance remains non-privileged by default with no `SYS_ADMIN` or `/dev/fuse` unless the optional mounted remote-source feature is explicitly enabled.

## Workstation data/control boundaries

Backup path:

```text
Windows Restic -> TLS -> Repository process -> /backup/workstations
```

Control receives no backup payload and no Repository transport/encryption credentials.

A workstation still needs Control for enrollment, job polling and status. Off-LAN deployments therefore need a reachable Control origin separate from Repository. `NEXUS_BACKUP_PUBLIC_URL` is the explicit source of truth for that origin; Nexus does not trust arbitrary forwarded Host/Proto headers.

Repository uses official `rest-server` v0.14.0 pinned by SHA-256 at image build. `nexus-repository-client` carries the public CA as base64 plus SHA-256 into workstation onboarding; there is no HTTP CA bootstrap endpoint.

REST transport credentials remain local to Repository + workstation. The separate Restic encryption password remains workstation-local. Control receives neither.

## Last proven acceptance image

The pre-M10 single-container RC was successfully published and physically pulled on the real Unraid host:

```text
version:  0.8.0-rc.1
source:   91bf2569bd301e29e0a55eaff70aa794669d2d8e
image:    ghcr.io/swamp2k/nexus-backup@sha256:be927d306f28501999bc475a779f58ef6da2dcf3605db1095ad3257a7ecb69b9
```

The manual RC did not move `latest`. Unraid verified matching version, revision and immutable digest. Distribution preflight passed.

That RC remains valid evidence for the one-container packaging path, but **do not start the real workstation acceptance on 0.8.0-rc.1 now**: M10 changes the required Repository connectivity contract. Publish and verify a new M10 RC from the exact current `main` SHA after the status sync; the guarded manual release requires `expected_sha` to equal current `main`.

## Non-negotiable restore/recovery invariants

- write restores are staging-only; never in-place;
- `restic restore --overwrite never`; no `--delete`;
- browser/controller chooses local restore target IDs, never raw write destinations;
- each generic write restore gets a fresh run/attempt-specific staging tree and refuses reuse;
- workstation restore requires a recent exact successful dry-run preview;
- interrupted/expired write restore is manual retry only;
- stale lease tokens cannot mutate replacement runs;
- failed/partial/integrity/recovery jobs do not replace previous successful backup state;
- locally completed workstation backup is not authoritative success until its leased result is controller-ACKed;
- repository/storage credentials remain local to the execution/storage endpoint;
- fresh Agent starts inert;
- PCWatch-backup and standalone Copyarr remain untouched during isolated acceptance.

## Proven one-container baseline

PR #30 merged as `f5c1ac01ed6ced6a11ea6f351cae431bace10b4e`. PR #31 synchronized the first single-container RC handoff as `91bf2569bd301e29e0a55eaff70aa794669d2d8e`; post-merge CI #272 was green. PR #32 merged as `7a87ab9ccc4189522c58a7ab69159af182b9df09` and marked the LAN acceptance preflight ready immediately before the off-LAN requirement was discovered.

Existing appliance CI proves Node/typecheck, Linux/native-Windows Go, installer syntax, one Unraid template, one appliance image, inert fresh Agent, real Repository TLS/auth Restic `init` + `cat config`, invalid-credential rejection, fail-as-one-unit supervision and no default privileged/SYS_ADMIN/FUSE.

M10 adds a separate live gate for Internet mode: NAT-style advertised port distinct from local listen port, real backup through the Repository, and proof that append-only rejects destructive remote snapshot deletion with HTTP 403 while the snapshot remains readable. This gate passed on PR CI #282 and post-merge main CI #283.

## Explicit beta / pre-production gaps

These remain explicit:

- direct Internet Repository currently has strong TLS/auth/private namespace/append-only protection but no built-in IP rate limit or brute-force lockout;
- Control remote access is a separate endpoint; Cloudflare Tunnel is recommended for off-LAN beta control traffic but never for backup payloads;
- first-run Control setup token is visible to privileged container logs until setup, then removed;
- internal processes share the same non-privileged container namespace;
- base/build image tags are not all digest-pinned; acceptance must record exact published image digest;
- FUSE/SYS_ADMIN remains explicit opt-in only for optional mounted remote-source;
- production local retention for append-only workstation repositories is not implemented yet.

### Production recovery-key gate

Before production cutover Nexus still needs and must prove off-host recovery for:

- each workstation Restic encryption password/recovery key;
- `/config/repository` TLS/auth/client material, or a documented safe reconstruction flow;
- relationship between recovered workstation identity/repository namespace and encrypted repository payload.

The isolated acceptance test may use disposable secrets/repositories, but passing it does not waive this gate.

## Next gates

1. publish a new exact single-image M10 prerelease from the exact current `main` SHA without moving `latest`;
2. record the resulting immutable digest and pull/verify it on Tower;
3. install NexusBackup pinned to that digest with the selected public Repository hostname/port;
4. prove Repository reachability from a genuinely off-LAN network and Control reachability through the separate HTTPS control path;
5. run the existing backup -> inventory -> integrity -> dry-run -> staging restore -> independent SHA-256 acceptance sequence;
6. keep PCWatch-backup and standalone Copyarr unchanged until later explicit cutover.

A real workload PASS has **not** happened yet.

## Merged history

- M8 resilience batch 1: `941d138bde505181c3fd36af2e4bcf6e5b0b8736`
- M8 resilience batch 2: `527909f3385b41c33b46cb421aabdc8b61cadf0e`
- generic/Unraid integrity, PR #21: `5b975e7b761d19a25a9d7a4fbdb6de549cb1f848`
- workstation-native integrity, PR #22: `4e2406ce5f17ed4eae27281f1f6ec2c186aaaceb`
- emergency recovery kit, PR #23: `9eb2e5c3fddb801fcfc464eeeb17675b0ecf839f`
- fresh install + isolated acceptance runbook, PR #24: `3963a17104689ad8bbd63d5d1c7325cf3965df86`
- M9 architecture/security hardening, PR #25: `e375ae4919ebe589be228c399cd133db849ce04b`
- self-contained workstation Repository endpoint, PR #26: `33e06ad6b5ae24eaaf6301fbcfce4fcc64917cf1`
- guarded acceptance RC publishing, PR #27: `515ecbee832c23ad1768b1bcfdf0a282627dc663`
- acceptance RC handoff sync, PR #28: `44554518354babc017c27c4e141c28f459f02844`
- first RC identity status sync, PR #29: `451366016aea577d4edeb6c46b32cc33254bb766`
- collapse to one Unraid appliance container, PR #30: `f5c1ac01ed6ced6a11ea6f351cae431bace10b4e`
- single-container acceptance handoff, PR #31: `91bf2569bd301e29e0a55eaff70aa794669d2d8e`
- acceptance-ready docs sync, PR #32: `7a87ab9ccc4189522c58a7ab69159af182b9df09`
- direct Internet workstation Repository, PR #33: `1be0126a64592b369862c4b39f8a111ed1e323c3`
- M10 status sync, PR #34: `b7540daae16672aa11a244c9cf2c6d777ae5642c`

## Working rule

Update this file on every substantial milestone, merge, newly discovered blocker or changed next step. Keep it factual; never let green CI, a published image or an implemented feature imply real-world proof that has not happened.
