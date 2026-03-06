#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' .env | grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*=' | xargs -I{} echo {})
fi

# APPLE_DEVELOPMENT_TEAM env var works for the outer Tauri CLI call but does NOT
# propagate into xcodebuild's build-phase script (tauri ios xcode-script).
# So we must inject developmentTeam via --config JSON override.
TEAM="${IOS_DEVELOPMENT_TEAM:-}"
if [[ -z "$TEAM" ]]; then
  echo "ERROR: IOS_DEVELOPMENT_TEAM is not set. Add it to .env file:"
  echo '  IOS_DEVELOPMENT_TEAM=YOUR_TEAM_ID'
  exit 1
fi
export APPLE_DEVELOPMENT_TEAM="$TEAM"
echo "Using developmentTeam=${TEAM}"

TAURI_CONFIG="{\"bundle\":{\"iOS\":{\"developmentTeam\":\"${TEAM}\"}}}"

# iOS real-device hot-reload (devUrl) is broken in Tauri v2 due to a known bug:
# Tauri's Rust backend uses reqwest (pure Rust HTTP) to fetch devUrl content,
# but iOS blocks non-Apple networking APIs from accessing local network resources
# even when Local Network permission is granted. This affects all Tauri v2 users.
# See: https://github.com/tauri-apps/tauri/issues/9509
#      https://github.com/tauri-apps/tauri/issues/13715
#      https://github.com/tauri-apps/tauri-docs/issues/3362
#
# Workaround: use "tauri ios build --debug" which bundles the frontend into the IPA.
# --debug = unoptimized Rust (much faster compile than release).
#
# For hot-reload on iOS Simulator: npx tauri ios dev "iPhone 16 Pro"
echo ""
echo "Building debug IPA and deploying to connected device..."
echo "  (debug build = faster compile, includes debug symbols)"
echo "  Tip: For hot-reload, use the iOS Simulator instead:"
echo "       npx tauri ios dev \"iPhone 16 Pro\""
echo ""
env -u CI npx tauri ios build --debug --config "${TAURI_CONFIG}"

# Auto-install and launch on connected device.
# ios-deploy needs a .app directory, not .ipa.
# After `tauri ios build`, the .app is inside the xcarchive or Payload dir.
BUILD_DIR="$ROOT_DIR/src-tauri/gen/apple/build"
APP_PATH=""

# Prefer xcarchive's .app (always up-to-date after build)
if [[ -d "$BUILD_DIR/app_iOS.xcarchive/Products/Applications/shellbeam.app" ]]; then
  APP_PATH="$BUILD_DIR/app_iOS.xcarchive/Products/Applications/shellbeam.app"
elif [[ -d "$BUILD_DIR/Payload/shellbeam.app" ]]; then
  APP_PATH="$BUILD_DIR/Payload/shellbeam.app"
fi

if [[ -n "$APP_PATH" ]]; then
  echo ""
  echo "Installing to device: $APP_PATH"
  ios-deploy --bundle "$APP_PATH" --no-wifi
  echo ""
  echo "App installed and launched."
else
  echo ""
  echo "WARNING: shellbeam.app not found in build output."
  echo "Install the IPA manually: $BUILD_DIR/arm64/shellbeam.ipa"
fi

