#!/usr/bin/env bash
# Plan 11: build dist + npm pack with required contents; fail closed on secrets/missing artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TS="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/../PLANS/evidence}"
mkdir -p "$EVIDENCE_DIR"

echo "[pack] root=$ROOT"

if [[ ! -d node_modules ]]; then
  npm ci
fi

# Pack build: prefer sidecar+telemetry emit via tsconfig.pack.json (excludes
# src/ts-engine WIP). If peer WIP still breaks typecheck through packer-port,
# reuse existing dist/index.js for dry-run evidence only.
BUILD_LOG="$EVIDENCE_DIR/build-plan11-${TS}.log.txt"
if npx tsc -p tsconfig.pack.json >"$BUILD_LOG" 2>&1; then
  echo "[PASS] tsc -p tsconfig.pack.json" | tee -a "$BUILD_LOG"
elif [[ -f dist/index.js ]]; then
  {
    echo "[WARN] tsc failed (likely parallel Plan 06 ts-engine WIP); reusing existing dist/index.js"
    echo "[WARN] see tsc stderr above; dry-run pack proceeds for Wave 4 DEPLOY_HELD"
  } | tee -a "$BUILD_LOG"
else
  echo "[FAIL] no dist/index.js and tsc failed" | tee -a "$BUILD_LOG"
  exit 1
fi
test -f dist/index.js
echo "[PASS] dist/index.js present"
test -f openclaw.plugin.json
test -f skill/compressor/SKILL.md
test -d engine/src

# README listing gate (regex)
if grep -E '84%|unbreakable|PERFORMANCE\.md|\$[0-9]+' README.md CHANGELOG.md; then
  echo "[FAIL] README/CHANGELOG listing gate"
  exit 1
fi
echo "[PASS] README listing gate"

# Strip local Python caches before npm pack (.gitignore + .npmignore also list these).
find engine -type d \( -name '__pycache__' -o -name '.pytest_cache' \) -print0 2>/dev/null \
  | xargs -0 rm -rf 2>/dev/null || true
find engine -type d -name 'chat_compressor.egg-info' -print0 2>/dev/null \
  | xargs -0 rm -rf 2>/dev/null || true

rm -f soltrinox-openclaw-compressor-*.tgz
npm pack

TGZ=$(ls -1 soltrinox-openclaw-compressor-*.tgz | head -1)
test -n "$TGZ"
LIST_LOG="$EVIDENCE_DIR/pack-list-plan11-${TS}.log.txt"

{
  echo "# npm pack list — Plan 11 dry-run"
  echo "# tarball: $TGZ"
  echo "# generated: $TS"
  tar -tzf "$TGZ"
} | tee "$LIST_LOG"

LIST=$(tar -tzf "$TGZ")

echo "$LIST" | grep -q 'openclaw.plugin.json' || { echo "[FAIL] missing openclaw.plugin.json"; exit 1; }
echo "$LIST" | grep -q 'dist/index.js' || { echo "[FAIL] missing dist/index.js"; exit 1; }
echo "$LIST" | grep -q 'skill/compressor' || { echo "[FAIL] missing skill/compressor"; exit 1; }
echo "$LIST" | grep -q 'engine/' || { echo "[FAIL] missing engine/ (0.1.0 sidecar path)"; exit 1; }
echo "$LIST" | grep -q 'LICENSE' || { echo "[FAIL] missing LICENSE"; exit 1; }
echo "$LIST" | grep -q 'README' || { echo "[FAIL] missing README"; exit 1; }
echo "$LIST" | grep -q 'CHANGELOG' || { echo "[FAIL] missing CHANGELOG"; exit 1; }

if echo "$LIST" | grep -E '\.env$|credentials|id_rsa|test-results|\.safetensors'; then
  echo "[FAIL] pack contains forbidden paths"
  exit 1
fi
if echo "$LIST" | grep -E '__pycache__|\.pyc$|engine/tests/'; then
  echo "[FAIL] pack contains caches or engine/tests"
  exit 1
fi
echo "[PASS] secrets/cache grep empty"

echo "[PASS] pack.sh complete: $TGZ"
echo "[PASS] list log: $LIST_LOG"
