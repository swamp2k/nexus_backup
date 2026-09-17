#!/bin/sh
set -eu

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

CONTROL_CONFIG_DIR=${NEXUS_BACKUP_CONFIG_DIR:-/config/control}
INTEGRATION_CONFIG=${NEXUS_BACKUP_INTEGRATION_CONFIG:-/config/integrations.json}

mkdir -p "$CONTROL_CONFIG_DIR" "$(dirname "$INTEGRATION_CONFIG")" \
  /state/mounts /state/rclone-vfs /data /backup /restore /downloads

# Compatibility integrations are read from this file while existing
# installations migrate. They are not a separate appliance process.
if [ ! -f "$INTEGRATION_CONFIG" ]; then
  cp /app/defaults/integrations.json "$INTEGRATION_CONFIG"
  log "Nexus Backup: created compatibility integration configuration"
fi

export NEXUS_BACKUP_CONFIG_DIR="$CONTROL_CONFIG_DIR"
export NEXUS_BACKUP_INTEGRATION_CONFIG="$INTEGRATION_CONFIG"
export NEXUS_BACKUP_HOST=${NEXUS_BACKUP_HOST:-0.0.0.0}
export NEXUS_BACKUP_PORT=${NEXUS_BACKUP_PORT:-8787}
export NEXUS_BACKUP_INTERNAL_PORT=${NEXUS_BACKUP_INTERNAL_PORT:-8788}
export NEXUS_BACKUP_URL=${NEXUS_BACKUP_URL:-http://127.0.0.1:8787}
export NEXUS_BACKUP_BACKUP_ROOT=${NEXUS_BACKUP_BACKUP_ROOT:-/backup}
export SFTPGO_SFTPD__BINDINGS__0__PORT=${NEXUS_BACKUP_SFTP_PORT:-2222}
export SFTPGO_FTPD__BINDINGS__0__PORT=${NEXUS_BACKUP_FTP_PORT:-2121}
passive_ports=${NEXUS_BACKUP_FTP_PASSIVE_PORTS:-50000-50010}
case "$passive_ports" in
  *-*) export SFTPGO_FTPD__PASSIVE_PORT_RANGE__START=${passive_ports%-*} SFTPGO_FTPD__PASSIVE_PORT_RANGE__END=${passive_ports#*-} ;;
esac

if command -v sftpgo >/dev/null 2>&1; then
  log "Nexus Backup: starting SFTP/FTP receiver engine"
  sftpgo serve >/dev/stdout 2>/dev/stderr &
  receiver_pid=$!
else
  receiver_pid=
  log "Nexus Backup: receiver engine is unavailable"
fi

log "Nexus Backup: starting single application runtime"
node /app/apps/local-server/bin/gateway.mjs &
app_pid=$!

stop_all() {
  status=$?
  trap - EXIT INT TERM
  [ -z "${app_pid:-}" ] || kill -TERM "$app_pid" 2>/dev/null || true
  [ -z "${receiver_pid:-}" ] || kill -TERM "$receiver_pid" 2>/dev/null || true
  [ -z "${app_pid:-}" ] || wait "$app_pid" 2>/dev/null || true
  [ -z "${receiver_pid:-}" ] || wait "$receiver_pid" 2>/dev/null || true
  exit "$status"
}
trap stop_all EXIT INT TERM

wait "$app_pid"
