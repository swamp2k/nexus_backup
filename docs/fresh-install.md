# Fresh install: Unraid + Windows workstation

This runbook installs Nexus Backup from a clean state using the current **one-app / one-container** Unraid architecture.

It does **not** cut over any existing production backup workload. PCWatch-backup and standalone Copyarr remain untouched until the isolated acceptance procedure in `docs/acceptance-test.md` has passed and a later cutover is explicitly approved.

## 1. Deployment model

Nexus Backup is one Unraid container plus an optional Windows workstation agent.

Inside the container, three coordinated internal services run together:

```text
Browser
  -> Control (:8787)
       - UI/API
       - local auth
       - SQLite
       - schedules/job state

Agent
  - generic Restic/rclone/transfer execution
  - local source/repository mappings
  - talks to Control only at 127.0.0.1

Repository (:8000 TLS)
  - Restic REST endpoint for Windows workstations
  - dedicated workstation repository storage
  - local TLS + bcrypt transport authentication

Windows workstation agent
  - runs backup/recovery locally on Windows
  - sends backup bytes directly to Repository
  - owns its Restic encryption password and REST transport credential locally
  - talks to Control only for metadata/orchestration
```

The workstation data path remains:

```text
Windows Restic -> TLS -> Repository process -> /backup/workstations
```

Backup payloads do not flow through Control.

The one-container packaging intentionally trades the old Docker mount-namespace separation for Unraid simplicity: one Community Apps entry, one install, one image update and one WebUI.

## 2. Before installing

Record the exact Nexus release/tag/digest you intend to test. Reproducible acceptance must use an immutable image digest.

The Community Apps/Unraid template intentionally uses `:latest` for normal stable distribution. **Do not leave the Repository field on `:latest` during acceptance.** Override it with the exact recorded digest:

```text
ghcr.io/swamp2k/nexus-backup@sha256:<recorded-digest>
```

This prevents a later tag move from silently changing the build under test.

Verify:

- Docker is available on Unraid.
- TCP 8787 and 8000 are free unless deliberately changed.
- PCWatch and existing production backup repositories are not under the Nexus backup root.
- you know the exact LAN DNS name or IPv4 address Windows workstations use to reach Unraid.

The default mappings are:

```text
/config      /mnt/user/appdata/nexus-backup              read/write
/state       /mnt/user/appdata/nexus-backup-state        read/write
/data        /mnt/user/nexus-backup-source               read-only
/backup      /mnt/user/backups/nexus-backup              read/write
/restore     /mnt/user/restore/nexus-backup              read/write
/downloads   /mnt/user/downloads                         read/write
```

Inside `/backup`, Nexus separates:

```text
/backup/generic       generic Agent repositories
/backup/workstations  Windows workstation repositories
```

Do not map the whole `/mnt/user` tree as `/data` merely for convenience. Source/repository/restore containment remains a hard safety rule.

`/dev/fuse` is **not** a normal prerequisite. The default appliance has no `SYS_ADMIN`, no `/dev/fuse` and is not privileged. Those are only needed if the optional rclone-mounted remote-source feature is deliberately enabled.

## 3. Install NexusBackup

Use `unraid/templates/nexus-backup.xml` or equivalent values, but for acceptance replace the template's `:latest` Repository value with the immutable digest recorded in section 2 before creating/starting the container.

Set **Repository host** to the LAN DNS name or IPv4 address Windows will actually use, for example:

```text
tower.local
```

or:

```text
192.168.1.20
```

That exact value is embedded in the generated self-signed Repository TLS certificate. Changing it later creates a new certificate and requires workstation reprovisioning with the new pinned CA.

Start **NexusBackup** and verify:

```text
http://<unraid-ip>:8787/healthz
```

The appliance supervisor starts Control and Repository first, waits for Control to create the local Agent token, then starts Agent. The token lives only beneath `/run/nexus-backup` for the container lifetime; no shared runtime host mapping is required.

If any core service exits, the appliance stops as one unit so Unraid/Docker restart policy can recover it. A half-alive UI is not treated as healthy.

### First local-admin bootstrap

A brand-new `/config/control` creates a one-time setup token and writes it to the privileged NexusBackup container log. Open:

```text
http://<unraid-ip>:8787/
```

and complete local-admin setup. After setup, auth state is persistent under `/config/control` and the one-time setup token is removed.

## 4. Fresh Agent config

If `/config/agent/agent.json` does not exist, Nexus creates this inert starter config:

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

`config/agent.example.json` remains only a worked example.

Validate the live Agent config with:

```sh
docker exec NexusBackup node /app/apps/agent/bin/agent.mjs --check-config
```

A generic write restore target is a **staging root**, never an in-place destination. Validation requires `overwrite: "never"`; write restore creates a fresh run-specific staging directory.

## 5. Repository service inside the same container

Repository state lives beneath:

```text
/config/repository
```

Workstation backup payloads live beneath:

```text
/backup/workstations
```

Repository exposes only:

```text
8000  Restic REST over TLS 1.3 + Basic Auth
```

There is no HTTP CA/bootstrap port. Repository uses official `rest-server` v0.14.0 pinned and SHA-256 verified during the Nexus image build, with private repositories and bcrypt htpasswd authentication.

The fact that Repository now shares a container with Control/Agent does **not** change the logical credential rule: Control must never receive REST transport credentials or workstation Restic encryption passwords.

## 6. Create a workstation Repository principal

From the **NexusBackup container console**, create a dedicated transport principal and repository namespace. For the isolated Balder acceptance test:

```sh
nexus-repository-client balder-pc acceptance
```

The helper creates/reuses a random transport password and prints PowerShell values for:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_B64
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

The CA is public material, but treat the helper output as secret because it also contains the REST transport password. Do not paste it into Control, screenshots, issue reports or the acceptance record.

To rotate a principal deliberately:

```sh
nexus-repository-client balder-pc acceptance --rotate
```

A rotation requires workstation reprovisioning.

## 7. Enroll and provision Windows

In Nexus **Workstations**, choose **Add workstation** and obtain the generated elevated PowerShell command.

On Windows, open an elevated PowerShell, paste the five Repository environment lines from `nexus-repository-client`, then add a separate Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<dedicated Restic encryption password>'
```

For acceptance use a new disposable password, never a PCWatch/production key.

Run the Nexus-generated install command in the **same** elevated PowerShell session.

The installer must:

1. download the workstation agent and Restic bundled with the exact Nexus image and verify their SHA-256 files;
2. exchange the short-lived enrollment credential for the durable device token;
3. decode the locally supplied Repository CA;
4. verify it against `NEXUS_BACKUP_REPOSITORY_CA_SHA256` before trusting Repository TLS;
5. store REST transport username/password, CA path and Restic encryption password only below `%ProgramData%\NexusBackup`, protected to SYSTEM + local Administrators;
6. explicitly initialize/verify the exact pinned Repository namespace;
7. set remote runtime `autoInit=false`;
8. install/start `NexusBackupWorkstation` as SYSTEM.

Normal runtime **never** initializes a remote repository after an auth, TLS, network or repository probe failure.

Normal paths are:

```text
%ProgramFiles%\Nexus Backup Workstation
%ProgramData%\NexusBackup
```

Do not paste `C:\ProgramData\NexusBackup\workstation.json` into chat/issues; it contains secrets.

## 8. Installer transport boundary

The Control-hosted workstation installer can still be served over plain LAN HTTP in beta. The bundled checksums prove consistency but not independent MITM authenticity because script/binary/checksum share an origin.

Direct-LAN beta therefore assumes a trusted LAN/Unraid host during installation.

For stronger transport authenticity, terminate HTTPS and configure:

```text
NEXUS_BACKUP_PUBLIC_URL=https://backup.example.test
```

Nexus intentionally ignores forwarded Host/Proto headers for this trust decision.

Repository traffic is separately TLS protected with a CA pinned from the local container helper output.

## 9. Secret/recovery boundary before production

Two independent secret classes exist:

1. **REST transport credential** — stored under `/config/repository` and workstation local config.
2. **Restic encryption password** — decrypts backup contents; workstation-local and never known by Control/Repository.

For isolated acceptance these can be disposable. **Do not perform production cutover** until off-host recovery of workstation encryption keys and `/config/repository` has been implemented and tested.

## 10. Emergency bundle

Create and verify the Nexus emergency bundle according to `docs/emergency-recovery.md` after local auth, Agent config/secrets and enrollment are trusted.

The emergency bundle protects Nexus control/generic-Agent state; it does not replace the workstation encryption-key / Repository-config recovery gate.

## 11. Ready for isolated acceptance

A fresh installation is ready to enter `docs/acceptance-test.md` only when:

- the exact one-container image version/digest is recorded and the running container is pinned to that digest rather than `:latest`;
- local admin login works;
- Agent is online with explicit/inert-safe config;
- Repository TLS service is running on the intended `/backup/workstations` tree;
- Repository host matches the address/name Windows uses;
- the workstation is provisioned with a dedicated Repository principal and disposable acceptance encryption password;
- workstation is online and storage-ready;
- `/data` is narrow/read-only and does not contain `/backup` or `/restore` through the host mapping;
- the container has no `SYS_ADMIN`/`/dev/fuse` unless deliberately required;
- an emergency bundle has been created and verified;
- PCWatch-backup and Copyarr remain unchanged.

If any item is uncertain, stop before acceptance rather than testing against production data or repositories.
