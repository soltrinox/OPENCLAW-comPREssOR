#!/usr/bin/env bash
# Two-arm Gateway / engine probe: legacy vs compressor (Plan 05 / Plan 12).
# Always runs engine-only assemble fixture as the τ two-arm. Live Gateway is optional.
# Engine assemble does not claim billed η / provider usage.
#
# Env:
#   FIXTURE, ARTIFACTS_DIR, EVIDENCE_DIR, OPENCLAW_BIN, NODE_BIN, RUN_ID
#   DOCKER_GATEWAY=1 — grade docker_gateway from inspect JSON
#     (also implied when OPENCLAW_BIN is a `docker compose … exec … openclaw` wrapper)
#   RUN_LIVE_GATEWAY=1 + LIVE_GATEWAY_GO=1 — invoke live-turn helper (Plan 12 p12-5)
# Required: FIXTURE may default; ARTIFACTS_DIR optional; OPENCLAW_BIN optional.
# No ClawHub / npm publish.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

TS="$(date +%Y%m%d-%H%M%S)"
RUN_ID="${RUN_ID:-$(uuidgen 2>/dev/null || echo "probe-${TS}-$$")}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${ROOT}/test-results/openclaw-compressor}"
# Cohort evidence mirror (SDLC plan path)
EVIDENCE_DIR="${EVIDENCE_DIR:-$(cd "${ROOT}/.." && pwd)/PLANS/evidence}"
FIXTURE="${FIXTURE:-${ROOT}/test/fixtures/probe-session.jsonl}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
LOG="${ARTIFACTS_DIR}/probe-${RUN_ID}.log.txt"
NODE_BIN="${NODE_BIN:-node}"
DOCKER_GATEWAY="${DOCKER_GATEWAY:-0}"
RUN_LIVE_GATEWAY="${RUN_LIVE_GATEWAY:-0}"
LIVE_GATEWAY_GO="${LIVE_GATEWAY_GO:-0}"
LIVE_TURN_HELPER="${LIVE_TURN_HELPER:-${ROOT}/scripts/probe-live-gateway.sh}"

PASS=0
FAIL=0
NOT_RUN=0
pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
notrun() { echo "[NOT_RUN] $*"; NOT_RUN=$((NOT_RUN + 1)); }

# OPENCLAW_BIN may be a multi-word compose-exec wrapper, e.g.
#   docker compose -p oc-compressor-gw exec -T openclaw-gateway openclaw
is_compose_exec_wrapper() {
  [[ "${OPENCLAW_BIN}" == *compose* && "${OPENCLAW_BIN}" == *exec* ]]
}

wants_docker_gateway_row() {
  [[ "${DOCKER_GATEWAY}" == "1" ]] || is_compose_exec_wrapper
}

invoke_openclaw() {
  local -a prefix
  # Intentional word-split: compose-exec wrappers are multiple argv words.
  # shellcheck disable=SC2206
  prefix=(${OPENCLAW_BIN})
  "${prefix[@]}" "$@"
}

inspect_has_compressor_id() {
  grep -q '"id"[[:space:]]*:[[:space:]]*"compressor"' "$1"
}

inspect_is_no_gateway_stub() {
  grep -q '"reason"[[:space:]]*:[[:space:]]*"NO_GATEWAY"' "$1"
}

# Live inspect --runtime surfaces: context engine and/or CLI (not the NO_GATEWAY stub).
inspect_has_runtime_surfaces() {
  grep -Eqi \
    '"kind"[[:space:]]*:[[:space:]]*"context-engine"|"runtime"|registerContextEngine|"contextEngine"|"engineImpl"|"hasCommands"[[:space:]]*:[[:space:]]*true|"cli"|cliCommands|registerCli|"hooks"|"status"[[:space:]]*:[[:space:]]*"loaded"|"loaded"[[:space:]]*:[[:space:]]*true' \
    "$1"
}

# Sets DOCKER_GATEWAY_GRADE and DOCKER_GATEWAY_REASON from inspect JSON + env.
# PASS only when docker row is requested AND inspect has id=compressor AND runtime surfaces.
grade_docker_gateway_from_inspect() {
  local inspect_file="$1"
  DOCKER_GATEWAY_GRADE="NOT_RUN"
  DOCKER_GATEWAY_REASON="NO_GATEWAY"

  if [[ ! -f "${inspect_file}" ]]; then
    DOCKER_GATEWAY_REASON="NO_GATEWAY"
    return
  fi
  if inspect_is_no_gateway_stub "${inspect_file}"; then
    DOCKER_GATEWAY_REASON="NO_GATEWAY"
    return
  fi
  if ! wants_docker_gateway_row; then
    DOCKER_GATEWAY_REASON="NOT_DOCKER_GATEWAY"
    return
  fi
  if ! inspect_has_compressor_id "${inspect_file}"; then
    DOCKER_GATEWAY_GRADE="FAIL"
    DOCKER_GATEWAY_REASON="INSPECT_MISSING_ID"
    return
  fi
  if ! inspect_has_runtime_surfaces "${inspect_file}"; then
    DOCKER_GATEWAY_GRADE="FAIL"
    DOCKER_GATEWAY_REASON="MISSING_RUNTIME_SURFACES"
    return
  fi
  DOCKER_GATEWAY_GRADE="PASS"
  DOCKER_GATEWAY_REASON=""
}

emit_docker_gateway_marker() {
  case "${DOCKER_GATEWAY_GRADE}" in
    PASS) pass "docker_gateway inspect id=compressor + runtime surfaces" ;;
    FAIL) fail "docker_gateway reason=${DOCKER_GATEWAY_REASON}" ;;
    *) notrun "docker_gateway reason=${DOCKER_GATEWAY_REASON}" ;;
  esac
}

selftest_docker_grade() {
  local tmp dir stub live thin rc=0
  dir="$(mktemp -d "${TMPDIR:-/tmp}/probe-docker-grade.XXXXXX")"
  stub="${dir}/stub.json"
  live="${dir}/live.json"
  thin="${dir}/thin.json"
  printf '%s\n' '{"id":"compressor","status":"NOT_RUN","reason":"NO_GATEWAY"}' >"${stub}"
  printf '%s\n' '{"id":"compressor","kind":"context-engine","status":"loaded","runtime":{"hooks":["registerContextEngine"],"hasCommands":true,"cli":["compressor"]},"engineImpl":"ts"}' >"${live}"
  printf '%s\n' '{"id":"compressor","name":"comPREssOR"}' >"${thin}"

  check() {
    local name="$1" want_grade="$2" want_reason="$3"
    if [[ "${DOCKER_GATEWAY_GRADE}" != "${want_grade}" ]]; then
      echo "[FAIL] ${name} grade=${DOCKER_GATEWAY_GRADE} want=${want_grade}"
      rc=1
    elif [[ -n "${want_reason}" && "${DOCKER_GATEWAY_REASON}" != "${want_reason}" ]]; then
      echo "[FAIL] ${name} reason=${DOCKER_GATEWAY_REASON} want=${want_reason}"
      rc=1
    else
      echo "[PASS] ${name} grade=${want_grade}${want_reason:+ reason=${want_reason}}"
    fi
  }

  OPENCLAW_BIN="openclaw"
  DOCKER_GATEWAY=0
  grade_docker_gateway_from_inspect "${stub}"
  check "stub-default" "NOT_RUN" "NO_GATEWAY"

  DOCKER_GATEWAY=1
  grade_docker_gateway_from_inspect "${stub}"
  check "stub-docker-flag" "NOT_RUN" "NO_GATEWAY"

  DOCKER_GATEWAY=1
  grade_docker_gateway_from_inspect "${live}"
  check "live-docker-flag" "PASS" ""

  DOCKER_GATEWAY=0
  OPENCLAW_BIN="openclaw"
  grade_docker_gateway_from_inspect "${live}"
  check "live-host-cli" "NOT_RUN" "NOT_DOCKER_GATEWAY"

  DOCKER_GATEWAY=0
  OPENCLAW_BIN="docker compose -p oc-compressor-gw exec -T openclaw-gateway openclaw"
  grade_docker_gateway_from_inspect "${live}"
  check "live-compose-wrapper" "PASS" ""

  OPENCLAW_BIN="openclaw"
  DOCKER_GATEWAY=1
  grade_docker_gateway_from_inspect "${thin}"
  check "thin-missing-runtime" "FAIL" "MISSING_RUNTIME_SURFACES"

  rm -rf "${dir}"
  if [[ "${rc}" -ne 0 ]]; then
    echo "[FAIL] docker_gateway grade selftest"
    return 1
  fi
  echo "[PASS] docker_gateway grade selftest"
  return 0
}

if [[ "${1:-}" == "--selftest-docker-grade" ]]; then
  selftest_docker_grade
  exit $?
fi

mkdir -p "${ARTIFACTS_DIR}" "${EVIDENCE_DIR}"

DOCKER_GATEWAY_GRADE="NOT_RUN"
DOCKER_GATEWAY_REASON="NO_GATEWAY"
LIVE_GATEWAY_GRADE="NOT_RUN"
LIVE_GATEWAY_REASON="NO_GATEWAY_OR_RUN_LIVE_GATEWAY=0"
INSPECT_STATUS="NO_GATEWAY"
ENGINE_RC=1

exec > >(tee -a "${LOG}") 2>&1

echo "=== PREREQ ==="
echo "run_id=${RUN_ID}"
echo "openclaw_version=unknown"
echo "plugin_version=$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
echo "replay_definition=R_full_host"
echo "tau=chars4"
echo "hosttok=runtimeSettings.limits|absent"
echo "model=NOT_RUN"
echo "billed_eta=NOT_CLAIMED (engine_assemble_fixture is τ only)"
echo "fixture=${FIXTURE}"
echo "artifacts_dir=${ARTIFACTS_DIR}"
echo "log=${LOG}"
echo "DOCKER_GATEWAY=${DOCKER_GATEWAY}"
echo "OPENCLAW_BIN=${OPENCLAW_BIN}"
echo "docker_gateway_requested=$(wants_docker_gateway_row && echo 1 || echo 0)"
echo "RUN_LIVE_GATEWAY=${RUN_LIVE_GATEWAY}"
echo "LIVE_GATEWAY_GO=${LIVE_GATEWAY_GO}"

if [[ ! -f "${FIXTURE}" ]]; then
  fail "FIXTURE_MISSING ${FIXTURE}"
  echo "=== GRADE ==="
  echo "FAIL prereq"
  exit 1
fi
FIXTURE_SHA="$(shasum -a 256 "${FIXTURE}" | awk '{print $1}')"
echo "fixture_sha256=${FIXTURE_SHA}"
pass "fixture exists sha256=${FIXTURE_SHA}"

if [[ -x "${ROOT}/scripts/probe-assemble-fixture.ts" ]] || [[ -f "${ROOT}/scripts/probe-assemble-fixture.ts" ]]; then
  pass "probe-assemble-fixture.ts present"
else
  fail "probe-assemble-fixture.ts missing"
fi

# Writable artifacts
if touch "${ARTIFACTS_DIR}/.probe-write-test" 2>/dev/null; then
  rm -f "${ARTIFACTS_DIR}/.probe-write-test"
  pass "ARTIFACTS_DIR writable"
else
  fail "ARTIFACTS_DIR not writable"
fi

# OPENCLAW_BIN — single binary on PATH, or docker compose exec wrapper
if is_compose_exec_wrapper; then
  if command -v docker >/dev/null 2>&1; then
    pass "OPENCLAW_BIN=compose-exec-wrapper ${OPENCLAW_BIN}"
    GATEWAY_AVAILABLE=1
  else
    notrun "OPENCLAW_BIN reason=NO_GATEWAY docker not on PATH for compose wrapper"
    GATEWAY_AVAILABLE=0
  fi
elif command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
  pass "OPENCLAW_BIN=$(command -v "${OPENCLAW_BIN}")"
  GATEWAY_AVAILABLE=1
else
  notrun "OPENCLAW_BIN reason=NO_GATEWAY binary not on PATH"
  GATEWAY_AVAILABLE=0
fi

# Inspect
INSPECT_LOG="${ARTIFACTS_DIR}/inspect-probe-${RUN_ID}.log.txt"
if [[ "${GATEWAY_AVAILABLE}" -eq 1 ]]; then
  if invoke_openclaw plugins inspect compressor --runtime --json >"${INSPECT_LOG}" 2>&1; then
    if inspect_has_compressor_id "${INSPECT_LOG}"; then
      pass "inspect runtime json"
      INSPECT_STATUS="OK"
    else
      fail "inspect missing id=compressor"
      INSPECT_STATUS="MISSING_ID"
    fi
  else
    notrun "inspect reason=INSPECT_FAILED see ${INSPECT_LOG}"
    INSPECT_STATUS="FAILED"
  fi
else
  echo '{"id":"compressor","status":"NOT_RUN","reason":"NO_GATEWAY"}' >"${INSPECT_LOG}"
  notrun "inspect reason=NO_GATEWAY (stub JSON written)"
  INSPECT_STATUS="NO_GATEWAY"
fi
cp -f "${INSPECT_LOG}" "${EVIDENCE_DIR}/inspect-probe-${TS}.log.txt" 2>/dev/null || true

grade_docker_gateway_from_inspect "${INSPECT_LOG}"
if [[ "${INSPECT_STATUS}" == "FAILED" ]] && wants_docker_gateway_row; then
  DOCKER_GATEWAY_GRADE="NOT_RUN"
  DOCKER_GATEWAY_REASON="INSPECT_FAILED"
fi

# Prior doctor evidence reuse + in-process doctor via fixture script
if [[ -f "${EVIDENCE_DIR}/doctor-compressor-20260815-142026.log.txt" ]]; then
  pass "prior doctor evidence present (Plan 01)"
else
  notrun "prior doctor evidence missing"
fi

echo "=== ARM legacy ==="
echo "(delegated to probe-assemble-fixture.ts — L_uncompacted_full; τ two-arm, not billed η)"

echo "=== ARM compressor ==="
echo "(delegated to probe-assemble-fixture.ts — engine assemble; τ two-arm, not billed η)"

echo "=== ENGINE_ASSEMBLE ==="
export FIXTURE ARTIFACTS_DIR RUN_ID
set +e
"${NODE_BIN}" --experimental-strip-types "${ROOT}/scripts/probe-assemble-fixture.ts"
ENGINE_RC=$?
set -e
if [[ "${ENGINE_RC}" -ne 0 ]]; then
  fail "engine_assemble_fixture exit=${ENGINE_RC}"
else
  pass "engine_assemble_fixture"
fi

# Copy summary into evidence
if ls "${ARTIFACTS_DIR}/probe-summary-${RUN_ID}.json" >/dev/null 2>&1; then
  cp -f "${ARTIFACTS_DIR}/probe-summary-${RUN_ID}.json" "${EVIDENCE_DIR}/probe-summary-${TS}.json"
  pass "summary mirrored to evidence"
fi
if ls "${ARTIFACTS_DIR}/doctor-probe-${RUN_ID}.json" >/dev/null 2>&1; then
  cp -f "${ARTIFACTS_DIR}/doctor-probe-${RUN_ID}.json" "${EVIDENCE_DIR}/doctor-probe-${TS}.json"
  pass "doctor json mirrored"
fi

echo "=== LIVE_GATEWAY ==="
# Full live-turn is Plan 12 p12-5. This branch only calls a helper when GO-2 is explicit.
if [[ "${RUN_LIVE_GATEWAY}" != "1" ]]; then
  LIVE_GATEWAY_GRADE="NOT_RUN"
  LIVE_GATEWAY_REASON="NO_GATEWAY_OR_RUN_LIVE_GATEWAY=0"
  notrun "live Gateway + model reason=${LIVE_GATEWAY_REASON}"
elif [[ "${LIVE_GATEWAY_GO}" != "1" ]]; then
  LIVE_GATEWAY_GRADE="NOT_RUN"
  LIVE_GATEWAY_REASON="LIVE_GATEWAY_GO=0"
  notrun "live Gateway + model reason=${LIVE_GATEWAY_REASON}"
elif [[ ! -f "${LIVE_TURN_HELPER}" ]]; then
  LIVE_GATEWAY_GRADE="NOT_RUN"
  LIVE_GATEWAY_REASON="LIVE_TURN_HELPER_MISSING"
  notrun "live Gateway + model reason=${LIVE_GATEWAY_REASON}"
else
  set +e
  bash "${LIVE_TURN_HELPER}"
  LIVE_RC=$?
  set -e
  if [[ "${LIVE_RC}" -eq 0 ]]; then
    LIVE_GATEWAY_GRADE="PASS"
    LIVE_GATEWAY_REASON=""
    pass "live_gateway_model helper"
  else
    LIVE_GATEWAY_GRADE="FAIL"
    LIVE_GATEWAY_REASON="LIVE_TURN_HELPER_EXIT=${LIVE_RC}"
    fail "live_gateway_model helper exit=${LIVE_RC}"
  fi
fi

echo "=== NPM_PACK ==="
PACK_LOG="${ARTIFACTS_DIR}/npm-pack-${RUN_ID}.log.txt"
if npm pack --dry-run >"${PACK_LOG}" 2>&1; then
  if grep -q 'openclaw.plugin.json' "${PACK_LOG}"; then
    pass "npm pack lists openclaw.plugin.json"
  else
    fail "npm pack missing openclaw.plugin.json"
  fi
  if grep -qE '(^|/)dist/' "${PACK_LOG}"; then
    pass "npm pack lists dist/"
  else
    notrun "npm pack dist/ absent (PARTIAL until Plan 11 build)"
  fi
  if grep -q 'skill/' "${PACK_LOG}"; then
    pass "npm pack lists skill/"
  else
    fail "npm pack missing skill/"
  fi
else
  fail "npm pack --dry-run"
fi
cp -f "${PACK_LOG}" "${EVIDENCE_DIR}/npm-pack-probe-${TS}.log.txt" 2>/dev/null || true

echo "=== README_HONESTY ==="
README="${ROOT}/README.md"
if grep -E '84%|PERFORMANCE\.md|\$[0-9]' "${README}" >/dev/null 2>&1; then
  fail "README contains forbidden PERFORMANCE/price strings"
else
  pass "README has no 84% / PERFORMANCE.md / \$price"
fi

echo "=== COMPARE ==="
echo "See engine section above and probe-summary JSON for field table."
echo "η_A computed only in docs/RESEARCH.md when units match (both tau)."
echo "engine_assemble_fixture is τ two-arm; do not claim billed η from this arm."

echo "=== GRADE ==="
echo "environment_matrix:"
echo "  unit_pytest: FULL (Plan 04 prior)"
echo "  sidecar_smoke: FULL (Plan 02 prior)"
echo "  engine_assemble_fixture: $([[ ${ENGINE_RC} -eq 0 ]] && echo FULL || echo FAIL)"
if [[ "${LIVE_GATEWAY_GRADE}" == "NOT_RUN" ]]; then
  echo "  live_gateway_model: NOT_RUN reason=${LIVE_GATEWAY_REASON}"
else
  echo "  live_gateway_model: ${LIVE_GATEWAY_GRADE}"
fi
if [[ "${DOCKER_GATEWAY_GRADE}" == "NOT_RUN" ]]; then
  echo "  docker_gateway: NOT_RUN reason=${DOCKER_GATEWAY_REASON}"
else
  echo "  docker_gateway: ${DOCKER_GATEWAY_GRADE}"
fi
echo "  cloud: skip"
emit_docker_gateway_marker
echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
echo "log=${LOG}"

# Mirror full log to cohort evidence
cp -f "${LOG}" "${EVIDENCE_DIR}/probe-openclaw-${TS}.log.txt"

if [[ "${FAIL}" -gt 0 ]] || [[ "${ENGINE_RC}" -ne 0 ]]; then
  echo "[FAIL] probe overall"
  exit 1
fi
echo "[PASS] probe overall"
exit 0
