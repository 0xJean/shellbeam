#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# iOS TestFlight build + upload script
# Usage: npm run build:ios:tf
#
# Reads credentials from .env:
#   IOS_DEVELOPMENT_TEAM, APPLE_ID, APPLE_PASSWORD
#
# Steps:
#   1. Build Rust + frontend via `tauri ios build`
#   2. Re-export xcarchive → App Store IPA
#   3. Upload IPA to App Store Connect (TestFlight)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="/usr/bin:/usr/local/bin:$PATH"

# ── Load .env ──
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# ── Validate ──
TEAM="${IOS_DEVELOPMENT_TEAM:-}"
: "${TEAM:?Missing IOS_DEVELOPMENT_TEAM in .env}"
: "${APPLE_ID:?Missing APPLE_ID in .env}"
: "${APPLE_PASSWORD:?Missing APPLE_PASSWORD in .env}"

export APPLE_DEVELOPMENT_TEAM="$TEAM"

APPLE_DIR="$ROOT_DIR/src-tauri/gen/apple"
BUILD_DIR="$APPLE_DIR/build"
ARCHIVE_PATH="$BUILD_DIR/app_iOS.xcarchive"
EXPORT_DIR="$BUILD_DIR/tf-export"

# ── Auto-increment build number ──
# App Store Connect requires unique CFBundleVersion per upload.
BUILD_NUMBER="$(date +%Y%m%d.%H%M)"
INFO_PLIST="$APPLE_DIR/app_iOS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$INFO_PLIST"

echo "📱 ShellBeam iOS → TestFlight"
echo "   Team:  $TEAM"
echo "   Build: $BUILD_NUMBER"
echo ""

# ── Step 1: Tauri iOS build (Rust + frontend + xcarchive) ──
echo "🔨 [1/3] Building iOS release..."
TAURI_CONFIG="{\"bundle\":{\"iOS\":{\"developmentTeam\":\"${TEAM}\"}}}"
env -u CI npx tauri ios build --config "${TAURI_CONFIG}"
echo ""

# ── Step 2: Export IPA for App Store / TestFlight ──
echo "📦 [2/3] Exporting App Store IPA..."

EXPORT_OPTS="$BUILD_DIR/TFExportOptions.plist"
cat > "$EXPORT_OPTS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>${TEAM}</string>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
PLIST

rm -rf "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTS" \
  -allowProvisioningUpdates

IPA_PATH="$(find "$EXPORT_DIR" -name '*.ipa' | head -1)"
if [[ -z "$IPA_PATH" ]]; then
  echo "❌ IPA not found in $EXPORT_DIR"
  exit 1
fi
echo "✅ IPA: $IPA_PATH"
echo ""

# ── Step 3: Upload to App Store Connect ──
echo "🚀 [3/3] Uploading to App Store Connect..."
UPLOAD_OUTPUT=$(xcrun altool --upload-app \
  --type ios \
  --file "$IPA_PATH" \
  --username "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$TEAM" 2>&1) || true

echo "$UPLOAD_OUTPUT"

if echo "$UPLOAD_OUTPUT" | grep -qi "UPLOAD FAILED"; then
  echo ""
  echo "❌ Upload failed. Fix the errors above and re-run."
  exit 1
fi

echo ""
echo "✅ Upload complete!"
echo "   Build $BUILD_NUMBER is processing on App Store Connect."
echo "   It will appear in TestFlight within ~15 minutes."
