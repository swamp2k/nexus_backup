# Emergency recovery: recover Nexus Backup without Nexus Backup

This runbook covers loss of the Nexus Backup application/container while backup repositories and/or persistent Docker volumes still exist. It deliberately does **not** require Cloudflare, a remote control plane, PCWatch, or a running Nexus agent.

The goal is to recover control-plane identity and local storage configuration safely enough to inspect the system before any backup/restore/transfer worker is allowed to resume.

## What must exist outside Nexus

Keep at least one recent emergency bundle **off the Nexus host** and encrypted. The bundle contains secrets and is equivalent to privileged backup-system access.

An emergency bundle contains:

- a consistent SQLite snapshot of `/config/nexus-backup.sqlite`
- `/config/control-token`
- `/config/agent-token`
- `/config/auth.json` when local admin setup has been completed
- `/config/setup-token` only when setup is still pending
- the complete local agent configuration tree (`agent.json`, Restic password files, rclone configuration and other local storage credentials)
- `manifest.json` with Nexus version/revision, applied migrations, size and SHA-256 for every bundled file
- `RECOVERY.txt`

It intentionally does **not** contain backup repository payloads, source data, restore staging data, runtime token mirrors, disposable agent caches/state, or workstation-local repository URLs/passwords. Workstation repository credentials remain on the Windows workstation by design.

The emergency bundle is therefore the backup of **Nexus itself**, not a second copy of the protected data.

## Create a bundle while Nexus is healthy

From the directory containing `compose.yaml`:

```sh
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec control node apps/local-server/bin/emergency-export.mjs "/tmp/nexus-backup-emergency-$STAMP"
docker compose cp "control:/tmp/nexus-backup-emergency-$STAMP" "./nexus-backup-emergency-$STAMP"
docker compose exec control rm -rf "/tmp/nexus-backup-emergency-$STAMP"
```

The exporter runs SQLite `quick_check`, takes a consistent snapshot with `VACUUM INTO`, verifies the snapshot with `integrity_check`, copies the control identity and agent-config secrets, rejects symlinks, and writes a SHA-256 manifest. It never copies repository payload data.

Verify the copied bundle **before** moving it off-host. Prefer the same/pinned control image recorded for the deployment:

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup-control:<tag>"
docker run --rm \
  -v "$PWD/nexus-backup-emergency-$STAMP:/bundle:ro" \
  --entrypoint node \
  "$IMAGE" \
  apps/local-server/bin/emergency-export.mjs --verify /bundle
```

A successful verification prints JSON with `"ok": true`. Then move the bundle to encrypted storage that is not dependent on the Nexus host.

Create a new verified bundle after device/workstation enrollment or credential rotation, after repository/rclone credential or agent-config changes, before and after Nexus upgrades/migrations, after meaningful policy changes, and periodically even when configuration appears unchanged.

Never keep the only emergency bundle inside the same Docker volume, Unraid appdata share, or physical host that it is meant to recover.

## Export after the normal stack has stopped but Docker volumes survive

Identify the actual volume names first; do not guess them:

```sh
docker volume ls | grep -i nexus
```

With the normal stack stopped, a one-shot control image can read the surviving volumes and write a bundle directly to a host directory:

```sh
CONTROL_VOL="<actual-control-config-volume>"
AGENT_VOL="<actual-agent-config-volume>"
IMAGE="ghcr.io/swamp2k/nexus-backup-control:<known-good-tag>"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$PWD/emergency-export"

docker run --rm \
  -v "$CONTROL_VOL:/config" \
  -v "$AGENT_VOL:/agent-config:ro" \
  -v "$PWD/emergency-export:/export" \
  --entrypoint node \
  "$IMAGE" \
  apps/local-server/bin/emergency-export.mjs "/export/nexus-backup-emergency-$STAMP"
```

The control volume is mounted read/write because SQLite may need normal filesystem access while opening a WAL-mode database. Keep the normal Nexus stack stopped during this one-shot export. Verify the result before using it for recovery.

## Disaster restore: safe sequence

### 1. Freeze execution

Stop the normal Nexus control and generic-agent containers. Prevent workstation agents from reaching the normal Nexus endpoint while recovering it.

If the original persistent volumes still exist, do not modify or delete them. They remain evidence and a rollback source.

### 2. Verify the emergency bundle

Before copying anything:

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup-control:<bundle-version-or-known-good-tag>"
docker run --rm \
  -v "/path/to/emergency-bundle:/bundle:ro" \
  --entrypoint node \
  "$IMAGE" \
  apps/local-server/bin/emergency-export.mjs --verify /bundle
```

Do not continue if SHA-256 inventory or SQLite integrity verification fails.

Read `manifest.json` and note `nexusBackup.version`, `nexusBackup.revision`, and the final entry in `database.migrations`. Prefer the matching image version for first boot. Starting a newer image may apply forward-only migrations and adds unnecessary variables during disaster recovery.

### 3. Create **disposable inspection volumes**

The first recovered boot is only for inspection. Never promote these inspection volumes to production afterward.

```sh
docker volume create nexus-inspect-control-config
docker volume create nexus-inspect-agent-config
```

Copy the verified bundle into them:

```sh
docker run --rm \
  -v "/path/to/emergency-bundle/control:/from:ro" \
  -v nexus-inspect-control-config:/to \
  alpine:3.22 sh -eu -c 'cp -a /from/. /to/'

docker run --rm \
  -v "/path/to/emergency-bundle/agent-config:/from:ro" \
  -v nexus-inspect-agent-config:/to \
  alpine:3.22 sh -eu -c 'cp -a /from/. /to/'
```

### 4. Isolated first boot: control only, alternate port

Do **not** start the normal Compose stack. Start only the recovered control container on a different host port:

```sh
IMAGE="ghcr.io/swamp2k/nexus-backup-control:<bundle-version-or-known-good-tag>"

docker run --rm --name nexus-recovery-control \
  -p 127.0.0.1:18787:8787 \
  -v nexus-inspect-control-config:/config \
  -v nexus-inspect-agent-config:/agent-config:ro \
  "$IMAGE"
```

Binding to `127.0.0.1` prevents remote workstation agents from reaching this temporary controller. If inspection must happen from another trusted machine, use an SSH tunnel rather than exposing the recovery port broadly.

Inspect:

- `/healthz`
- local admin login
- workstation/device inventory
- backup policies and schedules
- job history and last successful snapshots
- repository definitions shown by the UI
- expected Nexus version/revision and database migration state

The gateway's normal schedulers are intentionally not given a special disaster mode. They may update scheduler/job state inside these **disposable inspection volumes** even though no workers are connected. That is why these volumes must never become the recovered production state.

If the matching image cannot boot or the state is not what the manifest/bundle should contain, stop here and investigate from the unchanged bundle.

### 5. Throw away the inspection state

After inspection succeeds, stop the temporary control container and delete the inspection volumes:

```sh
docker rm -f nexus-recovery-control 2>/dev/null || true
docker volume rm nexus-inspect-control-config nexus-inspect-agent-config
```

The verified emergency bundle remains unchanged and is still the recovery source of truth.

### 6. Restore **fresh production volumes** from the bundle

Create new production/recovery volumes; do not reuse the inspection volumes:

```sh
docker volume create nexus-recovery-control-config
docker volume create nexus-recovery-agent-config
```

Copy the bundle roots again from the immutable verified bundle:

```sh
docker run --rm \
  -v "/path/to/emergency-bundle/control:/from:ro" \
  -v nexus-recovery-control-config:/to \
  alpine:3.22 sh -eu -c 'cp -a /from/. /to/'

docker run --rm \
  -v "/path/to/emergency-bundle/agent-config:/from:ro" \
  -v nexus-recovery-agent-config:/to \
  alpine:3.22 sh -eu -c 'cp -a /from/. /to/'
```

`runtime` and `agent-state` may be recreated empty. The runtime agent-token mirror is derived from restored `/config/agent-token` at control startup.

Wire these fresh volumes into the normal deployment. Start **control first** and verify health/login on the normal endpoint before allowing any worker to reconnect.

Then reconnect deliberately:

1. start the generic agent
2. allow workstations to reconnect
3. confirm expected online identities
4. run repository inventory
5. run repository integrity checks
6. perform a staging restore before considering the recovery proven

Do not immediately queue retention/destructive work merely because the controller starts.

## If the controller database is lost but repositories survive

Backup data is not coupled to Nexus SQLite. Restic repositories remain independently readable with their repository location and password.

For generic-agent repositories, recover repository URL/path, Restic password file and any rclone configuration from the emergency bundle's `agent-config/` tree. Use Restic directly from a trusted host/container to inspect snapshots or restore data.

For workstation repositories, the repository location/password remain on that workstation. Nexus never had those secrets to recover. If the workstation survives, its local Nexus configuration plus Restic can be used independently of the controller.

If the Nexus SQLite database is irretrievably lost, enrolled device token hashes, policies and job history are also lost. Rebuild the controller and re-enroll/repair workstations rather than fabricating old device identities.

## Rollback

Keep the original verified emergency bundle immutable.

If a recovered controller or migration is bad:

1. stop all Nexus workers/control containers
2. discard the failed recovery volumes
3. verify the emergency bundle again
4. create fresh volumes from that same bundle
5. boot the image version recorded in `manifest.json`
6. investigate before attempting a newer version again

A recovery attempt must never modify backup repository payloads merely to make the controller boot.

## Acceptance criterion for this runbook

This runbook is not considered proven until a disposable exercise demonstrates all of the following:

- export from a live WAL-mode controller
- off-host bundle verification
- replacement/loss of the original control deployment in the test environment
- isolated control-only boot from disposable inspection volumes
- preserved login, device/workstation state, policies and history
- destruction of inspection volumes and a second restore from the same immutable bundle
- generic-agent reconnect using restored credentials
- workstation reconnect using restored controller token hashes
- repository inventory/integrity after recovery
- an actual staging restore still succeeds afterward

Use disposable/test repositories for this exercise before relying on the procedure for production recovery.
