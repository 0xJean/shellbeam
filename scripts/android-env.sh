#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Shared Android NDK environment setup for ShellBeam
# Sourced by build-android.sh and dev-android.sh
# ──────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Load .env ──
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# ── Ensure JDK 17+ for Gradle / AGP ──
if [[ -x /usr/libexec/java_home ]]; then
  JDK17=$(/usr/libexec/java_home -v 17 2>/dev/null || true)
  if [[ -n "$JDK17" ]]; then
    export JAVA_HOME="$JDK17"
  fi
fi
echo "JAVA_HOME: ${JAVA_HOME:-<not set>}"

# ── Validate Android SDK ──
: "${ANDROID_HOME:?ANDROID_HOME is not set. Install Android SDK and set this variable.}"

# ── Detect NDK ──
NDK_DIR=$(ls -d "$ANDROID_HOME/ndk/"* 2>/dev/null | sort -V | tail -1)
if [[ -z "$NDK_DIR" ]]; then
  echo "❌ No NDK found in $ANDROID_HOME/ndk/"
  exit 1
fi
export NDK_HOME="$NDK_DIR"
export ANDROID_NDK_ROOT="$NDK_DIR"

# ── Detect host platform ──
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  HOST_TAG="darwin-x86_64" ;;
  Darwin-x86_64) HOST_TAG="darwin-x86_64" ;;
  Linux-x86_64)  HOST_TAG="linux-x86_64" ;;
  *)             HOST_TAG="darwin-x86_64" ;;
esac
TOOLCHAIN="$NDK_DIR/toolchains/llvm/prebuilt/$HOST_TAG/bin"

if [[ ! -d "$TOOLCHAIN" ]]; then
  echo "❌ NDK toolchain not found at $TOOLCHAIN"
  exit 1
fi

# ── Create symlinks for cross-compilation tools ──
SYMLINK_DIR="$ROOT_DIR/src-tauri/target/.ndk-symlinks"
rm -rf "$SYMLINK_DIR"
mkdir -p "$SYMLINK_DIR"

for tool in ranlib ar nm objdump strip readelf; do
  src="$TOOLCHAIN/llvm-$tool"
  [[ -f "$src" ]] || continue
  for arch in aarch64-linux-android armv7a-linux-androideabi i686-linux-android x86_64-linux-android; do
    ln -sf "$src" "$SYMLINK_DIR/${arch}-${tool}"
  done
done

export PATH="$SYMLINK_DIR:$TOOLCHAIN:$PATH"

# ── Cross-compilation env vars ──
API_LEVEL=24

export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang"
export CXX_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang++"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
export RANLIB_aarch64_linux_android="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/aarch64-linux-android${API_LEVEL}-clang"

export CC_armv7_linux_androideabi="$TOOLCHAIN/armv7a-linux-androideabi${API_LEVEL}-clang"
export CXX_armv7_linux_androideabi="$TOOLCHAIN/armv7a-linux-androideabi${API_LEVEL}-clang++"
export AR_armv7_linux_androideabi="$TOOLCHAIN/llvm-ar"
export RANLIB_armv7_linux_androideabi="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER="$TOOLCHAIN/armv7a-linux-androideabi${API_LEVEL}-clang"

export CC_x86_64_linux_android="$TOOLCHAIN/x86_64-linux-android${API_LEVEL}-clang"
export CXX_x86_64_linux_android="$TOOLCHAIN/x86_64-linux-android${API_LEVEL}-clang++"
export AR_x86_64_linux_android="$TOOLCHAIN/llvm-ar"
export RANLIB_x86_64_linux_android="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$TOOLCHAIN/x86_64-linux-android${API_LEVEL}-clang"

export CC_i686_linux_android="$TOOLCHAIN/i686-linux-android${API_LEVEL}-clang"
export CXX_i686_linux_android="$TOOLCHAIN/i686-linux-android${API_LEVEL}-clang++"
export AR_i686_linux_android="$TOOLCHAIN/llvm-ar"
export RANLIB_i686_linux_android="$TOOLCHAIN/llvm-ranlib"
export CARGO_TARGET_I686_LINUX_ANDROID_LINKER="$TOOLCHAIN/i686-linux-android${API_LEVEL}-clang"
