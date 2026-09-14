# Emergency recovery: recover Nexus Backup without Nexus Backup

This runbook covers loss of the Nexus Backup application/container while backup repositories and/or persistent appdata still exist. It does not require Cloudflare, PCWatch or a running Nexus worker.

The current Unraid product is **one NexusBackup appliance container**. Control, Agent and Repository are internal processes, but this emergency bundle continues to protect Control + generic-Agent state only. Workstation encryption-key recovery and Repository `/config/repository` recovery remain a separate pre-production gate.

The exporter copies this complete runbook into every bundle as `EMERGENCY-RECOVERY.md` and covers it with the bundle manifest.

## What must exist outside Nexus

Keep at least one recent emergency bundle **off the Nexus host** and encrypted. It contains privileged backup-system secrets.

The bundle contains:

- a consistent SQLite snapshot from `/config/control/nexus-backup.sqlite`;
- Control identity/auth secrets from `/config/control`;
- the complete generic Agent configuration tree from `/config/agent`;
- this runbook;
- `manifest.json` with version/revision, migrations, file sizes and SHA-256 inventory;
- `RECOVERY.txt`.

It intentionally does **not** contain backup repository payloads, source data, restore staging, disposable caches, workstation-local Restic encryption passwords or the Repository TLS/auth tree at `/config/repository`.

That last exclusion is deliberate: before production cutover Nexus must separately prove off-host recovery of workstation encryption keys and Repository TLS/auth/client material. A generic Nexus emergency bundle is not allowed to pretend those secrets are recoverable when they are not.

Keep an offline archive of the exact **single appliance image** alongside the encrypted bundle so disaster recovery does not depend on GHCR availability.

## Create a bundle while Nexus is healthy

For Compose:

```sh
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec nexus-backup node apps/local-server/bin/emergency-export.mjs "/tmp/nexus-backup-emergency-$STAMP"
docker compose cp "nexus-backup:/tmp/nexus-backup-emergency-$STAMP" "./nexus-backup-emergency-$STAMP"
docker compose exec nexus-backup rm -rf "/tmp/nexus-backup-emergency-$STAMP"
```

For Unraid, the equivalent commands use the container name `NexusBackup`:

```sh
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker exec NexusBackup node /app/apps/local-server/bin/emergency-export.mjs "/tmp/nexus-backup-emergency-$STAMP"
docker cp "NexusBackup:/tmp/nexus-backup-emergency-$STAMP" "./nexus-backup-emergency-$STAMP"
docker exec NexusBackup rm -rf "/tmp/nexus-backup-emergency-$STAMP"
```

The appliance environment points the exporter at `/config/control` and `/config/agent/agent.json`; the exporter runs SQLite `quick_check`, creates a consistent `VACUUM INTO` snapshot, verifies with `integrity_check`, rejects symlinks and writes a SHA-256 inventory.

Verify the copied bundle with the exact appliance image you deployed:

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup:<tag-or-digest>"
docker run --rm \
  -v "$PWD/nexus-backup-emergency-$STAMP:/bundle:ro" \
  --entrypoint node \
  "$IMAGE" \
  /app/apps/local-server/bin/emergency-export.mjs --verify /bundle
```

A successful verification prints JSON containing `"ok": true`.

The SHA-256 manifest detects corruption/mismatch relative to the manifest. It is **not** a signature against an attacker able to replace both files and `manifest.json`. Protect the whole bundle with trusted encrypted/offline storage.

## Keep the exact appliance image offline

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup:<exact-tag-or-digest>"
ARCHIVE="nexus-backup-appliance.tar"

docker image inspect "$IMAGE" >/dev/null
docker image save -o "$ARCHIVE" "$IMAGE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
sha256sum -c "$ARCHIVE.sha256"
```

Store the archive and checksum off-host with the emergency bundle. A disposable `docker load` test is stronger evidence than merely retaining the tar.

Refresh the bundle after enrollment/credential changes, generic repository/rclone config changes, meaningful policy changes and upgrades/migrations. Refresh the image archive whenever the deployed appliance identity changes.

Never keep the only recovery copy on the same Docker volume, Unraid appdata share or physical host it is intended to recover.

## Export after Nexus has stopped but appdata survives

For the Unraid default, `/config` maps to `/mnt/user/appdata/nexus-backup`. Keep the normal appliance stopped and mount that surviving root into a one-shot copy of the exact appliance image:

```sh
APPDATA="/mnt/user/appdata/nexus-backup"
IMAGE="ghcr.io/swamp2k/nexus-backup:<known-good-tag-or-digest>"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PWD/emergency-export"

docker run --rm \
  -e NEXUS_BACKUP_CONFIG_DIR=/config/control \
  -e NEXUS_BACKUP_AGENT_CONFIG=/config/agent/agent.json \
  -v "$APPDATA:/config" \
  -v "$PWD/emergency-export:/export" \
  --entrypoint node \
  "$IMAGE" \
  /app/apps/local-server/bin/emergency-export.mjs "/export/nexus-backup-emergency-$STAMP"
```

Do not run this against appdata while the normal appliance is active. Verify the resulting bundle before using it.

## Disaster restore: safe sequence

### 0. Recover the pinned appliance image if necessary

If GHCR is unavailable:

```sh
ARCHIVE="/path/to/nexus-backup-appliance.tar"
cd "$(dirname "$ARCHIVE")"
sha256sum -c "$(basename "$ARCHIVE").sha256"
docker load -i "$ARCHIVE"
```

Use the image version/revision recorded by the bundle for the first recovery boot; do not casually substitute a newer image that may perform migrations.

### 1. Freeze execution

Stop the normal `NexusBackup` container. Prevent Windows workstation agents from reaching the normal Nexus endpoint during recovery.

If original appdata still exists, do not delete or overwrite it. It remains evidence/rollback material.

### 2. Verify the immutable emergency bundle

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup:<bundle-version-or-known-good-tag>"
docker run --rm \
  -v "/path/to/emergency-bundle:/bundle:ro" \
  --entrypoint node \
  "$IMAGE" \
  /app/apps/local-server/bin/emergency-export.mjs --verify /bundle
```

Stop if manifest or SQLite integrity verification fails.

### 3. Create disposable inspection state

The first boot exists only for inspection. Never promote it to recovered production state.

```sh
docker volume create nexus-inspect-config
```

Populate the Control and Agent subtrees from the verified bundle:

```sh
docker run --rm \
  -v "/path/to/emergency-bundle/control:/from-control:ro" \
  -v "/path/to/emergency-bundle/agent-config:/from-agent:ro" \
  -v nexus-inspect-config:/to \
  --entrypoint sh \
  "$IMAGE" -eu -c '
    mkdir -p /to/control /to/agent /to/repository
    cp -a /from-control/. /to/control/
    cp -a /from-agent/. /to/agent/
  '
```

The emergency bundle intentionally does not provide production Repository auth/TLS state. For this **inspection-only** boot, set an isolated disposable Repository host/config and do not allow real workstations to connect.

### 4. Isolated first boot

Run the appliance on an isolated Docker network or otherwise ensure external workstations cannot reach it. For example, expose Control only on loopback and use disposable Repository state:

```sh
docker volume create nexus-inspect-backup

docker run --rm --name nexus-recovery-inspect \
  -p 127.0.0.1:18787:8787 \
  -e NEXUS_BACKUP_REPOSITORY_HOST=127.0.0.1 \
  -v nexus-inspect-config:/config \
  -v nexus-inspect-backup:/backup \
  "$IMAGE"
```

Inspect via `http://127.0.0.1:18787/`:

- `/healthz`;
- local admin login;
- workstation/device inventory;
- policies, schedules and job history;
- last successful snapshot state;
- expected Nexus version/revision and migration state.

Normal schedulers may mutate this disposable inspection copy. That is why it must never become production state.

### 5. Destroy inspection state

```sh
docker rm -f nexus-recovery-inspect 2>/dev/null || true
docker volume rm nexus-inspect-config nexus-inspect-backup
```

Keep the original verified emergency bundle unchanged.

### 6. Restore fresh production appdata from the bundle

Create a fresh production config root, never reuse inspection state:

```sh
RECOVERY_CONFIG="/path/to/fresh/nexus-backup-appdata"
mkdir -p "$RECOVERY_CONFIG/control" "$RECOVERY_CONFIG/agent" "$RECOVERY_CONFIG/repository"
```

Copy Control and Agent material again from the immutable bundle. Then restore `/config/repository` from its **separately proven off-host recovery material** before allowing production workstation Repository traffic.

If no valid Repository recovery material exists, do not pretend the workstation Repository service is production-recovered. Keep it isolated, reconstruct/reprovision according to the production recovery procedure, and prove repository access before reconnecting workstations.

Start the one `NexusBackup` appliance only after the complete intended `/config` layout is ready.

Then reconnect deliberately:

1. verify Control health/login;
2. verify internal Agent is online;
3. verify Repository TLS identity and workstation namespace state;
4. allow one workstation to reconnect;
5. run inventory + integrity;
6. perform a staging restore and content/hash verification.

Do not immediately run retention/destructive jobs merely because the UI starts.

## If Control DB is lost but repositories survive

Backup data is not coupled to Nexus SQLite.

Generic Restic repositories remain independently readable using repository paths/passwords/rclone config recovered from `agent-config`.

Workstation repositories are independently Restic-encrypted. Recovery requires the workstation Restic encryption password/recovery key plus Repository transport/config state or a deliberate safe transport reconstruction. Control never contained those encryption keys by design.

If SQLite is irretrievably lost, device token hashes, policies and history are lost. Rebuild/re-enroll rather than fabricating identities.

## Rollback

Keep the original emergency bundle immutable.

If recovery/migration is bad:

1. stop NexusBackup;
2. discard failed recovery state;
3. verify the emergency bundle again;
4. recreate fresh state from that bundle plus separately recovered Repository material;
5. boot the recorded appliance image;
6. investigate before trying a newer version.

Never mutate backup repository payloads merely to make Control boot.

## Acceptance criterion for this runbook

This disaster runbook is not considered proven until a disposable drill demonstrates:

- live WAL-mode export from the one appliance;
- bundle includes its full hash-verified runbook;
- off-host bundle verification;
- offline single-image archive checksum verification and disposable `docker load`;
- isolated inspection boot from disposable state;
- preserved login/device/workstation/policy/history state;
- destruction of inspection state and a second recovery from the immutable bundle;
- separately recovered/reconstructed Repository trust state as required;
- Agent/workstation reconnect;
- repository inventory/integrity;
- actual staging restore plus byte/content verification afterward.

Use disposable repositories before relying on this procedure for production recovery.
