#!/usr/bin/env bash
# Preflight: Node >=22.22.3, gh/npm/clawhub presence, identity lock, no secrets in tree.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/00-preflight-${TS}.log.txt"

PASS=0
FAIL=0
NOT_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/00-preflight.sh

Checks Node >=22.22.3, gh/npm/clawhub on PATH (clawhub may be npx), identity lock
(package.json = openclaw.plugin.json = README version = CHANGELOG latest heading),
and no secret-ish files in the git tree.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { log "[FAIL] $*"; FAIL=$((FAIL + 1)); }
notrun() { log "[NOT_RUN] $*"; NOT_RUN=$((NOT_RUN + 1)); }

: >"${LOG}"
log "=== 00-preflight ==="
log "ts_utc=${TS} root=${ROOT}"
log "LIVE_PUBLISH=${LIVE_PUBLISH:-forbidden}"

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "command ${1} ($(command -v "$1"))"
    return 0
  fi
  fail "required command not found: $1"
  return 1
}

# --- tools ---
require_cmd node || true
require_cmd npm || true
require_cmd git || true
require_cmd gh || true

CLAWHUB_OK=0
if command -v clawhub >/dev/null 2>&1; then
  pass "command clawhub ($(command -v clawhub))"
  CLAWHUB_OK=1
elif command -v npx >/dev/null 2>&1; then
  pass "command clawhub via npx ($(command -v npx))"
  CLAWHUB_OK=1
else
  fail "clawhub not on PATH and npx unavailable"
fi

# --- Node >= 22.22.3 ---
if command -v node >/dev/null 2>&1; then
  if node -e '
const min = [22, 22, 3];
const have = process.versions.node.split(".").map((n) => parseInt(n, 10));
for (let i = 0; i < 3; i++) {
  const h = have[i] || 0;
  if (h > min[i]) process.exit(0);
  if (h < min[i]) process.exit(1);
}
process.exit(0);
'; then
    pass "node $(node -v) >= v22.22.3"
  else
    fail "node $(node -v) is below v22.22.3 (engines.node in package.json)"
  fi
fi

# --- identity lock ---
if [[ -f package.json && -f openclaw.plugin.json && -f README.md && -f CHANGELOG.md ]]; then
  PKG_VER="$(node -p 'require("./package.json").version')"
  PLUGIN_VER="$(node -p 'require("./openclaw.plugin.json").version')"
  README_VERS="$(grep -oE '@soltrinox/openclaw-compressor@[0-9]+\.[0-9]+\.[0-9]+' README.md | sort -u || true)"
  README_BAD="$(printf '%s\n' "${README_VERS}" | grep -v "@soltrinox/openclaw-compressor@${PKG_VER}" || true)"
  CHANGELOG_VER="$(sed -nE 's/^## ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' CHANGELOG.md | head -1)"

  log "package.json version=${PKG_VER}"
  log "openclaw.plugin.json version=${PLUGIN_VER}"
  log "README package pins: ${README_VERS:-<none>}"
  log "CHANGELOG latest heading=${CHANGELOG_VER:-<none>}"

  LOCK_OK=1
  if [[ "${PLUGIN_VER}" != "${PKG_VER}" ]]; then
    fail "identity lock: plugin.json ${PLUGIN_VER} != package.json ${PKG_VER}"
    LOCK_OK=0
  fi
  if [[ -z "${README_VERS}" ]]; then
    fail "identity lock: README has no @soltrinox/openclaw-compressor@X.Y.Z pin"
    LOCK_OK=0
  elif [[ -n "${README_BAD}" ]]; then
    fail "identity lock: README version drift: ${README_BAD}"
    LOCK_OK=0
  fi
  if [[ "${CHANGELOG_VER}" != "${PKG_VER}" ]]; then
    fail "identity lock: CHANGELOG latest ${CHANGELOG_VER:-<none>} != package.json ${PKG_VER}"
    LOCK_OK=0
  fi
  if [[ "${LOCK_OK}" -eq 1 ]]; then
    pass "identity lock package.json = plugin.json = README = CHANGELOG ${PKG_VER}"
  fi
else
  fail "identity lock: missing package.json, openclaw.plugin.json, README.md, or CHANGELOG.md"
fi

# --- secrets in tracked tree ---
SECRET_PATHS="$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.local$|(^|/)\.npmrc$|(^|/)credentials\.json$|(^|/)id_rsa$|\.pem$' || true)"
if [[ -n "${SECRET_PATHS}" ]]; then
  fail "secret-ish path tracked in git:"
  printf '%s\n' "${SECRET_PATHS}" | tee -a "${LOG}"
else
  pass "no secret-ish paths in git ls-files"
fi

if git grep -I -E 'NPM_TOKEN=npm_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}' \
  -- ':!scripts/pipeline/env.example' ':!scripts/pipeline/*.sh' >/dev/null 2>&1; then
  fail "tracked file looks like it contains a live token value"
  git grep -I -E 'NPM_TOKEN=npm_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}' \
    -- ':!scripts/pipeline/env.example' ':!scripts/pipeline/*.sh' | tee -a "${LOG}" || true
else
  pass "no live token assignments in tracked files"
fi

log ""
log "=== TALLY ==="
log "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
log "log=${LOG}"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
