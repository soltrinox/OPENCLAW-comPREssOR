#!/usr/bin/env bash
# Predeploy smoke orchestrator: offline tests → pack-tsc → sidecar → probe →
# manage-load → pack → clawhub validate/dry-run → optional gateway.
# Never runs live clawhub package publish or npm publish.
# LIVE_PUBLISH=forbidden
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

TS="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/../PLANS/evidence}"
mkdir -p "${EVIDENCE_DIR}"
LOG="${EVIDENCE_DIR}/predeploy-smoke-${TS}.log.txt"

ENGINE_IMPL="${ENGINE_IMPL:-sidecar}"
SKIP_SIDECAR="${SKIP_SIDECAR:-0}"
SKIP_GATEWAY="${SKIP_GATEWAY:-0}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

PASS=0
FAIL=0
NOT_RUN=0
REQUIRED_FAILED=0

pass() {
  echo "[PASS] $*"
  PASS=$((PASS + 1))
}
fail() {
  echo "[FAIL] $*"
  FAIL=$((FAIL + 1))
}
notrun() {
  echo "[NOT_RUN] $*"
  NOT_RUN=$((NOT_RUN + 1))
}

# Tee all output to master evidence log
exec > >(tee -a "${LOG}") 2>&1

echo "=== PREDEPLOY SMOKE ==="
echo "LIVE_PUBLISH=forbidden"
echo "ts=${TS}"
echo "root=${ROOT}"
echo "evidence_dir=${EVIDENCE_DIR}"
echo "log=${LOG}"
echo "ENGINE_IMPL=${ENGINE_IMPL}"
echo "SKIP_SIDECAR=${SKIP_SIDECAR}"
echo "SKIP_GATEWAY=${SKIP_GATEWAY}"
echo ""

# Run a required stage; on non-zero exit mark FAIL and exit fail-fast.
run_required() {
  local name="$1"
  shift
  echo "[RUN] ${name}"
  set +e
  "$@"
  local rc=$?
  set -e
  if [[ "${rc}" -eq 0 ]]; then
    pass "${name}"
  else
    fail "${name} exit=${rc}"
    REQUIRED_FAILED=1
    echo ""
    echo "=== TALLY (fail-fast) ==="
    echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
    echo "log=${LOG}"
    echo "LIVE_PUBLISH=forbidden"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# 1. vitest
# ---------------------------------------------------------------------------
run_required "vitest" npm test

# ---------------------------------------------------------------------------
# 2. pack-tsc (shippable surface only — same as pack.sh)
# ---------------------------------------------------------------------------
run_required "pack-tsc" npx tsc -p tsconfig.pack.json

# ---------------------------------------------------------------------------
# 3. sidecar (required unless ENGINE_IMPL=ts or SKIP_SIDECAR=1)
# ---------------------------------------------------------------------------
if [[ "${SKIP_SIDECAR}" == "1" ]] || [[ "${ENGINE_IMPL}" == "ts" ]]; then
  echo "[RUN] sidecar"
  notrun "sidecar reason=ENGINE_IMPL=${ENGINE_IMPL} SKIP_SIDECAR=${SKIP_SIDECAR}"
else
  run_required "sidecar" bash scripts/sidecar-smoke.sh
fi

# ---------------------------------------------------------------------------
# 4. probe
# ---------------------------------------------------------------------------
run_required "probe" env "EVIDENCE_DIR=${EVIDENCE_DIR}" bash scripts/probe-openclaw.sh

# ---------------------------------------------------------------------------
# 5. manage-load
# ---------------------------------------------------------------------------
run_required "manage-load" env "EVIDENCE_DIR=${EVIDENCE_DIR}" bash scripts/test-manage-load.sh

# ---------------------------------------------------------------------------
# 6. pack
# ---------------------------------------------------------------------------
run_required "pack" env "EVIDENCE_DIR=${EVIDENCE_DIR}" bash scripts/pack.sh

# ---------------------------------------------------------------------------
# 7–8. clawhub (required if clawhub on PATH or invocable via npx; else NOT_RUN)
# ---------------------------------------------------------------------------
CLAWHUB_PRESENT=0
CLAWHUB_VIA=()
if command -v clawhub >/dev/null 2>&1; then
  CLAWHUB_PRESENT=1
  CLAWHUB_VIA=(clawhub)
elif npx clawhub >/dev/null 2>&1; then
  # npx prints usage and exits 0 for bare `clawhub` (Plan 11 dry-run path)
  CLAWHUB_PRESENT=1
  CLAWHUB_VIA=(npx clawhub)
fi

if [[ "${CLAWHUB_PRESENT}" -eq 1 ]]; then
  VALIDATE_CHILD="${EVIDENCE_DIR}/clawhub-validate-predeploy-${TS}.log.txt"
  echo "[RUN] clawhub-validate"
  set +e
  "${CLAWHUB_VIA[@]}" package validate . --json >"${VALIDATE_CHILD}" 2>&1
  VALIDATE_RC=$?
  set -e
  cat "${VALIDATE_CHILD}"
  if [[ "${VALIDATE_RC}" -eq 0 ]]; then
    pass "clawhub-validate"
  else
    fail "clawhub-validate exit=${VALIDATE_RC} see ${VALIDATE_CHILD}"
    REQUIRED_FAILED=1
    echo ""
    echo "=== TALLY (fail-fast) ==="
    echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
    echo "log=${LOG}"
    echo "LIVE_PUBLISH=forbidden"
    exit 1
  fi

  DRY_CHILD="${EVIDENCE_DIR}/clawhub-dry-run-predeploy-${TS}.log.txt"
  SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")"
  echo "[RUN] clawhub-dry-run"
  set +e
  "${CLAWHUB_VIA[@]}" package publish . --dry-run --json --no-input \
    --source-repo soltrinox/openclaw-compressor \
    --source-commit "${SOURCE_COMMIT}" >"${DRY_CHILD}" 2>&1
  DRY_RC=$?
  set -e
  cat "${DRY_CHILD}"
  if [[ "${DRY_RC}" -eq 0 ]]; then
    pass "clawhub-dry-run"
  else
    fail "clawhub-dry-run exit=${DRY_RC} see ${DRY_CHILD}"
    REQUIRED_FAILED=1
    echo ""
    echo "=== TALLY (fail-fast) ==="
    echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
    echo "log=${LOG}"
    echo "LIVE_PUBLISH=forbidden"
    exit 1
  fi
else
  echo "[RUN] clawhub-validate"
  notrun "clawhub-validate reason=clawhub not on PATH and npx clawhub unavailable"
  echo "[RUN] clawhub-dry-run"
  notrun "clawhub-dry-run reason=clawhub not on PATH and npx clawhub unavailable"
fi

# ---------------------------------------------------------------------------
# 9. gateway (never required)
# ---------------------------------------------------------------------------
echo "[RUN] gateway"
if [[ "${SKIP_GATEWAY}" == "1" ]]; then
  notrun "gateway reason=SKIP_GATEWAY=1"
elif ! command -v "${OPENCLAW_BIN}" >/dev/null 2>&1; then
  notrun "gateway reason=NO_GATEWAY ${OPENCLAW_BIN} not on PATH"
else
  GATEWAY_CHILD="${EVIDENCE_DIR}/gateway-predeploy-${TS}.log.txt"
  set +e
  {
    echo "# gateway optional stage"
    "${OPENCLAW_BIN}" plugins install -l .
    echo "---"
    "${OPENCLAW_BIN}" plugins inspect compressor --runtime --json
  } >"${GATEWAY_CHILD}" 2>&1
  GW_RC=$?
  set -e
  cat "${GATEWAY_CHILD}"
  if [[ "${GW_RC}" -eq 0 ]]; then
    pass "gateway (optional)"
  else
    # Optional: do not fail the required bar
    notrun "gateway reason=INSTALL_OR_INSPECT_FAILED exit=${GW_RC} see ${GATEWAY_CHILD}"
  fi
fi

# ---------------------------------------------------------------------------
# Footer
# ---------------------------------------------------------------------------
echo ""
echo "=== TALLY ==="
echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
echo "log=${LOG}"
echo "LIVE_PUBLISH=forbidden"

if [[ "${REQUIRED_FAILED}" -ne 0 ]] || [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
