#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release identity: $*" >&2
  exit 1
}

emit() {
  local name=$1
  local value=$2
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$name" "$value"
  fi
}

event_name=${GITHUB_EVENT_NAME:-}
ref_name=${GITHUB_REF_NAME:-}
github_sha=${GITHUB_SHA:-}
input_version=${INPUT_VERSION:-}
input_expected_sha=${INPUT_EXPECTED_SHA:-}

[[ "$github_sha" =~ ^[0-9a-fA-F]{40}$ ]] || fail "GITHUB_SHA must be exactly 40 hexadecimal characters"

if [[ "$event_name" == "workflow_dispatch" ]]; then
  version=$input_version
  expected_sha=${input_expected_sha,,}
  actual_sha=${github_sha,,}

  [[ "$ref_name" == "main" ]] || fail "manual acceptance publishing is allowed only from main; selected ref is $ref_name"
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || fail "expected_sha must be exactly 40 hexadecimal characters"
  [[ "$actual_sha" == "$expected_sha" ]] || fail "selected main SHA $actual_sha does not match expected_sha $expected_sha"
  [[ "$version" == *-* ]] || fail "manual publishing is acceptance-only and requires a prerelease version such as 0.7.0-rc.1"
  stable=false
elif [[ "$event_name" == "push" ]]; then
  [[ "$ref_name" == v* ]] || fail "tag-triggered publishing requires a v-prefixed tag"
  version=${ref_name#v}
  stable=true
  [[ "$version" == *-* ]] && stable=false
else
  fail "unsupported event $event_name"
fi

[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] \
  || fail "version must be SemVer, for example 0.7.0 or 0.7.0-rc.1"

emit version "$version"
emit stable "$stable"
echo "release identity: publishing Nexus Backup $version from ${github_sha,,} (stable=$stable)" >&2
