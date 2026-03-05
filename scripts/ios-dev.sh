#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*=' | xargs -I{} echo {})
fi

echo "Using IOS_DEVELOPMENT_TEAM=${IOS_DEVELOPMENT_TEAM:-<not set>}"

# Use "tauri ios build --debug" instead of "tauri ios dev"
# - "ios dev" always loads devUrl (requires dev server reachable from device)
# - "ios build" bundles frontendDist into the app (works offline on device)
# --debug keeps Rust unoptimized for faster compile times during development
env -u CI npx tauri ios build --debug

