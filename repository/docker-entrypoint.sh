#!/bin/sh
set -eu

umask 077

CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config}
DATA_DIR=${NEXUS_BACKUP_REPOSITORY_DATA_DIR:-/data}
HOST=${NEXUS_BACKUP_REPOSITORY_HOST:-}
PORT=${NEXUS_BACKUP_REPOSITORY_PORT:-8000}
INITIAL_USER=${NEXUS_BACKUP_REPOSITORY_INITIAL_USER:-}

fail() {
  echo "Nexus Backup Repository: $*" >&2
  exit 1
}

[ -n "$HOST" ] || fail "NEXUS_BACKUP_REPOSITORY_HOST is required and must be the LAN DNS name or IPv4 address used by workstations"
case "$HOST" in
  *[!A-Za-z0-9.-]*) fail "NEXUS_BACKUP_REPOSITORY_HOST contains unsupported characters" ;;
esac
case "$PORT" in
  ''|*[!0-9]*) fail "repository port must be numeric" ;;
esac
[ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ] 2>/dev/null || fail "repository port must be between 1 and 65535"

mkdir -p "$CONFIG_DIR/clients" "$DATA_DIR"
chmod 0700 "$CONFIG_DIR" "$CONFIG_DIR/clients"

HTPASSWD="$CONFIG_DIR/.htpasswd"
TLS_KEY="$CONFIG_DIR/repository-tls.key"
TLS_CERT="$CONFIG_DIR/repository-tls.crt"
TLS_HOST="$CONFIG_DIR/repository-tls.host"

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
  echo "Nexus Backup Repository: initial client '$INITIAL_USER' is ready; retrieve its local setup values with: nexus-repository-client $INITIAL_USER main"
fi

echo "Nexus Backup Repository: listening on TLS port $PORT; private authenticated repositories are enabled"
exec /usr/local/bin/rest-server \
  --path "$DATA_DIR" \
  --listen ":$PORT" \
  --htpasswd-file "$HTPASSWD" \
  --private-repos \
  --tls \
  --tls-cert "$TLS_CERT" \
  --tls-key "$TLS_KEY" \
  --tls-min-ver 1.3 \
  --log -
