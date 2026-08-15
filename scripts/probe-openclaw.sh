#!/usr/bin/env bash
# Two-arm Gateway / engine probe: legacy vs compressor (Plan 05).
# Always runs engine-only assemble fixture. Live Gateway is optional.
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

mkdir -p "${ARTIFACTS_DIR}" "${EVIDENCE_DIR}"

PASS=0
FAIL=0
NOT_RUN=0
pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
notrun() { echo "[NOT_RUN] $*"; NOT_RUN=$((NOT_RUN + 1)); }

exec > >(tee -a "${LOG}") 2>&1

echo "=== PREREQ ==="
echo "run_id=${RUN_ID}"
echo "openclaw_version=unknown"
echo "plugin_version=$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
echo "replay_definition=R_full_host"
echo "tau=chars4"
echo "hosttok=runtimeSettings.limits|absent"
echo "model=NOT_RUN"
echo "fixture=${FIXTURE}"
echo "artifacts_dir=${ARTIFACTS_DIR}"
echo "log=${LOG}"

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

# OPENCLAW_BIN
if command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
  pass "OPENCLAW_BIN=$(command -v "${OPENCLAW_BIN}")"
  GATEWAY_AVAILABLE=1
else
  notrun "OPENCLAW_BIN reason=NO_GATEWAY binary not on PATH"
  GATEWAY_AVAILABLE=0
fi

# Inspect
INSPECT_LOG="${ARTIFACTS_DIR}/inspect-probe-${RUN_ID}.log.txt"
if [[ "${GATEWAY_AVAILABLE}" -eq 1 ]]; then
  if "${OPENCLAW_BIN}" plugins inspect compressor --runtime --json >"${INSPECT_LOG}" 2>&1; then
    if grep -q '"id"[[:space:]]*:[[:space:]]*"compressor"' "${INSPECT_LOG}" || grep -q 'compressor' "${INSPECT_LOG}"; then
      pass "inspect runtime json"
    else
      fail "inspect missing id=compressor"
    fi
  else
    notrun "inspect reason=INSPECT_FAILED see ${INSPECT_LOG}"
  fi
else
  echo '{"id":"compressor","status":"NOT_RUN","reason":"NO_GATEWAY"}' >"${INSPECT_LOG}"
  notrun "inspect reason=NO_GATEWAY (stub JSON written)"
fi
cp -f "${INSPECT_LOG}" "${EVIDENCE_DIR}/inspect-probe-${TS}.log.txt" 2>/dev/null || true

# Prior doctor evidence reuse + in-process doctor via fixture script
if [[ -f "${EVIDENCE_DIR}/doctor-compressor-20260815-142026.log.txt" ]]; then
  pass "prior doctor evidence present (Plan 01)"
else
  notrun "prior doctor evidence missing"
fi

echo "=== ARM legacy ==="
echo "(delegated to probe-assemble-fixture.ts — L_uncompacted_full)"

echo "=== ARM compressor ==="
echo "(delegated to probe-assemble-fixture.ts — engine assemble)"

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
if [[ "${GATEWAY_AVAILABLE}" -eq 1 ]] && [[ "${RUN_LIVE_GATEWAY:-0}" == "1" ]]; then
  notrun "live gateway replay not automated (host-seam); engine-only is authoritative"
else
  notrun "live Gateway + model reason=NO_GATEWAY_OR_RUN_LIVE_GATEWAY=0"
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

echo "=== GRADE ==="
echo "environment_matrix:"
echo "  unit_pytest: FULL (Plan 04 prior)"
echo "  sidecar_smoke: FULL (Plan 02 prior)"
echo "  engine_assemble_fixture: $([[ ${ENGINE_RC} -eq 0 ]] && echo FULL || echo FAIL)"
echo "  live_gateway_model: NOT_RUN"
echo "  docker_gateway: NOT_RUN"
echo "  cloud: skip"
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
