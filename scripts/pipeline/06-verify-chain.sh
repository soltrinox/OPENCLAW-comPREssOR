#!/usr/bin/env bash
# Post-publish verify: npm view, ClawHub listing, optional Gateway install + doctor.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/06-verify-chain-${TS}.log.txt"

GO="${PIPELINE_GO:-0}"
DRY_RUN="${DRY_RUN:-0}"
EXPECTED_NAME="@soltrinox/openclaw-compressor"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

PASS=0
FAIL=0
NOT_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/06-verify-chain.sh [--go] [--dry-run]

Checks:
  npm view @soltrinox/openclaw-compressor version
  ClawHub listing (CLI; not website picker)
  optional: openclaw plugins install clawhub:@soltrinox/openclaw-compressor
            + openclaw compressor doctor (only with --go)
EOF
}

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { log "[FAIL] $*"; FAIL=$((FAIL + 1)); }
notrun() { log "[NOT_RUN] $*"; NOT_RUN=$((NOT_RUN + 1)); }

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
log "=== 06-verify-chain ==="
log "ts_utc=${TS} go=${GO} dry_run=${DRY_RUN}"

PKG_VERSION="$(node -p 'require("./package.json").version')"
log "package.json version=${PKG_VERSION}"

set +e
NPM_VIEW="$(npm view "${EXPECTED_NAME}" version 2>&1)"
NPM_RC=$?
set -e
log "npm view: ${NPM_VIEW}"
if [[ "${NPM_RC}" -eq 0 && "${NPM_VIEW}" == "${PKG_VERSION}" ]]; then
  pass "npm view ${EXPECTED_NAME} version=${NPM_VIEW}"
elif [[ "${GO}" == "1" && "${DRY_RUN}" != "1" ]]; then
  fail "npm view expected ${PKG_VERSION} got rc=${NPM_RC} out=${NPM_VIEW}"
else
  notrun "npm view mismatch or unpublished (expected after live publish); got ${NPM_VIEW}"
fi

CLAWHUB=()
if command -v clawhub >/dev/null 2>&1; then
  CLAWHUB=(clawhub)
elif command -v npx >/dev/null 2>&1; then
  CLAWHUB=(npx clawhub)
fi

if [[ "${#CLAWHUB[@]}" -eq 0 ]]; then
  notrun "clawhub listing reason=clawhub not on PATH and npx unavailable"
else
  LIST_OK=0
  log "[RUN] ${CLAWHUB[*]} package info ${EXPECTED_NAME}"
  set +e
  "${CLAWHUB[@]}" package info "${EXPECTED_NAME}" --json 2>&1 | tee -a "${LOG}"
  RC=${PIPESTATUS[0]}
  set -e
  if [[ "${RC}" -eq 0 ]]; then
    LIST_OK=1
  else
    log "[RUN] ${CLAWHUB[*]} search ${EXPECTED_NAME}"
    set +e
    "${CLAWHUB[@]}" search "${EXPECTED_NAME}" 2>&1 | tee -a "${LOG}"
    RC=${PIPESTATUS[0]}
    set -e
    if [[ "${RC}" -eq 0 ]]; then
      LIST_OK=1
    fi
  fi
  if [[ "${LIST_OK}" -eq 1 ]]; then
    pass "ClawHub listing ${EXPECTED_NAME}"
  elif [[ "${GO}" == "1" && "${DRY_RUN}" != "1" ]]; then
    fail "ClawHub listing did not return ${EXPECTED_NAME}"
  else
    notrun "ClawHub listing (expected after live CLI publish)"
  fi
fi

if [[ "${GO}" != "1" || "${DRY_RUN}" == "1" ]]; then
  notrun "openclaw plugins install reason=requires --go and not --dry-run"
  notrun "openclaw compressor doctor reason=requires --go and not --dry-run"
else
  if ! command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
    notrun "openclaw plugins install reason=${OPENCLAW_BIN} not on PATH"
    notrun "openclaw compressor doctor reason=${OPENCLAW_BIN} not on PATH"
  else
    set +e
    "${OPENCLAW_BIN}" plugins install "clawhub:${EXPECTED_NAME}" 2>&1 | tee -a "${LOG}"
    INST_RC=${PIPESTATUS[0]}
    set -e
    if [[ "${INST_RC}" -eq 0 ]]; then
      pass "openclaw plugins install clawhub:${EXPECTED_NAME}"
    else
      fail "openclaw plugins install exit=${INST_RC}"
    fi
    set +e
    "${OPENCLAW_BIN}" compressor doctor 2>&1 | tee -a "${LOG}"
    DOC_RC=${PIPESTATUS[0]}
    set -e
    if [[ "${DOC_RC}" -eq 0 ]]; then
      pass "openclaw compressor doctor"
    else
      fail "openclaw compressor doctor exit=${DOC_RC}"
    fi
  fi
fi

log ""
log "=== TALLY ==="
log "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
log "log=${LOG}"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
