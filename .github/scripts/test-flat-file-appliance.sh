#!/usr/bin/env bash
set -euo pipefail

image="${1:?image tag required}"
name="nexus-flat-file-smoke-$$"
config="nexus-flat-file-config-$$"
state="nexus-flat-file-state-$$"
backup="nexus-flat-file-backup-$$"
tmp="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$config" "$state" "$backup" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
for volume in "$config" "$state" "$backup"; do docker volume create "$volume" >/dev/null; done
printf 'protocol smoke\n' > "$tmp/protocol.txt"

docker run -d --name "$name" -p 18787:8787 -p 12222:2222 -p 12121:2121 -v "$config:/config" -v "$state:/state" -v "$backup:/backup" "$image" >/dev/null
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:18787/healthz >/dev/null && break; sleep 1; done
if ! curl -fsS http://127.0.0.1:18787/healthz >/dev/null; then
  docker inspect "$name" --format '{{json .State}}' >&2 || true
  docker logs "$name" >&2 || true
  exit 1
fi
setup_token="$(docker logs "$name" 2>&1 | sed -n 's/.*"setupToken":"\([^"]*\)".*/\1/p' | head -1)"
test -n "$setup_token"
curl -fsS -c "$tmp/cookies" -H 'content-type: application/json' -d "{\"setupToken\":\"$setup_token\",\"password\":\"smoke-admin-password-123\"}" http://127.0.0.1:18787/v1/local/auth/setup > "$tmp/setup.json"
csrf="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["csrfToken"])' "$tmp/setup.json")"
json_post() { curl -fsS -b "$tmp/cookies" -H "x-nexus-csrf: $csrf" -H 'content-type: application/json' -d "$2" "$1"; }
repo="$(json_post http://127.0.0.1:18787/v1/local/repositories '{"name":"alpha","relativePath":"alpha"}')"
repo_id="$(python -c 'import json,sys; print(json.load(sys.stdin)["repository"]["id"])' <<< "$repo")"
alpha="$(json_post http://127.0.0.1:18787/v1/local/receiver-users "{\"username\":\"alpha-user\",\"repositoryId\":\"$repo_id\",\"relativeSubpath\":\"\"}")"
alpha_password="$(python -c 'import json,sys; print(json.load(sys.stdin)["password"])' <<< "$alpha")"
beta_repo="$(json_post http://127.0.0.1:18787/v1/local/repositories '{"name":"beta","relativePath":"beta"}')"
beta_id="$(python -c 'import json,sys; print(json.load(sys.stdin)["repository"]["id"])' <<< "$beta_repo")"
beta="$(json_post http://127.0.0.1:18787/v1/local/receiver-users "{\"username\":\"beta-user\",\"repositoryId\":\"$beta_id\",\"relativeSubpath\":\"\"}")"
beta_password="$(python -c 'import json,sys; print(json.load(sys.stdin)["password"])' <<< "$beta")"

curl -fsS -u "alpha-user:$alpha_password" -X MKCOL http://127.0.0.1:18787/dav/alpha-user/smoke >/dev/null
curl -fsS -u "alpha-user:$alpha_password" -T "$tmp/protocol.txt" http://127.0.0.1:18787/dav/alpha-user/smoke/protocol.txt >/dev/null
curl -fsS -u "alpha-user:$alpha_password" http://127.0.0.1:18787/dav/alpha-user/smoke/protocol.txt | grep -F 'protocol smoke'
if curl -fsS -u "alpha-user:$alpha_password" http://127.0.0.1:18787/dav/other-user/smoke/protocol.txt >/dev/null 2>&1; then echo 'receiver URL namespace crossed a receiver root' >&2; exit 1; fi
curl -fsS -u "beta-user:$beta_password" -T "$tmp/protocol.txt" http://127.0.0.1:18787/dav/beta-user/beta-only.txt >/dev/null
if curl -fsS -u "alpha-user:$alpha_password" http://127.0.0.1:18787/dav/beta-user/beta-only.txt >/dev/null 2>&1; then echo 'receiver A accessed receiver B data' >&2; exit 1; fi

curl --fail --silent --show-error --user "alpha-user:$alpha_password" --insecure --upload-file "$tmp/protocol.txt" sftp://127.0.0.1:12222/native-sftp.txt >/dev/null
curl --fail --silent --show-error --user "alpha-user:$alpha_password" --insecure sftp://127.0.0.1:12222/native-sftp.txt | grep -F 'protocol smoke'
curl --fail --silent --show-error --user "alpha-user:$alpha_password" --upload-file "$tmp/protocol.txt" ftp://127.0.0.1:12121/native-ftp.txt >/dev/null
curl --fail --silent --show-error --user "alpha-user:$alpha_password" ftp://127.0.0.1:12121/native-ftp.txt | grep -F 'protocol smoke'

if docker exec "$name" sh -ec 'ps 2>/dev/null | grep -E "restic|rest-server|agent" | grep -v grep'; then echo 'retired process found in appliance' >&2; exit 1; fi
receiver_pid="$(docker exec "$name" sh -ec 'pidof sftpgo')"
docker exec "$name" kill -TERM "$receiver_pid"
for _ in $(seq 1 20); do [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = false ] && exit 0; sleep 1; done
echo 'appliance did not fail after SFTPGo stopped' >&2
exit 1
