#!/bin/sh
set -eu

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

fail() {
  log "Nexus Backup appliance: $*" >&2
  exit 1
}

CONTROL_CONFIG_DIR=${NEXUS_BACKUP_CONFIG_DIR:-/config/control}
AGENT_CONFIG=${NEXUS_BACKUP_CONFIG:-/config/agent/agent.json}
REPOSITORY_CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config/repository}
REPOSITORY_DATA_DIR=${NEXUS_BACKUP_REPOSITORY_DATA_DIR:-/backup/workstations}
RUNTIME_DIR=${NEXUS_BACKUP_RUNTIME_DIR:-/run/nexus-backup}
TOKEN_FILE=${NEXUS_BACKUP_AGENT_TOKEN_FILE:-$RUNTIME_DIR/agent-token}

mkdir -p \
  "$CONTROL_CONFIG_DIR" \
  "$(dirname "$AGENT_CONFIG")" \
  "$REPOSITORY_CONFIG_DIR" \
  "$REPOSITORY_DATA_DIR" \
  "$RUNTIME_DIR" \
  /state/mounts /state/rclone-vfs /state/restic-cache \
  /data /backup/generic /restore /downloads

if [ ! -f "$AGENT_CONFIG" ]; then
  cp /app/defaults/agent.json "$AGENT_CONFIG"
  log "Nexus Backup appliance: created inert Agent config at $AGENT_CONFIG"
fi

export NEXUS_BACKUP_CONFIG_DIR="$CONTROL_CONFIG_DIR"
export NEXUS_BACKUP_RUNTIME_DIR="$RUNTIME_DIR"
export NEXUS_BACKUP_AGENT_CONFIG="$AGENT_CONFIG"
export NEXUS_BACKUP_HOST=${NEXUS_BACKUP_HOST:-0.0.0.0}
export NEXUS_BACKUP_PORT=${NEXUS_BACKUP_PORT:-8787}
export NEXUS_BACKUP_INTERNAL_PORT=${NEXUS_BACKUP_INTERNAL_PORT:-8788}
export NEXUS_BACKUP_AGENT_ID=${NEXUS_BACKUP_AGENT_ID:-local-agent}
export NEXUS_BACKUP_URL=${NEXUS_BACKUP_URL:-http://127.0.0.1:8787}
export NEXUS_BACKUP_AGENT_TOKEN_FILE="$TOKEN_FILE"
export NEXUS_BACKUP_CONFIG="$AGENT_CONFIG"
export NEXUS_BACKUP_REPOSITORY_CONFIG_DIR="$REPOSITORY_CONFIG_DIR"
export NEXUS_BACKUP_REPOSITORY_DATA_DIR="$REPOSITORY_DATA_DIR"

CONTROL_PID=''
AGENT_PID=''
REPOSITORY_PID=''
STOPPING=0

stop_all() {
  [ "$STOPPING" -eq 0 ] || return 0
  STOPPING=1
  log "Nexus Backup appliance: stopping services"
  for pid in "$AGENT_PID" "$REPOSITORY_PID" "$CONTROL_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  deadline=$(( $(date +%s) + 15 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    alive=0
    for pid in "$AGENT_PID" "$REPOSITORY_PID" "$CONTROL_PID"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 1 ] || break
    sleep 1
  done
  for pid in "$AGENT_PID" "$REPOSITORY_PID" "$CONTROL_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
  done
}

trap 'stop_all; exit 143' TERM
trap 'stop_all; exit 130' INT
trap 'stop_all' EXIT

log "Nexus Backup appliance: starting Control"
node /app/apps/local-server/bin/gateway.mjs &
CONTROL_PID=$!

log "Nexus Backup appliance: starting Repository"
/usr/local/bin/nexus-repository-entrypoint &
REPOSITORY_PID=$!

log "Nexus Backup appliance: waiting for Control agent token"
ready=0
for _ in $(seq 1 60); do
  if [ -s "$TOKEN_FILE" ]; then
    ready=1
    break
  fi
  if ! kill -0 "$CONTROL_PID" 2>/dev/null; then
    wait "$CONTROL_PID" || true
    fail "Control exited before creating the local Agent token"
  fi
  if ! kill -0 "$REPOSITORY_PID" 2>/dev/null; then
    wait "$REPOSITORY_PID" || true
    fail "Repository exited during appliance startup"
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "timed out waiting for Control agent token"

log "Nexus Backup appliance: starting Agent"
node /app/apps/agent/bin/agent.mjs &
AGENT_PID=$!

log "Nexus Backup appliance: Control, Agent and Repository are running"
while :; do
  for item in "Control:$CONTROL_PID" "Agent:$AGENT_PID" "Repository:$REPOSITORY_PID"; do
    name=${item%%:*}
    pid=${item#*:}
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || rc=$?
      rc=${rc:-0}
      log "Nexus Backup appliance: $name exited (status $rc); stopping appliance" >&2
      stop_all
      exit "$rc"
    fi
  done
  sleep 2
done
