# Nexus Backup on Unraid (beta packaging)

Nexus Backup is a self-contained product made from two containers:

1. **NexusBackup-Control** — dashboard, local auth, SQLite, schedules and job orchestration.
2. **NexusBackup-Agent** — storage access, rclone, restic, FUSE and execution.

The split is a security boundary, not a remote dependency. Both containers run on the same Unraid host and Nexus Backup remains fully functional without Cloudflare or another external service.

These templates are intentionally beta/manual until they have been tested on a real Unraid installation. They are not yet submitted to Community Applications.

For a clean deployment, follow `docs/fresh-install.md`. Do not treat this packaging reference as a production cutover procedure. The isolated proof procedure is `docs/acceptance-test.md`.

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
/data       default host path /mnt/user/nexus-backup-source        read-only
/backup     default host path /mnt/user/backups/nexus-backup
/restore    default host path /mnt/user/restore/nexus-backup
/downloads  default host path /mnt/user/downloads
```

These are convenience defaults, not assumptions about your final layout. The `/data` default is deliberately narrow instead of exposing all of `/mnt/user`; point it at the exact share/directory you intend Nexus to protect.

A critical containment rule still applies: **the configured backup source must not be able to descend into its own repository or restore staging tree**. Do not widen `/data` to `/mnt/user` and then configure `paths: ["/data"]` while `/backup` or `/restore` also map somewhere beneath `/mnt/user` on the host. Prefer a narrow `/data` host mapping and a correspondingly narrow path in `agent.json`.

Agent is the only container granted:

```text
--cap-add=SYS_ADMIN
--device=/dev/fuse
```

Control must not receive these permissions or storage mappings.

## Install order

1. Install **NexusBackup-Control** from `unraid/templates/nexus-backup-control.xml`.
2. Start it and confirm TCP 8787 is free on the Unraid host.
3. Open `http://<unraid-ip>:8787/healthz` and require a healthy response.
4. Install **NexusBackup-Agent** from `unraid/templates/nexus-backup-agent.xml`.
5. Keep the shared appdata/runtime paths identical between both templates unless deliberately changing both sides.
6. Open `http://<unraid-ip>:8787/`.
7. On first run, read the one-time local setup token from the Control container log and create the local admin password.
8. Deliberately configure `/mnt/user/appdata/nexus-backup/agent/agent.json` for the actual deployment.
9. Store Restic password files and rclone configuration under the Agent config directory referenced by `agent.json`.
10. Validate the config before queueing work.

A fresh Agent now creates an **inert** starter `agent.json` if the file does not exist. It contains no sources, repositories, restore targets, rclone endpoints or rTorrent gates. This is intentional; a fresh installation must not acquire a backup target by accident.

`config/agent.example.json` is a worked example only and is not copied as the startup configuration.

Validate the live configuration with:

```sh
docker exec NexusBackup-Agent node apps/agent/bin/agent.mjs --check-config
```

## Container updates

The templates track:

```text
ghcr.io/swamp2k/nexus-backup-control:latest
ghcr.io/swamp2k/nexus-backup-agent:latest
```

Stable Nexus Backup releases move `latest` to a new registry digest. This is the update channel intended for Unraid's normal Docker update detection. Immutable SemVer tags such as `0.7.0` remain available for rollback or deliberate pinning.

For acceptance or rollback, record and preferably pin the exact coordinated Control/Agent release rather than relying only on a moving `latest` tag.

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
