# Nexus Backup on Unraid (beta packaging)

Nexus Backup is packaged as **one Unraid app and one Docker container**.

Inside that appliance container, three coordinated internal processes run together:

1. **Control** — dashboard, local auth, SQLite, schedules and job orchestration.
2. **Agent** — generic Restic/rclone/transfer execution and local storage access.
3. **Repository** — TLS-authenticated Restic REST endpoint for Windows workstation repositories.

This packaging is intentional. The previous beta used three separately installed containers, which provided stronger Docker mount-namespace isolation but exposed Nexus as three separate Community Apps/install/update surfaces. For Unraid the product goal is one app, one install, one update button and one WebUI.

Windows workstation backup bytes still travel directly:

```text
Windows Restic -> TLS -> Repository process -> /backup/workstations
```

They do not pass through Control. Agent talks to Control only over `127.0.0.1` inside the same container.

Use `docs/fresh-install.md` for a clean deployment and `docs/acceptance-test.md` for the isolated proof before production cutover.

## Networking

The single container uses host networking and exposes two service ports:

```text
8787  Nexus Backup WebUI / Control API
8000  Workstation Restic REST over TLS 1.3
```

Repository exposes no HTTP CA/bootstrap port. The local `nexus-repository-client` helper carries the public Repository CA certificate as base64 plus its SHA-256 into the elevated workstation onboarding session. The installer decodes the CA and refuses it unless the hash matches before Restic is allowed to connect.

## Persistent layout

One Unraid appdata mapping owns the three internal config domains:

```text
/config/control       Control DB, auth and secrets
/config/agent         Agent config and storage credentials
/config/repository    Repository TLS/auth/client material
/state                Agent cache/state
```

One backup-root mapping is internally divided into:

```text
/backup/generic       generic Agent Restic repositories
/backup/workstations  Windows workstation Restic repositories
```

The default host mappings are:

```text
/config      /mnt/user/appdata/nexus-backup              read/write
/state       /mnt/user/appdata/nexus-backup-state        read/write
/data        /mnt/user/nexus-backup-source               read-only
/backup      /mnt/user/backups/nexus-backup              read/write
/restore     /mnt/user/restore/nexus-backup              read/write
/downloads   /mnt/user/downloads                         read/write
```

`/config/repository` contains secret material: TLS private key/certificate, bcrypt htpasswd and local transport-password copies. `/backup/workstations` contains encrypted Restic repository payloads.

The generic source containment rule remains critical: do not casually map all of `/mnt/user` as `/data`, because a source must not descend into its own repository or restore staging tree.

## Privileges

The Unraid template has:

```text
Privileged=false
```

Normal backup, restore, integrity, Repository service and managed transfer do **not** need FUSE or `SYS_ADMIN`.

Only the optional rclone-mounted remote-source feature needs the explicit advanced expansion:

```text
--cap-add=SYS_ADMIN --device=/dev/fuse
```

Do not add those privileges unless that feature is deliberately enabled.

The one-container model intentionally gives up the stronger Docker mount-namespace isolation that existed between the old Control/Agent/Repository containers. This trade-off is accepted for the Unraid product target; Nexus does not treat the Unraid host as a hostile multi-tenant security boundary.

## Install

1. Install **NexusBackup** from `unraid/templates/nexus-backup.xml`.
2. Set `NEXUS_BACKUP_REPOSITORY_HOST` to the exact LAN DNS name or IPv4 address Windows workstations use to reach Unraid.
3. Review source, backup, restore and download mappings before starting real jobs.
4. Start the container and open `http://<unraid-ip>:8787/`.
5. Complete first local-admin setup.
6. Confirm the fresh Agent config is inert, then deliberately configure only the sources/repositories/transfers you need.
7. Create a dedicated workstation Repository principal/namespace from the **same NexusBackup container console** when provisioning a Windows workstation.
8. Run the isolated acceptance procedure before any production cutover.

There is no companion Control/Agent/Repository app to install.

## Startup/failure model

The appliance supervisor starts Control and Repository first, waits for Control to create the local Agent token, then starts Agent.

The generated agent token lives only beneath `/run/nexus-backup` inside the container lifetime; it no longer needs a persistent/shared host mapping.

If any of the three core processes exits, the supervisor stops the entire container. Docker/Unraid restart policy then recovers the appliance as a coordinated unit. A half-alive dashboard with a dead Agent or Repository is intentionally not considered healthy.

## Fresh Agent config

A fresh appliance creates an **inert** Agent config if `/config/agent/agent.json` does not exist:

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

`config/agent.example.json` is only a worked example; it is never copied as the live starter configuration.

Validate the live Agent config with:

```sh
docker exec NexusBackup node /app/apps/agent/bin/agent.mjs --check-config
```

## Workstation Repository onboarding

Create a per-workstation transport principal/repository namespace from the NexusBackup console, for example:

```sh
nexus-repository-client balder-pc acceptance
```

The helper prints secret PowerShell environment values for:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_B64
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

Paste them only into the elevated PowerShell session that runs the Nexus workstation installer, then add the separate Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<encryption password>'
```

The installer hash-verifies the Repository CA locally, stores secrets only under the SYSTEM/Admin-protected workstation ProgramData directory and explicitly initializes/verifies that pinned Repository namespace. Normal workstation runtime never auto-initializes a remote repository after an auth/TLS/network failure.

Rotate the REST transport password deliberately with:

```sh
nexus-repository-client balder-pc acceptance --rotate
```

Reprovision the workstation after rotation.

## Secret boundaries

- Control never receives Repository REST username/password.
- Repository does not need the Restic encryption password.
- the workstation owns its Restic encryption password locally.
- Repository config owns TLS/auth material locally.
- browser/API views expose only sanitized metadata, never credential-bearing storage locations.

These are application/process boundaries now, not separate Docker mount namespaces.

Before production cutover, workstation encryption-key recovery and Repository config off-host recovery must be implemented and proven. Disposable acceptance secrets do not waive that gate.

## Updates and Community Apps

The public deployment image is:

```text
ghcr.io/swamp2k/nexus-backup:<version>
```

Control, Agent and Repository are therefore always the exact same coordinated version. There is one Community Apps entry, one image pull and one Unraid update action.

For acceptance/rollback record and preferably pin the exact SemVer tag and immutable image digest rather than relying only on moving `latest`.

Manual beta template URL after this change lands on `main`:

```text
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup.xml
```

Community Applications submission comes only after the one-container deployment and isolated restore/failure drill have passed on real Unraid/Windows hardware.
