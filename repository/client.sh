#!/bin/sh
set -eu

umask 077
CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config}
SETTINGS_BIN=${NEXUS_BACKUP_REPOSITORY_SETTINGS_BIN:-/usr/local/bin/nexus-repository-settings}
HTPASSWD="$CONFIG_DIR/.htpasswd"
CLIENTS_DIR="$CONFIG_DIR/clients"
TLS_CERT="$CONFIG_DIR/repository-tls.crt"

usage() {
  echo "Usage: nexus-repository-client <username> [repository-name] [--rotate]" >&2
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 3 ] || usage
USER_NAME=$1
REPO_NAME=${2:-main}
ROTATE=${3:-}
[ -z "$ROTATE" ] || [ "$ROTATE" = "--rotate" ] || usage

HOST=$("$SETTINGS_BIN" get host 2>/dev/null || true)
LISTEN_PORT=$("$SETTINGS_BIN" get listen-port 2>/dev/null || echo 8000)
PORT=$("$SETTINGS_BIN" get endpoint-port 2>/dev/null || echo "$LISTEN_PORT")
EXPOSURE=$("$SETTINGS_BIN" get exposure 2>/dev/null || echo lan)
APPEND_ONLY=$("$SETTINGS_BIN" get append-only 2>/dev/null || { [ "$EXPOSURE" = internet ] && echo true || echo false; })

if [ "$EXPOSURE" = "lan" ]; then
  echo "Nexus Backup Home mode configures workstation repositories automatically; no Repository credentials or CA are required."
  exit 0
fi

[ -n "$HOST" ] || { echo "Repository endpoint host is not configured" >&2; exit 1; }
[ -s "$TLS_CERT" ] || { echo "repository CA certificate is not ready" >&2; exit 1; }

case "$USER_NAME" in
  ''|*[!A-Za-z0-9._-]*) echo "username must use only letters, numbers, dot, underscore or hyphen" >&2; exit 1 ;;
esac
case "$REPO_NAME" in
  ''|*[!A-Za-z0-9._-]*) echo "repository-name must use only letters, numbers, dot, underscore or hyphen" >&2; exit 1 ;;
esac
[ "${#USER_NAME}" -le 64 ] || { echo "username is too long" >&2; exit 1; }
[ "${#REPO_NAME}" -le 64 ] || { echo "repository-name is too long" >&2; exit 1; }

mkdir -p "$CLIENTS_DIR"
chmod 0700 "$CONFIG_DIR" "$CLIENTS_DIR"
[ -f "$HTPASSWD" ] || : > "$HTPASSWD"
chmod 0600 "$HTPASSWD"
PASSWORD_FILE="$CLIENTS_DIR/$USER_NAME.password"

if [ ! -s "$PASSWORD_FILE" ] || [ "$ROTATE" = "--rotate" ]; then
  PASSWORD=$(openssl rand -hex 24)
  printf '%s\n' "$PASSWORD" > "$PASSWORD_FILE"
  chmod 0600 "$PASSWORD_FILE"
  htpasswd -B -b "$HTPASSWD" "$USER_NAME" "$PASSWORD" >/dev/null
else
  PASSWORD=$(cat "$PASSWORD_FILE")
  # Re-assert the bcrypt entry in case the htpasswd file was restored separately.
  htpasswd -B -b "$HTPASSWD" "$USER_NAME" "$PASSWORD" >/dev/null
fi

[ "${NEXUS_REPOSITORY_QUIET:-0}" = "1" ] && exit 0

REPOSITORY="rest:https://$HOST:$PORT/$USER_NAME/$REPO_NAME"
CA_SHA256=$(sha256sum "$TLS_CERT" | awk '{print $1}')
CA_B64=$(openssl base64 -A -in "$TLS_CERT")
cat <<EOF
# Nexus Backup Repository endpoint: $EXPOSURE · append-only=$APPEND_ONLY
# Paste these lines into an elevated PowerShell on the workstation before running its Nexus install command.
# The public CA is carried out-of-band in this local helper output; Repository exposes no HTTP bootstrap port.
# Transport credentials remain local to Repository + workstation and are never sent to Nexus Control.
\$env:NEXUS_BACKUP_REPOSITORY='$REPOSITORY'
\$env:NEXUS_BACKUP_REST_USERNAME='$USER_NAME'
\$env:NEXUS_BACKUP_REST_PASSWORD='$PASSWORD'
\$env:NEXUS_BACKUP_REPOSITORY_CA_B64='$CA_B64'
\$env:NEXUS_BACKUP_REPOSITORY_CA_SHA256='$CA_SHA256'
# Also set NEXUS_BACKUP_RESTIC_PASSWORD to the workstation's Restic encryption password before first install.
EOF
