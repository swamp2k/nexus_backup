# Fresh install: Unraid + Windows workstation

This runbook installs Nexus Backup from a clean state without relying on prior chat history. It is intentionally conservative and describes the current local-first beta architecture.

It does **not** cut over any existing production backup workload. PCWatch-backup and standalone Copyarr remain untouched until the isolated acceptance procedure in `docs/acceptance-test.md` has passed and a later cutover is explicitly approved.

## 1. Deployment model

Nexus Backup is one product split into three Unraid containers plus a Windows workstation agent:

```text
Browser
  -> NexusBackup-Control
       - UI/API
       - local auth
       - SQLite
       - schedules/job state

NexusBackup-Agent
  - generic Restic/rclone execution
  - generic source/repository mappings
  - generic local repository/rclone credentials
  - optional FUSE only for remote-as-mounted-source backups

NexusBackup-Repository
  - TLS-authenticated Restic REST endpoint for Windows workstations
  - dedicated workstation repository storage
  - local TLS private key + bcrypt transport authentication
  - no Control DB, source-data, restore-staging or Restic encryption-password access

Windows workstation agent
  - runs backup/recovery locally on Windows
  - talks directly to NexusBackup-Repository for backup bytes
  - owns its Restic encryption password and REST transport credential locally
  - talks to Control only for metadata/orchestration
```

The workstation data path is therefore:

```text
Windows Restic -> TLS -> NexusBackup-Repository -> dedicated Unraid storage
```

Backup payloads do not flow through Control. REST transport credentials and the Restic encryption password are not sent to Control.

## 2. Before installing

Record the exact coordinated Nexus release you intend to test. Control, Agent and Repository must use the same release tag/digest. The beta Unraid XML templates default to `latest`; reproducible acceptance should record/pin the exact image digests actually tested.

Verify these prerequisites:

- Docker is available on Unraid.
- TCP 8787, 8000 and 8001 are unused on the Unraid host, unless deliberately changed.
- you have selected persistent host paths for Control config, shared runtime, Agent config/state and Repository config.
- generic Agent source, generic Agent repository, generic restore staging and workstation Repository storage use deliberate separate roots.
- PCWatch does not write to the Nexus workstation Repository storage tree.

Default storage roots deliberately separate generic and workstation repositories:

```text
generic Agent /backup:  /mnt/user/backups/nexus-backup/generic
Repository /data:       /mnt/user/backups/nexus-backup/workstations
```

Neither default is a parent of the other.

`/dev/fuse` is **not** a normal prerequisite. It is needed only for the optional `rclone-restic-backup` feature that mounts a remote rclone endpoint as a read-only Restic source. The default Agent deployment does not grant `SYS_ADMIN` or `/dev/fuse`.

## 3. Install NexusBackup-Control

Use `unraid/templates/nexus-backup-control.xml` or equivalent values.

| Container path | Purpose | Required property |
| --- | --- | --- |
| `/config` | SQLite, local auth, generated Control identity | persistent, read/write |
| `/run/nexus-backup` | generated local-Agent token mirror | persistent/shared with Agent |
| `/agent-config` | sanitized read-only view of Agent config | same host directory as Agent `/config`, read-only |

Control uses host networking and listens on 8787. It must **not** receive source-data, repository-storage, `/dev/fuse` or `SYS_ADMIN` access.

Start Control and verify:

```text
http://<unraid-ip>:8787/healthz
```

### First local-admin bootstrap

A brand-new Control config creates a one-time setup token and writes it to the privileged Control log. Open:

```text
http://<unraid-ip>:8787/
```

and complete local-admin setup. After setup, `/config/auth.json` is persistent and the one-time setup token is removed.

## 4. Install NexusBackup-Agent

Use `unraid/templates/nexus-backup-agent.xml`. Keep Control/Agent shared paths identical where the templates say they must match.

| Container path | Purpose | Access |
| --- | --- | --- |
| `/config` | `agent.json`, generic Restic/rclone credentials | read/write |
| `/run/nexus-backup` | local-Agent token from Control | read-only |
| `/state` | Restic/rclone cache/runtime state | read/write |
| `/data` | protected generic source root(s) | read-only |
| `/backup` | generic-Agent repository root, default `/mnt/user/backups/nexus-backup/generic` | read/write |
| `/restore` | generic restore staging root | read/write |
| `/downloads` | managed transfer destination root | read/write |

The fresh Agent starter config is intentionally inert:

```json
{
  "sources": [],
  "resticRepositories": [],
  "restoreTargets": [],
  "rcloneEndpoints": [],
  "rtorrentGates": [],
  "tools": {}
}
```

Do not widen `/data` to all of `/mnt/user` merely for convenience. Source/repository/restore containment remains a hard safety rule.

A generic write restore target is a **staging root**, never an in-place destination. Current validation requires `overwrite: "never"`; write restore creates a fresh run-specific staging directory.

Validate explicit Agent config before jobs:

```sh
docker exec NexusBackup-Agent node apps/agent/bin/agent.mjs --check-config
```

Only add:

```text
--cap-add=SYS_ADMIN --device=/dev/fuse
```

if you deliberately use the optional mount-enabled rclone source feature.

## 5. Install NexusBackup-Repository

Use `unraid/templates/nexus-backup-repository.xml`.

Repository has only two persistent trust/storage roots:

| Container path | Purpose | Access |
| --- | --- | --- |
| `/config` | TLS private key/certificate, bcrypt htpasswd and local transport-password copies | read/write, **secret** |
| `/data` | encrypted Restic repository payloads from workstations | read/write |

Set **Repository host** to the LAN DNS name or IPv4 address that Windows will actually use, for example:

```text
tower.local
```

or:

```text
192.168.1.20
```

That exact name/address is placed in the generated self-signed TLS certificate. If you later change Repository host, Repository generates a new certificate and each workstation must be reprovisioned with the new pinned CA.

Default ports are:

```text
8000  Restic REST over TLS 1.3 + Basic Auth
8001  public CA/bootstrap files only
```

Port 8001 contains no password or private key. Its CA certificate is nevertheless trusted only after the installer verifies the SHA-256 supplied out-of-band by the local Repository helper.

Repository uses Restic's official `rest-server` v0.14.0, pinned and SHA-256 verified during the Nexus image build. It runs with `--private-repos`, bcrypt htpasswd auth and TLS 1.3 minimum.

Do not point Repository `/data` at the generic Agent `/backup` root or a PCWatch repository.

## 6. Create a workstation Repository principal

From the Repository container console, create a dedicated transport principal and repository namespace. For the isolated Balder acceptance test, for example:

```sh
nexus-repository-client balder-pc acceptance
```

The helper creates/reuses a random transport password and prints PowerShell lines similar to:

```powershell
$env:NEXUS_BACKUP_REPOSITORY='rest:https://tower.local:8000/balder-pc/acceptance'
$env:NEXUS_BACKUP_REST_USERNAME='balder-pc'
$env:NEXUS_BACKUP_REST_PASSWORD='<generated transport password>'
$env:NEXUS_BACKUP_REPOSITORY_CA_URL='http://tower.local:8001/repository-ca.pem'
$env:NEXUS_BACKUP_REPOSITORY_CA_SHA256='<sha256 copied from local Repository container>'
```

Treat that output as secret because it contains the REST transport password. Do not paste it into Nexus Control, screenshots, issue reports or the acceptance record.

To rotate a principal deliberately:

```sh
nexus-repository-client balder-pc acceptance --rotate
```

A rotation requires reprovisioning the workstation before its next repository operation.

## 7. Enroll and provision the Windows workstation

In Nexus **Workstations**, choose **Add workstation** and obtain the one-line elevated PowerShell enrollment command.

On the workstation, open an **elevated PowerShell** and first paste the five environment lines printed by `nexus-repository-client`. Then set the separate Restic encryption password for this repository:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<dedicated Restic encryption password>'
```

For acceptance use a new disposable test password, never a PCWatch/production key.

Now run the Nexus-generated install command in the **same elevated PowerShell process**.

The installer performs the following before starting the Scheduled Task:

1. downloads the workstation agent and Restic bundled with the exact Control image and verifies their SHA-256 files;
2. exchanges the short-lived enrollment credential for the durable local device token;
3. downloads `repository-ca.pem` from Repository port 8001;
4. compares it byte-for-byte by SHA-256 with `NEXUS_BACKUP_REPOSITORY_CA_SHA256` copied from the local Repository container;
5. stores REST transport username/password, CA path and Restic password only below `%ProgramData%\NexusBackup`, protected to SYSTEM + local Administrators;
6. explicitly initializes the exact pinned Repository namespace, or verifies an already-initialized one with `restic cat config`;
7. sets remote runtime `autoInit=false`;
8. installs/starts `NexusBackupWorkstation` as SYSTEM.

Normal workstation runtime **never initializes a remote repository after a failed probe**. Auth, TLS, network and unavailable-repository failures are failures, not permission to run `restic init`.

Normal paths are:

```text
%ProgramFiles%\Nexus Backup Workstation
%ProgramData%\NexusBackup
```

The resulting local config contains secret fields. Do not paste its contents into chat/issues:

```text
C:\ProgramData\NexusBackup\workstation.json
```

After onboarding, Nexus should report the workstation online and storage-ready while Control/browser views expose only coarse repository kind/status, not URL, password, username, CA path or encryption key.

### Control installer transport

The Control-hosted workstation installer can still be served over plain LAN HTTP in beta. Its bundled binary checksums are consistency checks, not independent MITM authenticity because script/binary/checksum share the same origin. The direct-LAN beta deployment therefore assumes a trusted LAN/Unraid host during installation.

For stronger installer transport authenticity, terminate HTTPS and configure the exact external origin with:

```text
NEXUS_BACKUP_PUBLIC_URL=https://backup.example.test
```

Nexus intentionally ignores forwarded Host/Proto headers for this trust decision.

The **Repository** data path is separately TLS protected and CA pinned as described above.

## 8. Secret/recovery boundary before production

Two different secrets exist by design:

1. **REST transport credential** — Repository authentication only; stored in Repository `/config` and workstation local config.
2. **Restic encryption password** — decrypts backup contents; workstation-local and never known by Control or Repository.

The current Nexus emergency bundle does not magically reconstruct workstation-local Restic encryption passwords, and Control is intentionally unable to fetch them. Likewise Repository `/config` contains TLS/auth state that must not be treated as disposable for production.

For the isolated acceptance test these values are disposable and can be recreated with a fresh repository. **Do not perform production cutover until the later workstation/Repository recovery-key export procedure has been completed and tested.**

## 9. Create the Control/Agent emergency bundle

Once Control auth, Agent config/secrets and device enrollment are trusted, create and verify the Nexus emergency bundle from `docs/emergency-recovery.md`.

That bundle protects Control + generic Agent control state; it does not replace the workstation/Repository secret-recovery requirement above.

## 10. Ready for isolated acceptance

Do not migrate a production workload. A fresh installation is ready to enter `docs/acceptance-test.md` only when all of these are true:

- Control, Agent and Repository image versions/digests are recorded and coordinated.
- local admin login works.
- generic Agent is online with explicit/inert-safe config.
- Repository is running on the intended dedicated workstation storage root.
- Repository host matches the address/name Windows uses and the CA hash was obtained locally.
- the workstation was provisioned with a dedicated Repository principal and a disposable acceptance encryption password.
- workstation is online and storage-ready.
- generic and workstation repository roots are isolated from each other, PCWatch and production repositories.
- default Agent has no `SYS_ADMIN`/`/dev/fuse` unless deliberately required.
- a Control/Agent emergency bundle has been created and verified.
- PCWatch-backup and Copyarr have not been disabled, changed or repointed.

If any item is uncertain, stop before acceptance rather than testing against production data or repositories.
