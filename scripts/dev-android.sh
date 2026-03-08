#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Android dev script for ShellBeam
# Usage: npm run dev:android
#
# Builds debug APK and installs on connected device/emulator.
# Supports hot-reload via Tauri's dev server.
#
# Prerequisites:
#   - Android device connected via USB (with USB debugging) or emulator running
#   - adb in PATH (comes with Android SDK platform-tools)
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/android-env.sh"

echo "📱 ShellBeam Android Dev"
echo "   ANDROID_HOME: $ANDROID_HOME"
echo "   NDK: $NDK_DIR"
echo ""

# Check for connected device
if ! adb devices 2>/dev/null | grep -q 'device$'; then
  echo "⚠️  No Android device/emulator detected."
  echo "   Connect a device with USB debugging or start an emulator."
  echo "   Continuing anyway (tauri will wait for device)..."
  echo ""
fi

echo "🚀 Starting dev server + building to device..."
npx tauri android dev
