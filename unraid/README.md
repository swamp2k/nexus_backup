# Nexus Backup on Unraid (beta packaging)

Nexus Backup is one self-contained product split into three local containers:

1. **NexusBackup-Control** — dashboard, local auth, SQLite, schedules and job orchestration.
2. **NexusBackup-Agent** — generic Restic/rclone/transfer execution and generic storage credentials.
3. **NexusBackup-Repository** — TLS-authenticated Restic REST endpoint dedicated to Windows workstation repositories.

The split is a security boundary, not a remote dependency. All three run on the Unraid host and normal operation requires no Cloudflare or external control service.

Windows workstation backup bytes travel directly:

```text
Windows Restic -> TLS -> NexusBackup-Repository -> Unraid repository storage
```

They do not pass through Control or the generic Agent.

These templates remain beta/manual until the full real-machine acceptance drill has passed. For a clean deployment use `docs/fresh-install.md`; for the isolated proof use `docs/acceptance-test.md`.

## Networking

The Unraid templates use host networking for simple local endpoints:

```text
8787  NexusBackup-Control
8000  NexusBackup-Repository Restic REST over TLS
8001  NexusBackup-Repository CA/bootstrap files only
```

Repository port 8001 exposes only the public self-signed CA certificate and non-secret endpoint metadata. The workstation installer trusts that certificate only after verifying the SHA-256 copied from the local `nexus-repository-client` helper.

Repository Basic Auth is never intended to travel over plain HTTP. Backup traffic uses TLS 1.3 by default.

## Persistent path contract

Control and Agent shared state:

```text
Host                                           Control              Agent
/mnt/user/appdata/nexus-backup/control         /config              -
/mnt/user/appdata/nexus-backup/runtime         /run/nexus-backup    /run/nexus-backup (ro)
/mnt/user/appdata/nexus-backup/agent           /agent-config (ro)   /config
/mnt/user/appdata/nexus-backup/state           -                    /state
```

Repository state/storage:

```text
Host                                                   Repository
/mnt/user/appdata/nexus-backup/repository              /config
/mnt/user/backups/nexus-backup/workstations            /data
```

Repository `/config` is secret material: TLS private key, bcrypt htpasswd and local transport-password copies. Repository `/data` contains encrypted Restic repository payloads.

Do not point Control `/agent-config` and Agent `/config` at different host directories. Control gets only the read-only Agent config view used for sanitized UI metadata.

## Storage isolation

The default generic Agent mappings are:

```text
/data       /mnt/user/nexus-backup-source                 read-only
/backup     /mnt/user/backups/nexus-backup/generic        read/write
/restore    /mnt/user/restore/nexus-backup                 read/write
/downloads  /mnt/user/downloads                           read/write
```

The default workstation Repository root is separately:

```text
/data       /mnt/user/backups/nexus-backup/workstations   read/write
```

Generic and workstation repository roots are intentionally siblings. Do not make either one contain the other, and never point either at a PCWatch repository.

The generic source containment rule remains critical: a source visible beneath Agent `/data` must not be able to descend into its own generic repository or restore staging tree. The `/data` default is deliberately narrow and read-only rather than all of `/mnt/user`.

## Privileges

All three templates have:

```text
Privileged=false
```

Control and Repository never need FUSE or `SYS_ADMIN`.

Normal generic backup/restore/integrity/rclone copy/managed transfer also does not need FUSE. Only the optional `rclone-restic-backup` feature that mounts a remote rclone endpoint as a read-only source requires manual Agent-only expansion:

```text
--cap-add=SYS_ADMIN --device=/dev/fuse
```

Remove that expansion when the mounted-source feature is not used.

## Install order

1. Install **NexusBackup-Control** from `unraid/templates/nexus-backup-control.xml`.
2. Start it, verify `http://<unraid-ip>:8787/healthz`, then complete first local-admin setup.
3. Install **NexusBackup-Agent** from `unraid/templates/nexus-backup-agent.xml` using the matching shared runtime/config paths.
4. Confirm its fresh `agent.json` is inert, then deliberately configure only the generic sources/repositories/transfers you need.
5. Install **NexusBackup-Repository** from `unraid/templates/nexus-backup-repository.xml`.
6. Set `NEXUS_BACKUP_REPOSITORY_HOST` to the exact LAN DNS name or IPv4 address Windows workstations will use. The generated TLS certificate is bound to this value.
7. Keep Repository `/data` separate from generic Agent `/backup`, PCWatch and production repositories not yet migrated.
8. Create a dedicated workstation Repository principal/namespace from the Repository console.
9. Enroll/provision the Windows workstation using the helper output plus its separate Restic encryption password.
10. Run the isolated acceptance procedure before any production cutover.

## Generic Agent first start

A fresh Agent creates an **inert** starter config if `/config/agent.json` does not exist:

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

`config/agent.example.json` is only a worked example; it is not copied as the live starter configuration.

Validate live Agent config with:

```sh
docker exec NexusBackup-Agent node apps/agent/bin/agent.mjs --check-config
```

## Workstation Repository onboarding

Create a per-workstation transport principal/repository namespace from the Repository console, for example:

```sh
nexus-repository-client balder-pc acceptance
```

The helper prints secret PowerShell environment values for:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_URL
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

Paste them only into the elevated PowerShell session that will run the Nexus workstation install command, then add the separate Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<encryption password>'
```

The installer verifies the Repository CA hash, stores secrets only under the SYSTEM/Admin-protected workstation ProgramData directory and explicitly initializes/verifies that pinned Repository namespace. Normal workstation runtime never auto-initializes a remote repository after an auth/TLS/network failure.

To deliberately rotate the REST transport password:

```sh
nexus-repository-client balder-pc acceptance --rotate
```

Reprovision the workstation after rotation.

## Secret boundaries

- Control never receives Repository REST username/password.
- Repository never needs the Restic encryption password.
- the workstation owns its Restic encryption password locally.
- Repository `/config` owns TLS/auth material locally.
- browser/API views must expose only coarse repository status/kind, never those secrets or raw credential-bearing locations.

Before production cutover, workstation encryption-key recovery and Repository `/config` off-host recovery must be implemented and proven. Disposable acceptance secrets do not waive that production gate.

## Container updates

The templates track coordinated release images:

```text
ghcr.io/swamp2k/nexus-backup-control:latest
ghcr.io/swamp2k/nexus-backup-agent:latest
ghcr.io/swamp2k/nexus-backup-repository:latest
```

Treat all three as one release. For acceptance/rollback record and preferably pin the exact SemVer tag and image digest instead of relying only on moving `latest`.

Before the first real Unraid release, all three GHCR packages must be public for anonymous Unraid pulls.

Installed Unraid templates are persistent local configuration; XML changes are not guaranteed to merge automatically into existing installations. Any future path/environment contract change must therefore have an explicit migration step.

## Manual template URLs after this beta lands on main

```text
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup-control.xml
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup-agent.xml
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup-repository.xml
```

Community Applications submission comes only after the three-container deployment and isolated restore/failure drill have passed on real Unraid/Windows hardware.
