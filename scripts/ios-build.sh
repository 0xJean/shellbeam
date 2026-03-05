#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*=' | xargs -I{} echo {})
fi

echo "Using IOS_DEVELOPMENT_TEAM=${IOS_DEVELOPMENT_TEAM:-<not set>}"

# Build IPA / xcarchive suitable for安装到真机（默认就是 release）
env -u CI npx tauri ios build

