#!/usr/bin/env bash
# Single entry for the OpenClaw compressor multi-registry pipeline.
# LIVE_PUBLISH=forbidden unless --go. --sync-engine is never default.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

TARGET="openclaw"
MODE="test"
GO=0
PIN_VERSION=""
BUMP=""
MAX_ITERATIONS=5
SKIP_SIDECAR=0
SKIP_CURSOR=0
SYNC_ENGINE=0
DRY_RUN=0
ALLOW_DIRTY=0
CURSOR_ROOT="${CURSOR_ROOT:-/Users/rosario/work/comPREssOR}"

usage() {
  cat <<'EOF'
Usage:
  scripts/pipeline/pipeline.sh \
    --target openclaw|cursor|all \
    --mode test|ci|dry-run|release \
    --go \
    --version 0.1.4 \
    --bump [patch|minor|major] \
    --max-iterations 5 \
    --skip-sidecar \
    --skip-cursor \
    --sync-engine \
    --dry-run

Flags:
  --target openclaw|cursor|all   Default: openclaw. cursor/all runs 07-cursor-fanout.
  --mode test|ci|dry-run|release Default: test.
      test      preflight + local matrix (no git push, no registry writes)
      ci        local matrix + GitHub CI loop (push + gh run watch)
      dry-run   local + CI loop without push/publish
      release   local + CI; registry writes only with --go
  --go                           Operator GO. Sets LIVE_PUBLISH=1 for npm then ClawHub.
  --version X.Y.Z                Pin identity files together (invokes 01-version.sh)
  --bump [patch|minor|major]     Optional bump (default patch if flag present with no arg)
  --max-iterations N             CI loop cap (default 5, hard max 5)
  --skip-sidecar                 Skip sidecar smoke in local matrix
  --skip-cursor                  Skip Cursor fan-out even if --target all|cursor
  --sync-engine                  Opt-in copy of $CURSOR_ROOT/engine/src → ./engine/src
                                 Never default. Do not rsync CHAT-COMPRESSOR.
  --dry-run                      Skip git push and registry writes regardless of mode
  --allow-dirty                  Pass through to CI loop / Cursor fan-out
  --help                         This text

GO gating:
  LIVE_PUBLISH=forbidden unless --go.
  --mode release without --go exits non-zero with DEPLOY_HELD after local+CI
  (no npm publish, no clawhub package publish).
  --go + --dry-run: dry-run wins (no live registry writes).

Evidence: test-results/pipeline/ (override with EVIDENCE_DIR). Timestamped .log.txt
with [PASS]/[FAIL]/[NOT_RUN].

Does not run plugin runtime CLI (openclaw compressor stats|status|purge|export|doctor)
except optional doctor inside 06-verify-chain.sh after --go.
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
    --target)
      TARGET="${2:?--target requires openclaw|cursor|all}"
      shift 2
      ;;
    --mode)
      MODE="${2:?--mode requires test|ci|dry-run|release}"
      shift 2
      ;;
    --go) GO=1; shift ;;
    --version)
      PIN_VERSION="${2:?--version requires X.Y.Z}"
      shift 2
      ;;
    --bump)
      if [[ "${2:-}" =~ ^(patch|minor|major)$ ]]; then
        BUMP="$2"
        shift 2
      else
        BUMP="patch"
        shift
      fi
      ;;
    --max-iterations)
      MAX_ITERATIONS="${2:?--max-iterations requires N}"
      shift 2
      ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    --skip-cursor) SKIP_CURSOR=1; shift ;;
    --sync-engine) SYNC_ENGINE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    *)
      echo "[FAIL] Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
done

case "${TARGET}" in
  openclaw|cursor|all) ;;
  *) echo "[FAIL] --target must be openclaw|cursor|all (got ${TARGET})" >&2; exit 1 ;;
esac
case "${MODE}" in
  test|ci|dry-run|release) ;;
  *) echo "[FAIL] --mode must be test|ci|dry-run|release (got ${MODE})" >&2; exit 1 ;;
esac

if [[ "${MAX_ITERATIONS}" =~ ^[0-9]+$ ]] && (( MAX_ITERATIONS > 0 )); then
  if (( MAX_ITERATIONS > 5 )); then
    MAX_ITERATIONS=5
  fi
else
  echo "[FAIL] --max-iterations must be a positive integer" >&2
  exit 1
fi

if [[ "${MODE}" == "dry-run" ]]; then
  DRY_RUN=1
fi

if [[ "${GO}" == "1" && "${DRY_RUN}" != "1" ]]; then
  LIVE_PUBLISH=1
else
  LIVE_PUBLISH=forbidden
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
LOG="${EVIDENCE_DIR}/pipeline-${MODE}-${TARGET}-${TS}.log.txt"
: >"${LOG}"

export EVIDENCE_DIR
export PIPELINE_TS="${TS}"
export PIPELINE_MODE="${MODE}"
export PIPELINE_TARGET="${TARGET}"
export PIPELINE_GO="${GO}"
export LIVE_PUBLISH
export SKIP_SIDECAR
export SKIP_CURSOR
export SKIP_GATEWAY="${SKIP_GATEWAY:-0}"
export ENGINE_IMPL="${ENGINE_IMPL:-sidecar}"
export OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
export CURSOR_ROOT
export DRY_RUN
export MAX_ITERATIONS
export ALLOW_DIRTY
export PIPELINE_VERSION="${PIN_VERSION}"
export PIPELINE_BUMP="${BUMP}"

log "=== pipeline.sh ==="
log "ts_utc=${TS} root=${ROOT}"
log "target=${TARGET} mode=${MODE} go=${GO} dry_run=${DRY_RUN}"
log "LIVE_PUBLISH=${LIVE_PUBLISH}"
log "sync_engine=${SYNC_ENGINE} skip_sidecar=${SKIP_SIDECAR} skip_cursor=${SKIP_CURSOR}"
log "max_iterations=${MAX_ITERATIONS} evidence=${EVIDENCE_DIR}"
log "log=${LOG}"

run_script() {
  local name="$1"
  shift
  log ""
  log "[RUN] ${name} $*"
  set +e
  bash "${PIPE_DIR}/${name}" "$@" 2>&1 | tee -a "${LOG}"
  local rc=${PIPESTATUS[0]}
  set -e
  if [[ "${rc}" -eq 0 ]]; then
    pass "${name}"
    return 0
  fi
  fail "${name} exit=${rc}"
  return "${rc}"
}

sync_engine() {
  if [[ "${SYNC_ENGINE}" != "1" ]]; then
    notrun "sync-engine reason=--sync-engine not set (never default)"
    return 0
  fi
  local src="${CURSOR_ROOT}/engine/src"
  local dest="${ROOT}/engine/src"
  if [[ ! -d "${src}" ]]; then
    die "sync-engine: missing ${src} (CURSOR_ROOT=${CURSOR_ROOT})"
  fi
  mkdir -p "${dest}"
  local -a rsync_args=(-a --delete
    --exclude '__pycache__/'
    --exclude '.pytest_cache/'
    --exclude '*.egg-info/'
  )
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "[INFO] dry-run rsync -n ${src}/ → ${dest}/"
    rsync -n "${rsync_args[@]}" "${src}/" "${dest}/" | tee -a "${LOG}" || true
    pass "sync-engine dry-run (no writes)"
    return 0
  fi
  log "[INFO] rsync ${src}/ → ${dest}/"
  rsync "${rsync_args[@]}" "${src}/" "${dest}/"
  if [[ -f "${CURSOR_ROOT}/engine/pyproject.toml" ]]; then
    cp "${CURSOR_ROOT}/engine/pyproject.toml" "${ROOT}/engine/pyproject.toml"
  fi
  pass "sync-engine from ${CURSOR_ROOT}/engine"
}

run_openclaw_chain() {
  run_script 00-preflight.sh
  sync_engine

  if [[ -n "${PIN_VERSION}" || -n "${BUMP}" ]]; then
    local -a ver_args=()
    [[ -n "${PIN_VERSION}" ]] && ver_args+=(--version "${PIN_VERSION}")
    [[ -n "${BUMP}" ]] && ver_args+=(--bump "${BUMP}")
    [[ "${DRY_RUN}" == "1" ]] && ver_args+=(--dry-run)
    run_script 01-version.sh "${ver_args[@]}"
  else
    notrun "01-version.sh reason=no --version/--bump (identity check is 00-preflight)"
  fi

  local -a local_args=()
  [[ "${SKIP_SIDECAR}" == "1" ]] && local_args+=(--skip-sidecar)
  run_script 02-local-matrix.sh "${local_args[@]}"

  local run_ci=0
  case "${MODE}" in
    ci|dry-run|release) run_ci=1 ;;
  esac
  if [[ "${run_ci}" -eq 1 ]]; then
    local -a ci_args=(--max-iterations "${MAX_ITERATIONS}" --workflow CI)
    [[ "${DRY_RUN}" == "1" ]] && ci_args+=(--dry-run)
    [[ "${ALLOW_DIRTY}" == "1" ]] && ci_args+=(--allow-dirty)
    run_script 03-github-ci-loop.sh "${ci_args[@]}"
  else
    notrun "03-github-ci-loop.sh reason=--mode ${MODE}"
  fi

  if [[ "${MODE}" == "release" && "${GO}" == "1" && "${DRY_RUN}" != "1" ]]; then
    run_script 04-npm-publish.sh --go
    run_script 05-clawhub-publish.sh --go
    run_script 06-verify-chain.sh --go
  else
    if [[ "${MODE}" == "release" && "${GO}" != "1" ]]; then
      notrun "04-npm-publish.sh reason=no --go LIVE_PUBLISH=forbidden"
      notrun "05-clawhub-publish.sh reason=no --go LIVE_PUBLISH=forbidden"
    else
      notrun "04-npm-publish.sh reason=mode=${MODE} go=${GO} dry_run=${DRY_RUN}"
      notrun "05-clawhub-publish.sh reason=mode=${MODE} go=${GO} dry_run=${DRY_RUN}"
    fi
    local -a vargs=()
    [[ "${DRY_RUN}" == "1" ]] && vargs+=(--dry-run)
    if [[ "${MODE}" == "dry-run" || "${MODE}" == "release" ]]; then
      run_script 06-verify-chain.sh "${vargs[@]}"
    else
      notrun "06-verify-chain.sh reason=--mode ${MODE}"
    fi
  fi
}

run_cursor_fanout() {
  if [[ "${SKIP_CURSOR}" == "1" ]]; then
    notrun "07-cursor-fanout.sh reason=--skip-cursor"
    return 0
  fi
  local -a args=(--max-iterations "${MAX_ITERATIONS}")
  [[ "${DRY_RUN}" == "1" ]] && args+=(--dry-run)
  [[ "${ALLOW_DIRTY}" == "1" ]] && args+=(--allow-dirty)
  run_script 07-cursor-fanout.sh "${args[@]}"
}

case "${TARGET}" in
  openclaw)
    run_openclaw_chain
    notrun "07-cursor-fanout.sh reason=--target openclaw"
    ;;
  cursor)
    notrun "openclaw chain reason=--target cursor"
    run_cursor_fanout
    ;;
  all)
    run_openclaw_chain
    run_cursor_fanout
    ;;
esac

log ""
log "=== TALLY ==="
log "target=${TARGET} mode=${MODE} go=${GO} LIVE_PUBLISH=${LIVE_PUBLISH}"
log "log=${LOG}"

if [[ "${MODE}" == "release" && "${GO}" != "1" ]]; then
  fail "DEPLOY_HELD: --mode release requires --go for registry writes"
  log "LIVE_PUBLISH=forbidden"
  log "no npm publish; no clawhub package publish"
  exit 2
fi

pass "pipeline complete mode=${MODE} target=${TARGET}"
exit 0
