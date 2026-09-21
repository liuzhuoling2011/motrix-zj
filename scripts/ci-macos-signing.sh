#!/usr/bin/env bash
# Map electron-builder-style GitHub Secrets onto Tauri macOS signing/notarization.
#
# Expected secrets (exact names — values stay in GitHub Secrets, never in git):
#   CSC_LINK              base64 of Developer ID Application .p12
#   CSC_KEY_PASSWORD      p12 export password
#   APPLE_TEAM_ID         Apple Team ID
#   APPLE_API_KEY         contents of the App Store Connect .p8 private key
#   APPLE_API_KEY_ID      App Store Connect Key ID
#   APPLE_API_ISSUER      App Store Connect Issuer ID
#
# This app is Tauri, not Electron. The mappings are:
#   CSC_LINK           → APPLE_CERTIFICATE
#   CSC_KEY_PASSWORD   → APPLE_CERTIFICATE_PASSWORD
#   APPLE_API_KEY_ID   → APPLE_API_KEY          (Tauri's Key ID variable)
#   APPLE_API_KEY      → AuthKey_<id>.p8 file   (APPLE_API_KEY_PATH)
#
# When CSC_LINK is present, the ad-hoc signingIdentity ("-") is removed from
# tauri.conf.json so the imported Developer ID is used. Empty secrets keep
# ad-hoc signing for unsigned local/CI runs.
set -euo pipefail

if [ -z "${GITHUB_ENV:-}" ]; then
  echo "GITHUB_ENV is required (run from GitHub Actions)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$PROJECT_ROOT/src-tauri/tauri.conf.json"

if [ -n "${CSC_LINK:-}" ]; then
  {
    echo "APPLE_CERTIFICATE<<EOF"
    printf '%s\n' "$CSC_LINK"
    echo "EOF"
    echo "APPLE_CERTIFICATE_PASSWORD=${CSC_KEY_PASSWORD:-}"
  } >>"$GITHUB_ENV"

  python3 - "$CONF" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
macos = data.setdefault("bundle", {}).setdefault("macOS", {})
if macos.pop("signingIdentity", None) is not None:
    path.write_text(json.dumps(data, indent=2) + "\n")
    print("Removed ad-hoc signingIdentity so the imported Developer ID is used")
else:
    print("tauri.conf.json has no signingIdentity to remove")
PY
else
  echo "CSC_LINK is empty; keeping ad-hoc signingIdentity from tauri.conf.json"
fi

if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  key_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/private_keys"
  mkdir -p "$key_dir"
  key_path="$key_dir/AuthKey_${APPLE_API_KEY_ID}.p8"
  printf '%s' "$APPLE_API_KEY" >"$key_path"
  # notarytool accepts a missing trailing newline; keep the file 0600.
  if [ -s "$key_path" ] && [ "$(tail -c 1 "$key_path" | wc -c)" -ne 0 ]; then
    printf '\n' >>"$key_path"
  fi
  chmod 600 "$key_path"
  {
    echo "APPLE_API_KEY_PATH=$key_path"
    echo "APPLE_API_KEY=${APPLE_API_KEY_ID}"
    echo "APPLE_API_ISSUER=${APPLE_API_ISSUER}"
  } >>"$GITHUB_ENV"
  echo "Wrote App Store Connect API key for notarization (Key ID from APPLE_API_KEY_ID)"
else
  echo "APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER incomplete; notarization will be skipped"
fi

if [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "APPLE_TEAM_ID=${APPLE_TEAM_ID}" >>"$GITHUB_ENV"
fi
