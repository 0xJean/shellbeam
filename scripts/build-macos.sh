#!/bin/bash
# macOS signed + notarized build script
# Usage: npm run build:macos
#
# Reads credentials from .env file (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID)
# or from environment variables if already set.

set -e

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

# ── Signing identity ──
export APPLE_SIGNING_IDENTITY="Developer ID Application: chuang liu (H4NCLYWCAJ)"

# ── Validate required credentials ──
: "${APPLE_ID:?Missing APPLE_ID — set in .env or environment}"
: "${APPLE_PASSWORD:?Missing APPLE_PASSWORD — set in .env or environment}"
: "${APPLE_TEAM_ID:=H4NCLYWCAJ}"

echo "🔐 Identity: $APPLE_SIGNING_IDENTITY"
echo "📦 Building ShellBeam for macOS..."
echo ""

npm run tauri build

echo ""
echo "✅ Build complete:"
ls -lh "$PROJECT_DIR/src-tauri/target/release/bundle/dmg/"*.dmg 2>/dev/null || true

echo ""
echo "🔍 Signature:"
codesign -dv --verbose=2 "$PROJECT_DIR/src-tauri/target/release/bundle/macos/ShellBeam.app" 2>&1 | grep -E "Authority|Identifier|Notarization"

echo ""
echo "🔍 Gatekeeper:"
spctl -a -vvv "$PROJECT_DIR/src-tauri/target/release/bundle/macos/ShellBeam.app" 2>&1
