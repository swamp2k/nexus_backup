#!/usr/bin/env bash
set -euo pipefail

image="${1:-nexus-backup:ci}"
container="nexus-backup-home-ci"
config_volume="nexus-home-config-ci"
state_volume="nexus-home-state-ci"
backup_volume="nexus-home-backup-ci"
source_dir="/tmp/nexus-home-source"
restore_dir="/tmp/nexus-home-restore"
control_port=18788
repository_port=18001

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$config_volume" "$state_volume" "$backup_volume" >/dev/null 2>&1 || true
  rm -rf "$source_dir" "$restore_dir"
}
trap cleanup EXIT
cleanup

for volume in "$config_volume" "$state_volume" "$backup_volume"; do
  docker volume create "$volume" >/dev/null
done

docker run -d --name "$container" \
  -p "$control_port:8787" \
  -p "$repository_port:8000" \
  -v "$config_volume:/config" \
  -v "$state_volume:/state" \
  -v "$backup_volume:/backup" \
  "$image" >/dev/null

ready=0
for _ in $(seq 1 60); do
  control=0; repository=0; agent=0
  curl --max-time 2 -fsS -o /dev/null "http://127.0.0.1:$control_port/healthz" && control=1 || true
  # rest-server intentionally answers GET / with 405. A completed HTTP response
  # still proves that the Home Repository listener is alive.
  curl --max-time 2 -sS -o /dev/null "http://127.0.0.1:$repository_port/" && repository=1 || true
  docker logs "$container" 2>&1 | grep -Fq '"message":"agent online"' && agent=1 || true
  if [ "$control" = 1 ] && [ "$repository" = 1 ] && [ "$agent" = 1 ]; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
    break
  fi
  sleep 1
done

if [ "$ready" != 1 ]; then
  docker inspect "$container" --format '{{json .State}}' >&2 || true
  docker logs "$container" >&2 || true
  exit 1
fi

# Home mode is intentionally plain HTTP/no Repository authentication. The LAN
# and Unraid host are the trust boundary; Restic still supplies snapshots,
# deduplication, compression and integrity checking.
if ! curl --max-time 3 -sS "http://127.0.0.1:$repository_port/" >/dev/null; then
  echo 'Home Repository HTTP listener is not reachable' >&2
  exit 1
fi
# A TLS handshake against a plain-HTTP server can otherwise wait for curl's
# long default timeout, so keep this negative protocol assertion tightly bounded.
if curl --connect-timeout 1 --max-time 3 -kfsS "https://127.0.0.1:$repository_port/" >/dev/null 2>&1; then
  echo 'Home Repository unexpectedly enabled TLS' >&2
  exit 1
fi

mkdir -p "$source_dir" "$restore_dir"
printf 'home-mode-ci\n' > "$source_dir/probe.txt"
repo="rest:http://127.0.0.1:$repository_port/workstation-ci-home"

# Keep invocation explicit rather than relying on ambient RESTIC_PASSWORD*.
docker run --rm --network host --entrypoint restic \
  -e RESTIC_REPOSITORY="$repo" \
  "$image" --insecure-no-password init >/dev/null

docker run --rm --network host --entrypoint restic \
  -e RESTIC_REPOSITORY="$repo" \
  -v "$source_dir:/source:ro" \
  "$image" --insecure-no-password backup /source >/dev/null

docker run --rm --network host --entrypoint restic \
  -e RESTIC_REPOSITORY="$repo" \
  "$image" --insecure-no-password check >/dev/null

docker run --rm --network host --entrypoint restic \
  -e RESTIC_REPOSITORY="$repo" \
  -v "$restore_dir:/restore" \
  "$image" --insecure-no-password restore latest --target /restore >/dev/null

grep -Fqx 'home-mode-ci' "$restore_dir/source/probe.txt"

# Home mode must not generate transport credentials/TLS material merely by
# starting the appliance.
if docker exec "$container" sh -ec 'test -s /config/repository/.htpasswd || test -s /config/repository/repository-tls.key'; then
  echo 'Home Repository created remote-mode credential/TLS material' >&2
  exit 1
fi

docker exec "$container" sh -ec 'pid="$(pidof rest-server)"; test -n "$pid"; kill "$pid"'
stopped=0
for _ in $(seq 1 20); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
    stopped=1
    break
  fi
  sleep 1
done
[ "$stopped" = 1 ] || {
  echo 'appliance stayed alive after Repository process died' >&2
  docker logs "$container" >&2
  exit 1
}
