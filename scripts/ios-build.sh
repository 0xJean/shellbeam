#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*=' | xargs -I{} echo {})
fi

TEAM="${IOS_DEVELOPMENT_TEAM:-}"
if [[ -z "$TEAM" ]]; then
  echo "ERROR: IOS_DEVELOPMENT_TEAM is not set. Add it to .env file:"
  echo '  IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID'
  exit 1
fi
export APPLE_DEVELOPMENT_TEAM="$TEAM"
echo "Using developmentTeam=${TEAM}"

TAURI_CONFIG="{\"bundle\":{\"iOS\":{\"developmentTeam\":\"${TEAM}\"}}}"

# Build IPA / xcarchive suitable for安装到真机（默认就是 release）
env -u CI npx tauri ios build --config "${TAURI_CONFIG}"

