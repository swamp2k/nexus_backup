#!/bin/sh
set -eu

umask 077

CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config}
DATA_DIR=${NEXUS_BACKUP_REPOSITORY_DATA_DIR:-/data}
RUNTIME_DIR=${NEXUS_BACKUP_RUNTIME_DIR:-/run/nexus-backup}
INITIAL_USER=${NEXUS_BACKUP_REPOSITORY_INITIAL_USER:-}
SETTINGS_BIN=${NEXUS_BACKUP_REPOSITORY_SETTINGS_BIN:-/usr/local/bin/nexus-repository-settings}

fail() {
  echo "Nexus Backup Repository: $*" >&2
  exit 1
}

mkdir -p "$CONFIG_DIR/clients" "$CONFIG_DIR/settings" "$DATA_DIR" "$RUNTIME_DIR"
chmod 0700 "$CONFIG_DIR" "$CONFIG_DIR/clients" "$CONFIG_DIR/settings" "$RUNTIME_DIR"

seed_setting() {
  key=$1
  value=$2
  file="$CONFIG_DIR/settings/$key"
  if [ ! -s "$file" ] && [ -n "$value" ]; then
    "$SETTINGS_BIN" set "$key" "$value" >/dev/null
  fi
}

EXPOSURE_ENV=${NEXUS_BACKUP_REPOSITORY_EXPOSURE:-lan}
HOST_ENV=${NEXUS_BACKUP_REPOSITORY_HOST:-}
LISTEN_PORT_ENV=${NEXUS_BACKUP_REPOSITORY_PORT:-8000}
ENDPOINT_PORT_ENV=${NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT:-$LISTEN_PORT_ENV}
APPEND_ONLY_ENV=${NEXUS_BACKUP_REPOSITORY_APPEND_ONLY:-}

seed_setting exposure "$EXPOSURE_ENV"
seed_setting host "$HOST_ENV"
seed_setting listen-port "$LISTEN_PORT_ENV"
seed_setting endpoint-port "$ENDPOINT_PORT_ENV"
if [ -n "$APPEND_ONLY_ENV" ]; then
  seed_setting append-only "$APPEND_ONLY_ENV"
fi

EXPOSURE=$("$SETTINGS_BIN" get exposure 2>/dev/null || echo lan)
HOST=$("$SETTINGS_BIN" get host 2>/dev/null || true)
PORT=$("$SETTINGS_BIN" get listen-port 2>/dev/null || echo 8000)
ENDPOINT_PORT=$("$SETTINGS_BIN" get endpoint-port 2>/dev/null || echo "$PORT")
if APPEND_ONLY=$("$SETTINGS_BIN" get append-only 2>/dev/null); then
  :
elif [ "$EXPOSURE" = "internet" ]; then
  APPEND_ONLY=true
  "$SETTINGS_BIN" set append-only true >/dev/null
else
  APPEND_ONLY=false
  "$SETTINGS_BIN" set append-only false >/dev/null
fi

ACTIVE_JSON="$RUNTIME_DIR/repository-active.json"
HTPASSWD="$CONFIG_DIR/.htpasswd"
TLS_KEY="$CONFIG_DIR/repository-tls.key"
TLS_CERT="$CONFIG_DIR/repository-tls.crt"
TLS_HOST="$CONFIG_DIR/repository-tls.host"

set -- \
  --path "$DATA_DIR" \
  --listen ":$PORT" \
  --log -

if [ "$EXPOSURE" = "internet" ]; then
  [ -n "$HOST" ] || fail "Internet Repository mode requires an endpoint hostname or IPv4 address"

  if [ ! -f "$HTPASSWD" ]; then
    : > "$HTPASSWD"
    chmod 0600 "$HTPASSWD"
  fi

  current_host=''
  if [ -f "$TLS_HOST" ]; then current_host=$(cat "$TLS_HOST" 2>/dev/null || true); fi
  if [ ! -s "$TLS_KEY" ] || [ ! -s "$TLS_CERT" ] || [ "$current_host" != "$HOST" ]; then
    case "$HOST" in
      *[!0-9.]*) SAN="DNS:$HOST" ;;
      *) SAN="IP:$HOST" ;;
    esac
    tmp_key="$TLS_KEY.tmp"
    tmp_cert="$TLS_CERT.tmp"
    rm -f "$tmp_key" "$tmp_cert"
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
      -keyout "$tmp_key" -out "$tmp_cert" \
      -subj "/CN=$HOST" -addext "subjectAltName=$SAN" >/dev/null 2>&1 \
      || fail "could not generate TLS certificate for $HOST"
    chmod 0600 "$tmp_key"
    chmod 0644 "$tmp_cert"
    mv -f "$tmp_key" "$TLS_KEY"
    mv -f "$tmp_cert" "$TLS_CERT"
    printf '%s\n' "$HOST" > "$TLS_HOST"
    chmod 0600 "$TLS_HOST"
    echo "Nexus Backup Repository: generated TLS certificate for $HOST"
  fi

  if [ -n "$INITIAL_USER" ]; then
    NEXUS_REPOSITORY_QUIET=1 /usr/local/bin/nexus-repository-client "$INITIAL_USER" main >/dev/null
    echo "Nexus Backup Repository: initial remote client '$INITIAL_USER' is ready"
  fi

  set -- "$@" \
    --htpasswd-file "$HTPASSWD" \
    --private-repos \
    --tls \
    --tls-cert "$TLS_CERT" \
    --tls-key "$TLS_KEY" \
    --tls-min-ver 1.3

  SCHEME=https
  DISPLAY_HOST=$HOST
  PROTECTION_SUMMARY="TLS 1.3, bcrypt authentication and private repositories enabled"
else
  # Home mode is deliberately boring: the Unraid/LAN is the trust boundary.
  # Workstations use an empty-password Restic repository over plain HTTP and
  # Nexus derives a per-workstation repository path automatically.
  set -- "$@" --no-auth
  SCHEME=http
  DISPLAY_HOST=${HOST:-0.0.0.0}
  PROTECTION_SUMMARY="Home mode: trusted LAN, no Repository auth/TLS"
fi

if [ "$APPEND_ONLY" = "true" ]; then
  set -- "$@" --append-only
fi

cat > "$ACTIVE_JSON.tmp" <<EOF
{"exposure":"$EXPOSURE","host":"$HOST","listenPort":$PORT,"endpointPort":$ENDPOINT_PORT,"appendOnly":$APPEND_ONLY}
EOF
chmod 0600 "$ACTIVE_JSON.tmp"
mv -f "$ACTIVE_JSON.tmp" "$ACTIVE_JSON"

echo "Nexus Backup Repository: exposure=$EXPOSURE endpoint=$SCHEME://$DISPLAY_HOST:$ENDPOINT_PORT listen=:$PORT append-only=$APPEND_ONLY"
echo "Nexus Backup Repository: $PROTECTION_SUMMARY"

exec /usr/local/bin/rest-server "$@"
