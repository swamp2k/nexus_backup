# Nexus Backup on Unraid (beta packaging)

Nexus Backup is a self-contained product made from two containers:

1. **NexusBackup-Control** — dashboard, local auth, SQLite, schedules and job orchestration.
2. **NexusBackup-Agent** — storage access, rclone, restic, FUSE and execution.

The split is a security boundary, not a remote dependency. Both containers run on the same Unraid host and Nexus Backup remains fully functional without Cloudflare or another external service.

These templates are intentionally beta/manual until they have been tested on a real Unraid installation. They are not yet submitted to Community Applications.

## Why both templates use host networking

Unraid does not natively deploy this project through Docker Compose. Using host networking for both containers gives the local agent a stable control endpoint:

```text
http://127.0.0.1:8787
```

No custom Docker network, static container IP or host-gateway alias is required. Control currently reserves TCP 8787 on the Unraid host.

## Persistent path contract

The default templates use these shared paths:

```text
Host                                           Control              Agent
/mnt/user/appdata/nexus-backup/control         /config              -
/mnt/user/appdata/nexus-backup/runtime         /run/nexus-backup    /run/nexus-backup (ro)
/mnt/user/appdata/nexus-backup/agent           /agent-config (ro)   /config
/mnt/user/appdata/nexus-backup/state           -                    /state
```

Do not point Control `/agent-config` and Agent `/config` at different host directories. Control intentionally receives only a read-only view so it can show sanitized configuration without owning storage credentials.

The shared runtime directory contains the generated local agent token. Control writes it and Agent reads it. The token is never exposed to the browser.

## Agent storage mappings

The beta Agent template also exposes editable storage roots:

```text
/data       default host path /mnt/user                    read-only
/backup     default host path /mnt/user/backups/nexus-backup
/restore    default host path /mnt/user/restore/nexus-backup
/downloads  default host path /mnt/user/downloads
```

These are convenience defaults, not assumptions about your final layout. Review them during installation and point them at the shares/pools you actually want to use. Narrow `/data` if Nexus Backup should not see every user share.

Agent is the only container granted:

```text
--cap-add=SYS_ADMIN
--device=/dev/fuse
```

Control must not receive these permissions or storage mappings.

## Install order

1. Install **NexusBackup-Control** from `unraid/templates/nexus-backup-control.xml`.
2. Start it and confirm TCP 8787 is free on the Unraid host.
3. Install **NexusBackup-Agent** from `unraid/templates/nexus-backup-agent.xml`.
4. Keep the default shared appdata/runtime paths identical between both templates unless deliberately changing both sides.
5. Open `http://<unraid-ip>:8787/`.
6. On first run, read the one-time local setup token from the Control container log and create the local admin password.
7. Edit `/mnt/user/appdata/nexus-backup/agent/agent.json` for your real sources, repositories, rclone remotes and optional rTorrent gate.
8. Store the Restic password file and rclone configuration under the Agent config directory referenced by `agent.json`.

The Agent entrypoint creates a starter `agent.json` automatically if the file does not exist.

## Container updates

The templates track:

```text
ghcr.io/swamp2k/nexus-backup-control:latest
ghcr.io/swamp2k/nexus-backup-agent:latest
```

Stable Nexus Backup releases move `latest` to a new registry digest. This is the update channel intended for Unraid's normal Docker update detection. Immutable SemVer tags such as `0.7.0` remain available for rollback or deliberate pinning.

Before the first real Unraid release, both GHCR packages must be made **Public** so Unraid can pull them anonymously.

Because Nexus Backup has two coordinated images, update Control and Agent together. The Agent page shows the running agent release version through its heartbeat. A future compatibility guard can make version skew more explicit, but the deployment contract should already treat the two images as one product release.

## Template updates are different from image updates

Installed Unraid Docker templates are persistent local configuration. A later change to the repository XML should not be assumed to merge automatically into an existing installation.

For that reason, normal Nexus Backup upgrades must preserve the container path/environment contract and happen through new image digests. Any future template change that requires a manual path/environment migration must be documented as an explicit upgrade step.

## Manual template URLs after this beta lands on main

```text
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup-control.xml
https://raw.githubusercontent.com/swamp2k/nexus_backup/main/unraid/templates/nexus-backup-agent.xml
```

Community Applications submission comes only after the two-container install has been tested on Unraid and the first GHCR release images exist publicly.
