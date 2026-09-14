#!/bin/sh
set -eu

umask 077
CONFIG_DIR=${NEXUS_BACKUP_REPOSITORY_CONFIG_DIR:-/config/repository}
SETTINGS_DIR="$CONFIG_DIR/settings"
mkdir -p "$SETTINGS_DIR"
chmod 0700 "$CONFIG_DIR" "$SETTINGS_DIR"

usage() {
  cat >&2 <<'EOF'
Usage:
  nexus-repository-settings show
  nexus-repository-settings get <exposure|host|listen-port|endpoint-port|append-only>
  nexus-repository-settings set <exposure|host|listen-port|endpoint-port|append-only> <value>

Exposure is 'lan' or 'internet'. append-only is 'true' or 'false'.
Changes are persistent and take effect after restarting NexusBackup.
EOF
  exit 2
}

file_for() {
  case "$1" in
    exposure) echo "$SETTINGS_DIR/exposure" ;;
    host) echo "$SETTINGS_DIR/host" ;;
    listen-port) echo "$SETTINGS_DIR/listen-port" ;;
    endpoint-port) echo "$SETTINGS_DIR/endpoint-port" ;;
    append-only) echo "$SETTINGS_DIR/append-only" ;;
    *) return 1 ;;
  esac
}

validate() {
  key=$1
  value=$2
  case "$key" in
    exposure)
      [ "$value" = "lan" ] || [ "$value" = "internet" ] || { echo "exposure must be lan or internet" >&2; return 1; }
      ;;
    host)
      [ -n "$value" ] || { echo "host must not be empty" >&2; return 1; }
      case "$value" in *[!A-Za-z0-9.-]*) echo "host contains unsupported characters" >&2; return 1 ;; esac
      ;;
    listen-port|endpoint-port)
      case "$value" in ''|*[!0-9]*) echo "$key must be numeric" >&2; return 1 ;; esac
      [ "$value" -ge 1 ] 2>/dev/null && [ "$value" -le 65535 ] 2>/dev/null || { echo "$key must be between 1 and 65535" >&2; return 1; }
      ;;
    append-only)
      [ "$value" = "true" ] || [ "$value" = "false" ] || { echo "append-only must be true or false" >&2; return 1; }
      ;;
    *) return 1 ;;
  esac
}

write_setting() {
  key=$1
  value=$2
  validate "$key" "$value"
  file=$(file_for "$key") || usage
  tmp="$file.tmp.$$"
  printf '%s\n' "$value" > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$file"
}

read_setting() {
  key=$1
  file=$(file_for "$key") || usage
  [ -s "$file" ] || return 1
  value=$(cat "$file")
  validate "$key" "$value" >/dev/null
  printf '%s\n' "$value"
}

cmd=${1:-}
case "$cmd" in
  get)
    [ "$#" -eq 2 ] || usage
    read_setting "$2"
    ;;
  set)
    [ "$#" -eq 3 ] || usage
    write_setting "$2" "$3"
    echo "Saved $2. Restart NexusBackup to apply Repository listener/TLS policy changes."
    ;;
  show)
    [ "$#" -eq 1 ] || usage
    exposure=$(read_setting exposure 2>/dev/null || echo lan)
    host=$(read_setting host 2>/dev/null || true)
    listen_port=$(read_setting listen-port 2>/dev/null || echo 8000)
    endpoint_port=$(read_setting endpoint-port 2>/dev/null || echo "$listen_port")
    append_only=$(read_setting append-only 2>/dev/null || { [ "$exposure" = internet ] && echo true || echo false; })
    printf 'Exposure:      %s\n' "$exposure"
    printf 'Endpoint host: %s\n' "${host:-not configured}"
    printf 'Listen port:   %s\n' "$listen_port"
    printf 'Endpoint port: %s\n' "$endpoint_port"
    printf 'Append-only:   %s\n' "$append_only"
    printf 'TLS:           required (minimum TLS 1.3)\n'
    printf 'Auth:          bcrypt per-principal + private repositories\n'
    ;;
  *) usage ;;
esac
