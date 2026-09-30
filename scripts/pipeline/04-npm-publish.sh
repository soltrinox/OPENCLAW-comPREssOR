#!/usr/bin/env bash
# Wrap scripts/release-publish.sh. Require --go + NPM_TOKEN. No live write otherwise.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/04-npm-publish-${TS}.log.txt"

GO="${PIPELINE_GO:-0}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/04-npm-publish.sh --go [--dry-run]

Wraps scripts/release-publish.sh (ephemeral .npmrc, E403 granular-token remediation).
Requires --go (or PIPELINE_GO=1) and NPM_TOKEN. LIVE_PUBLISH=forbidden unless --go.
EOF
}

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; }
fail() { log "[FAIL] $*"; }
notrun() { log "[NOT_RUN] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --go) GO=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *)
      echo "[FAIL] Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

: >"${LOG}"
log "=== 04-npm-publish ==="
log "ts_utc=${TS} go=${GO} dry_run=${DRY_RUN}"

if [[ "${GO}" != "1" ]]; then
  export LIVE_PUBLISH=forbidden
  fail "DEPLOY_HELD: npm publish requires --go (LIVE_PUBLISH=forbidden)"
  log "log=${LOG}"
  exit 2
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  export LIVE_PUBLISH=forbidden
  notrun "npm-publish reason=--dry-run (LIVE_PUBLISH=forbidden)"
  log "log=${LOG}"
  exit 0
fi

if [[ -z "${NPM_TOKEN:-}" ]]; then
  fail "NPM_TOKEN must be set for live npm publish"
  log "log=${LOG}"
  exit 1
fi

export LIVE_PUBLISH=1
log "LIVE_PUBLISH=1 (operator --go)"
log "wrapping scripts/release-publish.sh"

set +e
bash "${ROOT}/scripts/release-publish.sh" 2>&1 | tee -a "${LOG}"
RC=${PIPESTATUS[0]}
set -e

if [[ "${RC}" -eq 0 ]]; then
  pass "release-publish.sh"
  log "log=${LOG}"
  exit 0
fi

fail "release-publish.sh exit=${RC}"
log "log=${LOG}"
exit "${RC}"
