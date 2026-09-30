#!/usr/bin/env bash
# Optional Cursor VSIX/Open VSX fan-out. Must NOT npm publish or ClawHub publish.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/07-cursor-fanout-${TS}.log.txt"

CURSOR_ROOT="${CURSOR_ROOT:-/Users/rosario/work/comPREssOR}"
DRY_RUN="${DRY_RUN:-0}"
MAX_ITERATIONS="${MAX_ITERATIONS:-5}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
SKIP_CURSOR="${SKIP_CURSOR:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/07-cursor-fanout.sh [--dry-run] [--skip-cursor] [--max-iterations N]

Calls $CURSOR_ROOT/scripts/verify-ci-push-loop.sh
  CURSOR_ROOT default: /Users/rosario/work/comPREssOR

Must not run npm publish or clawhub. Cursor Open VSX skip-if-unset stays in that repo.
EOF
}

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; }
fail() { log "[FAIL] $*"; }
notrun() { log "[NOT_RUN] $*"; }
die() { fail "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-cursor) SKIP_CURSOR=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --max-iterations)
      MAX_ITERATIONS="${2:?--max-iterations requires N}"
      shift 2
      ;;
    --npm|--clawhub|--publish)
      die "cursor fan-out must not npm/clawhub publish (refused: $1)"
      ;;
    *)
      die "Unknown option: $1 (try --help)"
      ;;
  esac
done

: >"${LOG}"
log "=== 07-cursor-fanout ==="
log "ts_utc=${TS} CURSOR_ROOT=${CURSOR_ROOT} dry_run=${DRY_RUN} skip_cursor=${SKIP_CURSOR}"
log "LIVE_PUBLISH=forbidden (fan-out does not npm/clawhub publish)"

if [[ "${SKIP_CURSOR}" == "1" ]]; then
  notrun "cursor-fanout reason=--skip-cursor"
  log "log=${LOG}"
  exit 0
fi

LOOP="${CURSOR_ROOT}/scripts/verify-ci-push-loop.sh"
if [[ ! -x "${LOOP}" && ! -f "${LOOP}" ]]; then
  die "Cursor verify-ci-push-loop.sh not found at ${LOOP}"
fi

ARGS=(--max-iterations "${MAX_ITERATIONS}")
if [[ "${DRY_RUN}" == "1" ]]; then
  ARGS+=(--dry-run)
fi
if [[ "${ALLOW_DIRTY}" == "1" ]]; then
  ARGS+=(--allow-dirty)
fi

log "running: bash ${LOOP} ${ARGS[*]}"
# Do not forward LIVE_PUBLISH=1 or invoke npm/clawhub from this script.
set +e
env LIVE_PUBLISH=forbidden bash "${LOOP}" "${ARGS[@]}" 2>&1 | tee -a "${LOG}"
RC=${PIPESTATUS[0]}
set -e

if [[ "${RC}" -eq 0 ]]; then
  pass "cursor verify-ci-push-loop.sh"
  log "log=${LOG}"
  exit 0
fi

fail "cursor verify-ci-push-loop.sh exit=${RC}"
log "log=${LOG}"
exit "${RC}"
