#!/bin/sh
set -eu

CONFIG_PATH="${NEXUS_BACKUP_CONFIG:-/config/agent.json}"
if [ ! -f "$CONFIG_PATH" ]; then
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cp /app/defaults/agent.json "$CONFIG_PATH"
fi

exec node /app/apps/agent/bin/agent.mjs "$@"
