#!/usr/bin/env bash
# Pack ClawPack .tgz and extract a website-safe staged dir (no node_modules).
# Prefer CLI publish of the .tgz; staged dir is last-resort for ClawHub folder picker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[stage] running pack.sh"
bash "$ROOT/scripts/pack.sh"

PKG_NAME="$(node -p 'require("./package.json").name.replace(/^@/, "").replace(/\//g, "-")')"
PKG_VERSION="$(node -p 'require("./package.json").version')"
EXPECTED_TGZ="${PKG_NAME}-${PKG_VERSION}.tgz"

if [[ -f "$EXPECTED_TGZ" ]]; then
  TGZ="$ROOT/$EXPECTED_TGZ"
else
  TGZ="$(ls -1 "$ROOT/${PKG_NAME}"-*.tgz | head -1)"
fi
test -f "$TGZ"

STAGE_ROOT="${CLAWHUB_STAGE_DIR:-$ROOT/.clawhub-stage}"
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"
tar -xzf "$TGZ" -C "$STAGE_ROOT"
STAGE_DIR="$STAGE_ROOT/package"
test -d "$STAGE_DIR"
test -f "$STAGE_DIR/openclaw.plugin.json"
test -f "$STAGE_DIR/dist/index.js"

echo ""
echo "[PASS] tarball (CLI publish): $TGZ"
echo "[PASS] staged extract (website picker last resort): $STAGE_DIR"
echo "[NOTE] Do not pick OPENCLAW/COMPRESSOR working tree in the ClawHub UI."
echo "$TGZ"
echo "$STAGE_DIR"
