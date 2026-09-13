#!/bin/sh
set -eu

umask 077

CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config}
PUBLIC_DIR=${NEXUS_BACKUP_REPOSITORY_PUBLIC_DIR:-/public}
DATA_DIR=${NEXUS_BACKUP_REPOSITORY_DATA_DIR:-/data}
HOST=${NEXUS_BACKUP_REPOSITORY_HOST:-}
PORT=${NEXUS_BACKUP_REPOSITORY_PORT:-8000}
PUBLIC_PORT=${NEXUS_BACKUP_REPOSITORY_PUBLIC_PORT:-8001}
INITIAL_USER=${NEXUS_BACKUP_REPOSITORY_INITIAL_USER:-}

fail() {
  echo "Nexus Backup Repository: $*" >&2
  exit 1
}

[ -n "$HOST" ] || fail "NEXUS_BACKUP_REPOSITORY_HOST is required and must be the LAN DNS name or IPv4 address used by workstations"
case "$HOST" in
  *[!A-Za-z0-9.-]*) fail "NEXUS_BACKUP_REPOSITORY_HOST contains unsupported characters" ;;
esac
for value in "$PORT" "$PUBLIC_PORT"; do
  case "$value" in
    ''|*[!0-9]*) fail "repository ports must be numeric" ;;
  esac
  [ "$value" -ge 1 ] 2>/dev/null && [ "$value" -le 65535 ] 2>/dev/null || fail "repository ports must be between 1 and 65535"
done
[ "$PORT" != "$PUBLIC_PORT" ] || fail "TLS repository port and public CA bootstrap port must differ"

mkdir -p "$CONFIG_DIR/clients" "$PUBLIC_DIR" "$DATA_DIR"
chmod 0700 "$CONFIG_DIR" "$CONFIG_DIR/clients"

HTPASSWD="$CONFIG_DIR/.htpasswd"
TLS_KEY="$CONFIG_DIR/repository-tls.key"
TLS_CERT="$CONFIG_DIR/repository-tls.crt"
TLS_HOST="$CONFIG_DIR/repository-tls.host"
PUBLIC_CERT="$PUBLIC_DIR/repository-ca.pem"

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

rm -rf "$PUBLIC_DIR"/*
cp "$TLS_CERT" "$PUBLIC_CERT"
chmod 0644 "$PUBLIC_CERT"
sha256sum "$PUBLIC_CERT" | sed 's#  .*/#  #' > "$PUBLIC_DIR/repository-ca.pem.sha256"
chmod 0644 "$PUBLIC_DIR/repository-ca.pem.sha256"
printf '%s\n' "$HOST" > "$PUBLIC_DIR/repository-host"
printf '%s\n' "$PORT" > "$PUBLIC_DIR/repository-port"
chmod 0644 "$PUBLIC_DIR/repository-host" "$PUBLIC_DIR/repository-port"

if [ -n "$INITIAL_USER" ]; then
  NEXUS_REPOSITORY_QUIET=1 /usr/local/bin/nexus-repository-client "$INITIAL_USER" main >/dev/null
  echo "Nexus Backup Repository: initial client '$INITIAL_USER' is ready; retrieve its local setup values with: nexus-repository-client $INITIAL_USER main"
fi

# Only non-secret certificate/bootstrap metadata is exposed here. The workstation
# installer pins repository-ca.pem to the SHA-256 printed by nexus-repository-client.
httpd -p "$PUBLIC_PORT" -h "$PUBLIC_DIR"
echo "Nexus Backup Repository: CA bootstrap available on http://$HOST:$PUBLIC_PORT/; installer must verify the locally supplied SHA-256"
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
