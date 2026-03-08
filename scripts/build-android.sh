#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Android release build script for ShellBeam
# Usage: npm run build:android
#
# Produces signed APK + AAB (if keystore configured).
#
# Signing config in .env:
#   ANDROID_KEYSTORE_PATH  — path to .jks keystore
#   ANDROID_KEYSTORE_PASS  — keystore password
#   ANDROID_KEY_ALIAS      — key alias
#   ANDROID_KEY_PASS       — key password
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/android-env.sh"

echo "📱 Building ShellBeam for Android (release)"
echo "   ANDROID_HOME: $ANDROID_HOME"
echo "   NDK: $NDK_DIR"
echo ""

# ── Build ──
echo "🔨 [1/3] Compiling Rust + bundling APK/AAB..."
npx tauri android build

# ── Locate unsigned APK ──
OUTPUTS="$ROOT_DIR/src-tauri/gen/android/app/build/outputs"
UNSIGNED_APK="$(find "$OUTPUTS" -name '*-universal-release-unsigned.apk' 2>/dev/null | head -1)"
if [[ -z "$UNSIGNED_APK" ]]; then
  UNSIGNED_APK="$(find "$OUTPUTS" -name '*-release-unsigned.apk' 2>/dev/null | head -1)"
fi
if [[ -z "$UNSIGNED_APK" ]]; then
  UNSIGNED_APK="$(find "$OUTPUTS" -name '*.apk' 2>/dev/null | head -1)"
fi

# AAB
AAB_PATH="$(find "$OUTPUTS" -name '*.aab' 2>/dev/null | head -1)"

echo ""
# ── Sign APK ──
if [[ -n "${ANDROID_KEYSTORE_PATH:-}" ]]; then
  echo "🔐 [2/3] Signing APK..."

  : "${ANDROID_KEYSTORE_PASS:?ANDROID_KEYSTORE_PASS not set}"
  : "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS not set}"
  : "${ANDROID_KEY_PASS:?ANDROID_KEY_PASS not set}"

  # Resolve keystore path (relative to project root)
  KS_PATH="$ANDROID_KEYSTORE_PATH"
  [[ "$KS_PATH" != /* ]] && KS_PATH="$ROOT_DIR/$KS_PATH"

  if [[ ! -f "$KS_PATH" ]]; then
    echo "❌ Keystore not found: $KS_PATH"
    exit 1
  fi

  # Find build-tools for zipalign + apksigner
  BUILD_TOOLS_DIR=$(ls -d "$ANDROID_HOME/build-tools/"* 2>/dev/null | sort -V | tail -1)
  if [[ -z "$BUILD_TOOLS_DIR" ]]; then
    echo "❌ No build-tools found in $ANDROID_HOME/build-tools/"
    exit 1
  fi

  ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
  APKSIGNER="$BUILD_TOOLS_DIR/apksigner"

  # Ensure JAVA_HOME/bin is first in PATH so apksigner/jarsigner use JDK 17+
  if [[ -n "${JAVA_HOME:-}" ]]; then
    export PATH="$JAVA_HOME/bin:$PATH"
  fi

  if [[ -n "$UNSIGNED_APK" ]]; then
    SIGNED_APK="${UNSIGNED_APK/-unsigned/}"
    # If the file names are the same (no -unsigned suffix), add -signed
    [[ "$SIGNED_APK" == "$UNSIGNED_APK" ]] && SIGNED_APK="${UNSIGNED_APK%.apk}-signed.apk"

    ALIGNED_APK="${UNSIGNED_APK%.apk}-aligned.apk"

    # zipalign
    "$ZIPALIGN" -f -v 4 "$UNSIGNED_APK" "$ALIGNED_APK" > /dev/null 2>&1

    # apksigner
    "$APKSIGNER" sign \
      --ks "$KS_PATH" \
      --ks-pass "pass:$ANDROID_KEYSTORE_PASS" \
      --ks-key-alias "$ANDROID_KEY_ALIAS" \
      --key-pass "pass:$ANDROID_KEY_PASS" \
      --out "$SIGNED_APK" \
      "$ALIGNED_APK"

    rm -f "$ALIGNED_APK"
    echo "   ✅ Signed APK: $SIGNED_APK"
  else
    echo "   ⚠️  No APK found to sign"
  fi

  # Sign AAB with jarsigner (Google Play requires this)
  if [[ -n "$AAB_PATH" ]]; then
    echo "   Signing AAB..."
    jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
      -keystore "$KS_PATH" \
      -storepass "$ANDROID_KEYSTORE_PASS" \
      -keypass "$ANDROID_KEY_PASS" \
      "$AAB_PATH" "$ANDROID_KEY_ALIAS" > /dev/null 2>&1
    echo "   ✅ Signed AAB: $AAB_PATH"
  fi
else
  echo "⏭️  [2/3] Skipping signing (no ANDROID_KEYSTORE_PATH in .env)"
  SIGNED_APK="$UNSIGNED_APK"
fi

# ── Output summary ──
echo ""
echo "📦 [3/3] Build outputs:"
if [[ -n "${SIGNED_APK:-}" ]] && [[ -f "${SIGNED_APK:-}" ]]; then
  echo "   APK: $SIGNED_APK ($(du -h "$SIGNED_APK" | cut -f1))"
elif [[ -n "${UNSIGNED_APK:-}" ]]; then
  echo "   APK: $UNSIGNED_APK ($(du -h "$UNSIGNED_APK" | cut -f1)) [unsigned]"
else
  echo "   APK: not found"
fi

if [[ -n "${AAB_PATH:-}" ]]; then
  echo "   AAB: $AAB_PATH ($(du -h "$AAB_PATH" | cut -f1))"
fi

if [[ -z "${ANDROID_KEYSTORE_PATH:-}" ]]; then
  echo ""
  echo "💡 To sign for distribution, generate a keystore and add to .env:"
  echo "   keytool -genkey -v -keystore shellbeam.jks -keyalg RSA -keysize 2048 -validity 10000 -alias shellbeam"
  echo ""
  echo "   ANDROID_KEYSTORE_PATH=./shellbeam.jks"
  echo "   ANDROID_KEYSTORE_PASS=your_password"
  echo "   ANDROID_KEY_ALIAS=shellbeam"
  echo "   ANDROID_KEY_PASS=your_password"
fi

echo ""
echo "✅ Android build complete!"
