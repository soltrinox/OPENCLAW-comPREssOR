#!/usr/bin/env bash
# Local predeploy matrix: wrap scripts/predeploy-smoke.sh (do not rewrite it).
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/02-local-matrix-${TS}.log.txt"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/02-local-matrix.sh [--skip-sidecar]

Wraps scripts/predeploy-smoke.sh: vitest, pack-tsc, sidecar, probe, manage-load,
pack, clawhub validate/dry-run. Never live-publishes (LIVE_PUBLISH=forbidden).

Environment: EVIDENCE_DIR, ENGINE_IMPL, SKIP_SIDECAR, SKIP_GATEWAY, OPENCLAW_BIN
EOF
}

SKIP_SIDECAR="${SKIP_SIDECAR:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    *)
      echo "[FAIL] Unknown option: $1 (try --help)" | tee -a "${LOG}"
      exit 1
      ;;
  esac
done

: >"${LOG}"
{
  echo "=== 02-local-matrix ==="
  echo "ts_utc=${TS} root=${ROOT}"
  echo "LIVE_PUBLISH=forbidden"
  echo "SKIP_SIDECAR=${SKIP_SIDECAR}"
  echo "ENGINE_IMPL=${ENGINE_IMPL:-sidecar}"
  echo "EVIDENCE_DIR=${EVIDENCE_DIR}"
} | tee -a "${LOG}"

export EVIDENCE_DIR
export SKIP_SIDECAR
export ENGINE_IMPL="${ENGINE_IMPL:-sidecar}"
export SKIP_GATEWAY="${SKIP_GATEWAY:-0}"
export LIVE_PUBLISH=forbidden

set +e
bash "${ROOT}/scripts/predeploy-smoke.sh" 2>&1 | tee -a "${LOG}"
RC=${PIPESTATUS[0]}
set -e

if [[ "${RC}" -eq 0 ]]; then
  echo "[PASS] predeploy-smoke.sh" | tee -a "${LOG}"
  echo "log=${LOG}" | tee -a "${LOG}"
  exit 0
fi

echo "[FAIL] predeploy-smoke.sh exit=${RC}" | tee -a "${LOG}"
echo "log=${LOG}" | tee -a "${LOG}"
exit "${RC}"
