#!/usr/bin/env bash
set -euo pipefail

IMAGE=${1:-nexus-backup:ci}
NAME=nexus-backup-internet-ci
HOST_PORT=18443
CONFIG_VOLUME=nexus-internet-config-ci
STATE_VOLUME=nexus-internet-state-ci
BACKUP_VOLUME=nexus-internet-backup-ci
TMP_DIR=$(mktemp -d)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$CONFIG_VOLUME" "$STATE_VOLUME" "$BACKUP_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
  rm -f /tmp/nexus-internet-forget.out /tmp/nexus-internet-forget.err
}
trap cleanup EXIT

for volume in "$CONFIG_VOLUME" "$STATE_VOLUME" "$BACKUP_VOLUME"; do
  docker volume create "$volume" >/dev/null
done

mkdir -p "$TMP_DIR/source"
printf 'Nexus Internet Repository integration\n' > "$TMP_DIR/source/proof.txt"
printf '%s\n' 'internet-ci-restic-encryption-password' > "$TMP_DIR/restic-password"

docker run -d --name "$NAME" \
  -e NEXUS_BACKUP_REPOSITORY_EXPOSURE=internet \
  -e NEXUS_BACKUP_REPOSITORY_HOST=127.0.0.1 \
  -e NEXUS_BACKUP_REPOSITORY_PORT=8000 \
  -e NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT="$HOST_PORT" \
  -e NEXUS_BACKUP_REPOSITORY_INITIAL_USER=internet-ci \
  -p 18887:8787 \
  -p "$HOST_PORT":8000 \
  -v "$CONFIG_VOLUME":/config \
  -v "$STATE_VOLUME":/state \
  -v "$BACKUP_VOLUME":/backup \
  "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  control=0; repository=0; agent=0
  curl -fsS -o /dev/null http://127.0.0.1:18887/healthz && control=1 || true
  curl -ksS -o /dev/null "https://127.0.0.1:$HOST_PORT/" && repository=1 || true
  docker logs "$NAME" 2>&1 | grep -Fq '"message":"agent online"' && agent=1 || true
  if [ "$control" = 1 ] && [ "$repository" = 1 ] && [ "$agent" = 1 ]; then ready=1; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" != true ]; then break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  docker inspect "$NAME" --format '{{json .State}}' >&2 || true
  docker logs "$NAME" >&2 || true
  exit 1
fi

settings=$(docker exec "$NAME" nexus-repository-settings show)
grep -Eq 'Exposure:[[:space:]]+internet' <<<"$settings"
grep -Eq 'Listen port:[[:space:]]+8000' <<<"$settings"
grep -Eq "Endpoint port:[[:space:]]+$HOST_PORT" <<<"$settings"
grep -Eq 'Append-only:[[:space:]]+true' <<<"$settings"

active=$(docker exec "$NAME" cat /run/nexus-backup/repository-active.json)
node -e '
  const active=JSON.parse(process.argv[1]);
  if(active.exposure!=="internet"||active.host!=="127.0.0.1"||active.listenPort!==8000||active.endpointPort!==18443||active.appendOnly!==true){
    throw new Error(`unexpected active Repository settings: ${process.argv[1]}`)
  }
' "$active"

helper=$(docker exec "$NAME" nexus-repository-client internet-ci main)
repository=$(sed -n "s/.*NEXUS_BACKUP_REPOSITORY='\([^']*\)'.*/\1/p" <<<"$helper")
ca_b64=$(sed -n "s/.*NEXUS_BACKUP_REPOSITORY_CA_B64='\([^']*\)'.*/\1/p" <<<"$helper")
ca_sha=$(sed -n "s/.*NEXUS_BACKUP_REPOSITORY_CA_SHA256='\([^']*\)'.*/\1/p" <<<"$helper")
transport_password=$(docker exec "$NAME" cat /config/repository/clients/internet-ci.password)

test "$repository" = "rest:https://127.0.0.1:$HOST_PORT/internet-ci/main"
test -n "$ca_b64" && test -n "$ca_sha" && test -n "$transport_password"
printf '%s' "$ca_b64" | base64 -d > "$TMP_DIR/repository-ca.pem"
test "$(sha256sum "$TMP_DIR/repository-ca.pem" | awk '{print $1}')" = "$ca_sha"

restic_run() {
  docker run --rm --network host --entrypoint restic \
    -e RESTIC_REPOSITORY="$repository" \
    -e RESTIC_REST_USERNAME=internet-ci \
    -e RESTIC_REST_PASSWORD="$transport_password" \
    -e RESTIC_PASSWORD_FILE=/secrets/restic-password \
    -e RESTIC_CACERT=/secrets/repository-ca.pem \
    -v "$TMP_DIR/restic-password":/secrets/restic-password:ro \
    -v "$TMP_DIR/repository-ca.pem":/secrets/repository-ca.pem:ro \
    -v "$TMP_DIR/source":/source:ro \
    "$IMAGE" "$@"
}

restic_run init >/dev/null
restic_run backup /source --tag internet-ci >/dev/null
snapshot_id=$(restic_run snapshots --json | node -e '
  let data=""; process.stdin.on("data",c=>data+=c); process.stdin.on("end",()=>{
    const rows=JSON.parse(data); if(!Array.isArray(rows)||rows.length!==1) process.exit(2); process.stdout.write(rows[0].id);
  });
')
test -n "$snapshot_id"

# Restic 0.18.x may return zero even when the backend refuses the object DELETE,
# so prove server enforcement from both the 403 response and snapshot persistence.
set +e
restic_run forget "$snapshot_id" >/tmp/nexus-internet-forget.out 2>/tmp/nexus-internet-forget.err
forget_status=$?
set -e
if ! grep -Eq '403 Forbidden|unexpected HTTP response \(403\)' /tmp/nexus-internet-forget.err; then
  echo "Internet Repository append-only test did not observe the expected 403 refusal (restic exit=$forget_status)" >&2
  cat /tmp/nexus-internet-forget.out >&2 || true
  cat /tmp/nexus-internet-forget.err >&2 || true
  exit 1
fi

# Existing backup must still be present/readable after the refused destructive operation.
restic_run cat config >/dev/null
snapshots_after=$(restic_run snapshots --json)
grep -Fq "$snapshot_id" <<<"$snapshots_after" || {
  echo "append-only refusal did not preserve the snapshot" >&2
  exit 1
}

echo "direct Internet Repository integration passed: TLS/auth backup works; delete received 403 and snapshot persisted"
