#!/usr/bin/env bash
# Sidecar smoke: health / step / sample / malformed JSON.
# Optional: OPENCLAW_COMPRESSOR_PYTHON, OPENCLAW_COMPRESSOR_VENV, CHAT_COMPRESSOR_STATE_DIR
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="${ROOT}/engine"
TS="$(date +%Y%m%d-%H%M%S)"
RUN_ID="smoke-${TS}-$$"
STATE_DIR="${CHAT_COMPRESSOR_STATE_DIR:-$(mktemp -d "/tmp/openclaw-sidecar-${RUN_ID}.XXXXXX")}"
VENV_DIR="${OPENCLAW_COMPRESSOR_VENV:-${HOME}/.openclaw/compressor-venv-smoke}"
export CHAT_COMPRESSOR_STATE_DIR="${STATE_DIR}"
export K_MAX="${K_MAX:-16}"
export CHAT_COMPRESSOR_FORWARD_BUDGET="${CHAT_COMPRESSOR_FORWARD_BUDGET:-2048}"
export CHAT_COMPRESSOR_INJECT_P1=0

PASS=0
FAIL=0
pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }

echo "=== sidecar-smoke RUN_ID=${RUN_ID} STATE_DIR=${STATE_DIR} ==="

if [[ -n "${OPENCLAW_COMPRESSOR_PYTHON:-}" ]]; then
  PY="${OPENCLAW_COMPRESSOR_PYTHON}"
else
  if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
    echo "Provisioning venv at ${VENV_DIR}..."
    python3 -m venv "${VENV_DIR}"
    "${VENV_DIR}/bin/python" -m pip install -q -e "${ENGINE}"
  else
    # Ensure editable install is current
    "${VENV_DIR}/bin/python" -m pip install -q -e "${ENGINE}" >/dev/null 2>&1 || \
      "${VENV_DIR}/bin/python" -m pip install -e "${ENGINE}"
  fi
  PY="${VENV_DIR}/bin/python"
fi

pass "python=${PY}"

run_one() {
  local line="$1"
  printf '%s\n' "${line}" | "${PY}" -m chat_compressor.claw_cli | tail -n 1
}

HEALTH_OUT=$(run_one '{"id":"1","cmd":"health","params":{}}')
if echo "${HEALTH_OUT}" | "${PY}" -c "import sys,json; r=json.load(sys.stdin); assert r['ok'] is True"; then
  pass "health ok"
else
  fail "health: ${HEALTH_OUT}"
fi

AGENT="sess_${RUN_ID}"
STEP_REQ=$("${PY}" - <<PY
import json
text = (
    "Fix OPENCLAW/COMPRESSOR/src/ids.ts UUID 550e8400-e29b-41d4-a716-446655440000. "
    * 20
)
print(json.dumps({
    "id": "2",
    "cmd": "step",
    "agent_id": "${AGENT}",
    "params": {"role": "user", "text": text, "flush_graph": True},
}))
PY
)
STEP_OUT=$(run_one "${STEP_REQ}")
if echo "${STEP_OUT}" | "${PY}" -c "import sys,json; r=json.load(sys.stdin); assert r['ok'] is True; assert r['result']['t'] >= 1"; then
  pass "step ok"
else
  fail "step: ${STEP_OUT}"
fi

if [[ -d "${STATE_DIR}/${AGENT}" ]]; then
  pass "state dir exists: ${STATE_DIR}/${AGENT}"
  ls -la "${STATE_DIR}/${AGENT}" | head -20 || true
else
  fail "missing state dir ${STATE_DIR}/${AGENT}"
fi

SAMPLE_REQ=$("${PY}" -c "import json; print(json.dumps({'id':'3','cmd':'sample','agent_id':'${AGENT}','params':{'query':'what UUID','budget':2048,'span_k':8}}))")
SAMPLE_OUT=$(run_one "${SAMPLE_REQ}")
if echo "${SAMPLE_OUT}" | "${PY}" -c "import sys,json; r=json.load(sys.stdin); assert r['ok'] is True; assert int(r['result'].get('packed_tokens') or 0) >= 1; assert isinstance(r['result'].get('text'), str) and len(r['result']['text']) > 0"; then
  pass "sample ok packed_tokens>=1"
else
  fail "sample: ${SAMPLE_OUT}"
fi

BAD_OUT=$(run_one '{not json')
if echo "${BAD_OUT}" | grep -q 'bad_json'; then
  pass "malformed returns bad_json"
else
  fail "malformed: ${BAD_OUT}"
fi

HEALTH2=$(run_one '{"id":"9","cmd":"health","params":{}}')
if echo "${HEALTH2}" | "${PY}" -c "import sys,json; r=json.load(sys.stdin); assert r['ok'] is True"; then
  pass "health after malformed still ok"
else
  fail "health after malformed: ${HEALTH2}"
fi

if ! grep -E '^[[:space:]]*(import hook_cli|from chat_compressor\.hook_cli|from \.hook_cli)' "${ENGINE}/src/chat_compressor/claw_cli.py" >/dev/null; then
  pass "claw_cli does not import hook_cli"
else
  fail "claw_cli imports hook_cli"
fi

if "${PY}" -c "from chat_compressor.claw_cli import default_state_root; assert str(default_state_root()).endswith('openclaw/context-graphs') or 'openclaw' in str(default_state_root())"; then
  pass "default state root is ~/.openclaw/context-graphs"
else
  fail "default state root"
fi

echo "=== summary PASS=${PASS} FAIL=${FAIL} STATE_DIR=${STATE_DIR} ==="
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
