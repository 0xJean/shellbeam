#!/bin/bash
# macOS Universal (Apple Silicon + Intel) signed + notarized build script
# Usage: npm run build:macos
# Optional override: MACOS_TARGET=aarch64-apple-darwin npm run build:macos
#
# Reads credentials from .env file (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
# or from environment variables if already set.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Fix PATH: ensure system xattr is found before Python's xattr ──
export PATH="/usr/bin:/usr/local/bin:$PATH"

# ── Load .env if present ──
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# ── Target & Signing identity ──
TARGET="${MACOS_TARGET:-universal-apple-darwin}"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: chuang liu (H4NCLYWCAJ)}"

# ── Validate required credentials & Rust targets ──
: "${APPLE_ID:?Missing APPLE_ID — set in .env or environment}"
: "${APPLE_PASSWORD:?Missing APPLE_PASSWORD — set in .env or environment}"
: "${APPLE_TEAM_ID:=H4NCLYWCAJ}"

if [ "$TARGET" = "universal-apple-darwin" ]; then
  INSTALLED_TARGETS="$(rustup target list --installed)"
  for REQUIRED in aarch64-apple-darwin x86_64-apple-darwin; do
    if ! printf '%s\n' "$INSTALLED_TARGETS" | grep -qx "$REQUIRED"; then
      echo "❌ Missing Rust target '$REQUIRED' required for universal-apple-darwin."
      echo "   Run: rustup target add aarch64-apple-darwin x86_64-apple-darwin"
      exit 1
    fi
  done
fi

echo "🔐 Identity: $APPLE_SIGNING_IDENTITY"
echo "🎯 Target:   $TARGET"
echo "📦 Building ShellBeam for macOS..."
echo ""

npm run tauri build -- --target "$TARGET"

BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE_DIR/macos/ShellBeam.app"
DMG="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' | head -n 1)"

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "❌ No DMG found in $BUNDLE_DIR/dmg"
  exit 1
fi

echo ""
echo "☁️  Notarizing outer DMG: $(basename "$DMG")"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$DMG"

echo ""
echo "✅ Build complete:"
ls -lh "$DMG"

echo ""
echo "🔍 Signature (.app):"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|Identifier|TeamIdentifier|Timestamp"

echo ""
echo "🔍 Stapler & Gatekeeper (.app + .dmg):"
xcrun stapler validate "$APP"
spctl -a -vvv "$APP"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -vvv "$DMG"
