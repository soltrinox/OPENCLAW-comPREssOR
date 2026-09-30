#!/usr/bin/env bash
# Bounded local CI-mirror → git push origin HEAD (no force) → gh run watch.
# Port of comPREssOR/scripts/verify-ci-push-loop.sh for OPENCLAW-comPREssOR.
# Known-fix only (see classify-remote-log.sh). Max 5. No arbitrary auto-commit.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

MAX_ITERATIONS="${MAX_ITERATIONS:-5}"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
AUTO_COMMIT_FIXES=0
DRY_RUN="${DRY_RUN:-0}"
SKIP_LOCAL=0
SKIP_PUSH=0
REQUIRE_BRANCH=""
WORKFLOW_NAME="CI"
EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/03-github-ci-loop-${TS}.log.txt"
FAILED_LOG_PATH=""
LAST_SHA=""
LAST_RUN_ID=""
LAST_RUN_URL=""
LAST_CONCLUSION=""
CLASSIFY="${PIPE_DIR}/classify-remote-log.sh"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/03-github-ci-loop.sh [options]

Bounded loop (max 5): local CI-mirror → git push origin HEAD (no force) →
gh run watch → capture --log-failed → classify-remote-log.sh → known-fix only.

Options:
  --help                 Show this help
  --dry-run              Skip push/watch/commit
  --allow-dirty          Allow uncommitted local changes
  --branch NAME          Require this branch (default: any)
  --workflow NAME        Workflow name to watch (default: CI)
  --max-iterations N     Cap retries (default 5, hard max 5)
  --skip-local-build     Skip local mirror of CI steps
  --skip-push            Local build + classify only; do not push
  --auto-commit-fixes    Reserved; OpenClaw known tokens are not auto-committed

Does not force-push. Does not skip hooks. Does not auto-commit test failures.
EOF
}

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; }
fail() { log "[FAIL] $*"; }
die() { fail "$*"; exit 1; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --allow-dirty) ALLOW_DIRTY=1; shift ;;
      --branch)
        REQUIRE_BRANCH="${2:?--branch requires NAME}"
        shift 2
        ;;
      --workflow)
        WORKFLOW_NAME="${2:?--workflow requires NAME}"
        shift 2
        ;;
      --max-iterations)
        MAX_ITERATIONS="${2:?--max-iterations requires N}"
        shift 2
        ;;
      --skip-local-build) SKIP_LOCAL=1; shift ;;
      --skip-push) SKIP_PUSH=1; shift ;;
      --auto-commit-fixes) AUTO_COMMIT_FIXES=1; shift ;;
      *)
        die "Unknown option: $1 (try --help)"
        ;;
    esac
  done
  if [[ "${MAX_ITERATIONS}" =~ ^[0-9]+$ ]] && (( MAX_ITERATIONS > 0 )); then
    if (( MAX_ITERATIONS > 5 )); then
      MAX_ITERATIONS=5
      log "[INFO] --max-iterations capped at 5"
    fi
  else
    die "--max-iterations must be a positive integer"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

preflight() {
  mkdir -p "${EVIDENCE_DIR}"
  : >"${LOG}"
  log "=== 03-github-ci-loop ==="
  log "ts_utc=${TS} repo=${ROOT} max_iterations=${MAX_ITERATIONS}"
  log "dry_run=${DRY_RUN} allow_dirty=${ALLOW_DIRTY} workflow=${WORKFLOW_NAME}"
  log "LIVE_PUBLISH=${LIVE_PUBLISH:-forbidden}"

  require_cmd git
  require_cmd gh
  require_cmd node
  require_cmd npm

  if ! gh auth status >/dev/null 2>&1; then
    die "gh is not authenticated. Run: gh auth login"
  fi
  pass "gh auth OK"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  log "branch=${branch}"
  if [[ -n "${REQUIRE_BRANCH}" && "${branch}" != "${REQUIRE_BRANCH}" ]]; then
    die "On branch '${branch}', required '${REQUIRE_BRANCH}' (pass --branch ${branch} to override)"
  fi
  pass "branch=${branch}"

  if [[ -n "$(git status --porcelain)" ]]; then
    # Dry-run / skip-push never push; do not require a clean tree for local validation.
    if (( DRY_RUN == 1 )) || (( SKIP_PUSH == 1 )); then
      log "[WARN] dirty working tree allowed (dry_run=${DRY_RUN} skip_push=${SKIP_PUSH}; no push)"
    elif (( ALLOW_DIRTY == 0 )) && (( AUTO_COMMIT_FIXES == 0 )); then
      fail "Working tree is dirty. Commit first, or pass --allow-dirty."
      git status --porcelain | tee -a "${LOG}"
      exit 1
    else
      log "[WARN] dirty working tree allowed (allow_dirty=${ALLOW_DIRTY})"
    fi
  else
    pass "working tree clean"
  fi

  if (( DRY_RUN == 1 )); then
    log "[INFO] dry-run: will not push, watch, or commit"
  fi
}

local_build() {
  if (( SKIP_LOCAL == 1 )); then
    log "[INFO] skipping local build (--skip-local-build)"
    return 0
  fi
  log "--- local CI-mirror (.github/workflows/ci.yml) ---"
  export EVIDENCE_DIR
  export LIVE_PUBLISH=forbidden
  mkdir -p "${EVIDENCE_DIR}"
  npm ci
  npm test
  npm run typecheck
  npm run pack
  if command -v clawhub >/dev/null 2>&1; then
    clawhub package validate . --json
  else
    npx clawhub package validate . --json
  fi
  pass "local CI-mirror"
}

push_head() {
  if (( SKIP_PUSH == 1 )); then
    log "[INFO] skipping push (--skip-push)"
    return 0
  fi
  if (( DRY_RUN == 1 )); then
    log "[INFO] dry-run: would run: git push origin HEAD"
    return 0
  fi
  local sha
  sha="$(git rev-parse HEAD)"
  log "Pushing SHA=${sha} to origin (no force)..."
  git push origin HEAD
  pass "pushed SHA=${sha}"
}

watch_ci() {
  LAST_SHA="$(git rev-parse HEAD)"
  LAST_RUN_ID=""
  LAST_RUN_URL=""
  LAST_CONCLUSION=""

  if (( SKIP_PUSH == 1 )) || (( DRY_RUN == 1 )); then
    log "[INFO] dry-run/skip-push: not watching GitHub Actions"
    LAST_CONCLUSION="skipped"
    return 0
  fi

  log "Waiting for workflow '${WORKFLOW_NAME}' on SHA=${LAST_SHA}..."
  local attempts=0
  local run_json=""
  while (( attempts < 30 )); do
    run_json="$(
      gh run list --workflow "${WORKFLOW_NAME}" --limit 20 \
        --json databaseId,headSha,status,conclusion,url,displayTitle,createdAt \
        --jq "[.[] | select(.headSha == \"${LAST_SHA}\")][0] // empty"
    )"
    if [[ -n "${run_json}" && "${run_json}" != "null" ]]; then
      break
    fi
    attempts=$((attempts + 1))
    sleep 4
  done

  if [[ -z "${run_json}" || "${run_json}" == "null" ]]; then
    die "No '${WORKFLOW_NAME}' run found for SHA=${LAST_SHA} after waiting"
  fi

  LAST_RUN_ID="$(printf '%s' "${run_json}" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.databaseId));})')"
  LAST_RUN_URL="$(printf '%s' "${run_json}" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(d.url));})')"
  log "Found run id=${LAST_RUN_ID} url=${LAST_RUN_URL}"

  gh run watch "${LAST_RUN_ID}" --exit-status && LAST_CONCLUSION="success" || {
    local st
    st="$(gh run view "${LAST_RUN_ID}" --json conclusion,status --jq '.conclusion // .status')"
    LAST_CONCLUSION="${st}"
    return 1
  }
  return 0
}

capture_failed_logs() {
  FAILED_LOG_PATH="${EVIDENCE_DIR}/ci-failed-${LAST_SHA:-unknown}-${TS}.log.txt"
  log "Capturing failed logs → ${FAILED_LOG_PATH}"
  {
    echo "=== gh run view ${LAST_RUN_ID} ==="
    gh run view "${LAST_RUN_ID}" || true
    echo
    echo "=== gh run view --log-failed ==="
    gh run view "${LAST_RUN_ID}" --log-failed || true
  } >"${FAILED_LOG_PATH}" 2>&1 || true
  fail "CI conclusion=${LAST_CONCLUSION} run=${LAST_RUN_URL}"
  log "Failed log path: ${FAILED_LOG_PATH}"
}

print_known_fix_table() {
  log "Known pattern → hint (no auto-commit of arbitrary test failures):"
  log "  npm-e403            | granular automation token; see 04-npm-publish / release-publish.sh"
  log "  clawhub-whoami      | clawhub whoami / session; do not use the website folder picker"
  log "  validate-hardError  | clawhub package validate JSON hardError — fix manifest in-tree"
  log "  typecheck           | npm run typecheck / error TSnnnn — fix in-tree, then re-run"
  log "  UNKNOWN             | fail closed; do not auto-commit"
}

apply_known_fix() {
  local kind="$1"
  case "${kind}" in
    KNOWN:npm-e403)
      log "[INFO] credential/policy issue — not a tree fix. Create a granular npm automation token."
      return 1
      ;;
    KNOWN:clawhub-whoami)
      log "[INFO] ClawHub session missing — run clawhub whoami; not a tree fix."
      return 1
      ;;
    KNOWN:typecheck|KNOWN:validate-hardError)
      log "[INFO] ${kind} requires an in-tree edit; this script will not invent or auto-commit a fix."
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

success_summary() {
  pass "CI green"
  log "SHA=${LAST_SHA}"
  log "URL=${LAST_RUN_URL}"
  log "Master log: ${LOG}"
}

main_loop() {
  local iteration=1
  local failed_log classification

  while (( iteration <= MAX_ITERATIONS )); do
    log "=== iteration ${iteration}/${MAX_ITERATIONS} ==="

    local_build

    if (( SKIP_PUSH == 1 )); then
      pass "local build complete (--skip-push); not pushing"
      print_known_fix_table
      return 0
    fi

    if (( DRY_RUN == 1 )); then
      push_head
      pass "dry-run complete (no remote CI watch)"
      print_known_fix_table
      return 0
    fi

    if [[ -n "$(git status --porcelain)" ]] && (( AUTO_COMMIT_FIXES == 0 )); then
      if (( ALLOW_DIRTY == 1 )); then
        log "[WARN] pushing with dirty tree (--allow-dirty); uncommitted fixes will NOT be on remote"
      else
        die "Dirty tree before push. Commit first, or use --allow-dirty"
      fi
    fi

    push_head

    if watch_ci; then
      success_summary
      return 0
    fi

    capture_failed_logs
    failed_log="${FAILED_LOG_PATH}"
    classification="$("${CLASSIFY}" "${failed_log}")"
    log "Classification: ${classification}"
    print_known_fix_table

    if [[ "${classification}" == KNOWN:* ]]; then
      if (( AUTO_COMMIT_FIXES == 1 )) && apply_known_fix "${classification}"; then
        iteration=$((iteration + 1))
        continue
      fi
      fail "Known pattern '${classification}' is not auto-committed. Fix, commit, re-run. Log: ${failed_log}"
      exit 1
    fi

    fail "Unknown CI failure — fail closed (no arbitrary bash auto-fix)."
    fail "Log: ${failed_log}"
    exit 1
  done

  die "Exhausted max iterations (${MAX_ITERATIONS}) without green CI"
}

parse_args "$@"
preflight
main_loop
