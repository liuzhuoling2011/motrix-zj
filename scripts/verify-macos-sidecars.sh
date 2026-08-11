#!/usr/bin/env bash
# Smoke-test every executable bundled beside the macOS app binary.
# This catches signing regressions such as PyInstaller failing to load its
# extracted Python runtime under macOS Library Validation.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <aarch64-apple-darwin|x86_64-apple-darwin>" >&2
  exit 1
fi

TARGET="$1"
case "$TARGET" in
  aarch64-apple-darwin | x86_64-apple-darwin) ;;
  *)
    echo "Error: unsupported macOS target '$TARGET'" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$PROJECT_ROOT/src-tauri/target/$TARGET/release/bundle/macos/MotrixNext.app/Contents/MacOS"

if [ ! -d "$MACOS_DIR" ]; then
  echo "Error: bundled app directory not found: $MACOS_DIR" >&2
  exit 1
fi

YTDLP_PATH="$MACOS_DIR/motrixnext-ytdlp"
if ! YTDLP_ENTITLEMENTS=$(codesign -d --entitlements :- "$YTDLP_PATH" 2>/dev/null); then
  echo "Error: unable to read yt-dlp code-signing entitlements: $YTDLP_PATH" >&2
  exit 1
fi
if [[ "$YTDLP_ENTITLEMENTS" != *"<key>com.apple.security.cs.disable-library-validation</key>"* ]] ||
  [[ "$YTDLP_ENTITLEMENTS" != *"<true/>"* ]]; then
  echo "Error: yt-dlp is missing the macOS Library Validation exception" >&2
  exit 1
fi

run_version_check() {
  local binary_name="$1"
  local version_flag="$2"
  local binary_path="$MACOS_DIR/$binary_name"
  local output

  if [ ! -x "$binary_path" ]; then
    echo "Error: bundled executable is missing or not executable: $binary_path" >&2
    exit 1
  fi

  if output=$("$binary_path" "$version_flag" 2>&1); then
    echo "✓ $binary_name: ${output%%$'\n'*}"
  else
    echo "Error: bundled executable failed: $binary_path $version_flag" >&2
    echo "$output" >&2
    exit 1
  fi
}

run_version_check "motrix-next-engine" "--version"
run_version_check "motrixnext-ytdlp" "--version"
run_version_check "motrixnext-deno" "--version"
run_version_check "motrixnext-ffmpeg" "-version"
run_version_check "ffprobe" "-version"
