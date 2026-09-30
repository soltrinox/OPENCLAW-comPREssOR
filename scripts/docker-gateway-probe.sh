#!/usr/bin/env bash
# Plan 12 (p12-3) — Docker Gateway plugin load/inspect/doctor probe.
# Official OpenClaw image only. Installs inside openclaw-gateway (not cli).
# Evidence: OPENCLAW/PLANS/evidence/docker-gateway-<ts>.log.txt
# No ClawHub/npm publish. No live model turn (p12-5 / GO-2). No billed A/B.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLANS_DIR="$(cd "${ROOT}/.." && pwd)/PLANS"
DOCKER_DIR="${DOCKER_DIR:-${PLANS_DIR}/docker}"
COMPRESSOR_HOST_PATH="${COMPRESSOR_HOST_PATH:-${ROOT}}"
export COMPRESSOR_HOST_PATH
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-oc-compressor-gw}"
export COMPOSE_PROJECT_NAME
EVIDENCE_DIR="${EVIDENCE_DIR:-${PLANS_DIR}/evidence}"
TS="$(date +%Y%m%d-%H%M%S)"
RUN_ID="${RUN_ID:-$(uuidgen 2>/dev/null || echo "dgw-${TS}-$$")}"
LOG="${EVIDENCE_DIR}/docker-gateway-${TS}.log.txt"
FLOOR_VERSION="2026.7.1-2"
DEFAULT_IMAGE="ghcr.io/openclaw/openclaw:${FLOOR_VERSION}"
MAX_DOCKER_LOOPS="${MAX_DOCKER_LOOPS:-5}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

mkdir -p "${EVIDENCE_DIR}"

PASS=0
FAIL=0
NOT_RUN=0
pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
notrun() { echo "[NOT_RUN] $*"; NOT_RUN=$((NOT_RUN + 1)); }

halt() {
  echo "=== GRADE ==="
  echo "docker_gateway: FAIL"
  echo "live_gateway_model: NOT_RUN"
  echo "billed_ab: NOT_RUN"
  echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
  echo "convergence_status=HALTED"
  echo "log=${LOG}"
  exit 1
}

exec > >(tee -a "${LOG}") 2>&1

echo "=== PLAN12_DOCKER_GATEWAY_PROBE ==="
echo "run_id=${RUN_ID}"
echo "ts=${TS}"
echo "compressor=${COMPRESSOR_HOST_PATH}"
echo "docker_dir=${DOCKER_DIR}"
echo "project=${COMPOSE_PROJECT_NAME}"
echo "engineImpl=ts"
echo "log=${LOG}"
echo "floor=${FLOOR_VERSION}"
echo "LIVE_PUBLISH=forbidden"
echo "live_turn=skipped (p12-5 / GO-2)"

compose() {
  docker compose -p "${COMPOSE_PROJECT_NAME}" --project-directory "${DOCKER_DIR}" \
    -f "${DOCKER_DIR}/docker-compose.yml" "$@"
}

# Wrapper: docker compose exec -T openclaw-gateway openclaw
OPENCLAW_BIN="${DOCKER_DIR}/openclaw-bin.sh"
oc() {
  "${OPENCLAW_BIN}" "$@"
}

# Image tag 2026.7.1-2 is the floor even when CLI prints "OpenClaw 2026.7.1".
# When using latest (exact tag missing), FAIL if reported version is below floor.
version_ge_floor() {
  local reported="$1"
  local floor="$2"
  local r="${reported#OpenClaw }"
  r="${r%% *}"
  local f="${floor}"
  parse() {
    local s="$1"
    local y m p b
    y="${s%%.*}"; s="${s#*.}"
    m="${s%%.*}"; s="${s#*.}"
    p="${s%%-*}"; b="${s#"${p}"}"; b="${b#-}"
    p="${p%%.*}"
    [[ "${y}" =~ ^[0-9]+$ ]] || y=0
    [[ "${m}" =~ ^[0-9]+$ ]] || m=0
    [[ "${p}" =~ ^[0-9]+$ ]] || p=0
    [[ "${b}" =~ ^[0-9]+$ ]] || b=0
    echo "${y} ${m} ${p} ${b}"
  }
  local ry rm rp rb fy fm fp fb
  read -r ry rm rp rb <<<"$(parse "${r}")"
  read -r fy fm fp fb <<<"$(parse "${f}")"
  if (( ry != fy )); then (( ry > fy )); return $?; fi
  if (( rm != fm )); then (( rm > fm )); return $?; fi
  if (( rp != fp )); then (( rp > fp )); return $?; fi
  (( rb >= fb ))
}

# --- PREREQ ---
echo "=== PREREQ ==="
if ! command -v docker >/dev/null 2>&1; then
  fail "docker binary missing"
  halt
fi
if ! docker info >/dev/null 2>&1; then
  fail "docker daemon not reachable"
  docker info 2>&1 | tail -20 || true
  halt
fi
pass "docker daemon"
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose missing"
  halt
fi
pass "docker compose $(docker compose version --short 2>/dev/null || true)"

if [[ ! -f "${DOCKER_DIR}/docker-compose.yml" ]]; then
  fail "compose missing at ${DOCKER_DIR}/docker-compose.yml"
  halt
fi
pass "compose file present"

if [[ ! -x "${DOCKER_DIR}/setup.sh" ]]; then
  fail "setup.sh missing or not executable at ${DOCKER_DIR}/setup.sh"
  halt
fi
pass "setup.sh present"

if [[ ! -x "${OPENCLAW_BIN}" ]]; then
  fail "OPENCLAW_BIN wrapper missing ${OPENCLAW_BIN}"
  halt
fi
pass "OPENCLAW_BIN=${OPENCLAW_BIN}"

if [[ ! -f "${DOCKER_DIR}/.env" ]]; then
  if [[ -f "${DOCKER_DIR}/.env.example" ]]; then
    cp "${DOCKER_DIR}/.env.example" "${DOCKER_DIR}/.env"
    pass "created .env from .env.example"
  else
    fail ".env and .env.example missing"
    halt
  fi
else
  pass ".env present"
fi

set -a
# shellcheck disable=SC1091
source "${DOCKER_DIR}/.env"
set +a
export COMPRESSOR_HOST_PATH="${COMPRESSOR_HOST_PATH:-${ROOT}}"
OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-${DEFAULT_IMAGE}}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-${GATEWAY_PORT}}"
echo "OPENCLAW_IMAGE=${OPENCLAW_IMAGE}"
echo "COMPRESSOR_HOST_PATH=${COMPRESSOR_HOST_PATH}"

if [[ ! -f "${COMPRESSOR_HOST_PATH}/openclaw.plugin.json" ]]; then
  fail "plugin manifest missing at ${COMPRESSOR_HOST_PATH}/openclaw.plugin.json"
  halt
fi
pass "plugin manifest present"

# --- BUILD (dist/ must exist before install -l) ---
echo "=== PLUGIN_BUILD ==="
BUILD_LOG="${EVIDENCE_DIR}/docker-gateway-build-${TS}.log.txt"
set +e
(
  cd "${COMPRESSOR_HOST_PATH}"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  npm run build
) >"${BUILD_LOG}" 2>&1
BUILD_RC=$?
set -e
tail -20 "${BUILD_LOG}" || true
if [[ "${BUILD_RC}" -ne 0 ]]; then
  fail "npm run build rc=${BUILD_RC} see ${BUILD_LOG}"
  halt
fi
if [[ ! -f "${COMPRESSOR_HOST_PATH}/dist/index.js" ]]; then
  fail "dist/index.js missing after build"
  halt
fi
pass "npm run build → dist/index.js"

# --- IMAGE PIN / PULL ---
echo "=== IMAGE_PIN ==="
IMAGE_TAG_LOG="${EVIDENCE_DIR}/docker-gateway-image-${TS}.log.txt"
USED_LATEST=0
{
  echo "requested_image=${OPENCLAW_IMAGE}"
  echo "floor=${FLOOR_VERSION}"
  echo "--- docker pull ---"
} >"${IMAGE_TAG_LOG}"
set +e
docker pull "${OPENCLAW_IMAGE}" >>"${IMAGE_TAG_LOG}" 2>&1
PULL_RC=$?
set -e
if [[ "${PULL_RC}" -ne 0 ]]; then
  echo "exact tag pull failed; trying ghcr.io/openclaw/openclaw:latest"
  USED_LATEST=1
  OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
  set +e
  docker pull "${OPENCLAW_IMAGE}" >>"${IMAGE_TAG_LOG}" 2>&1
  PULL_RC=$?
  set -e
  if [[ "${PULL_RC}" -ne 0 ]]; then
    fail "docker pull failed for pin and latest — see ${IMAGE_TAG_LOG}"
    cat "${IMAGE_TAG_LOG}"
    halt
  fi
  # Persist fallback so compose uses latest
  if grep -qE '^OPENCLAW_IMAGE=' "${DOCKER_DIR}/.env"; then
    sed -i.bak "s|^OPENCLAW_IMAGE=.*|OPENCLAW_IMAGE=${OPENCLAW_IMAGE}|" "${DOCKER_DIR}/.env"
    rm -f "${DOCKER_DIR}/.env.bak"
  fi
  export OPENCLAW_IMAGE
fi
pass "docker pull ${OPENCLAW_IMAGE}"
cat "${IMAGE_TAG_LOG}"

VERSION_OUT="$(docker run --rm --entrypoint openclaw "${OPENCLAW_IMAGE}" --version 2>&1 | head -5 || true)"
echo "container_openclaw_version=${VERSION_OUT}"
{
  echo "--- openclaw --version ---"
  echo "${VERSION_OUT}"
  docker image inspect "${OPENCLAW_IMAGE}" --format 'Id={{.Id}} Created={{.Created}} User={{.Config.User}}' || true
} >>"${IMAGE_TAG_LOG}"

if [[ "${USED_LATEST}" -eq 1 ]]; then
  if version_ge_floor "${VERSION_OUT}" "${FLOOR_VERSION}"; then
    pass "latest reported ${VERSION_OUT} >= floor ${FLOOR_VERSION}"
  else
    fail "latest reported ${VERSION_OUT} below floor ${FLOOR_VERSION}"
    halt
  fi
else
  pass "image tag pin ${OPENCLAW_IMAGE} (CLI reports: ${VERSION_OUT})"
fi

# --- UP / HEALTH ---
echo "=== COMPOSE_UP ==="
echo "==> setup.sh (onboard skip-channels + up)"
set +e
"${DOCKER_DIR}/setup.sh"
SETUP_RC=$?
set -e
if [[ "${SETUP_RC}" -ne 0 ]]; then
  fail "setup.sh exit=${SETUP_RC}"
  compose logs --no-color --tail=120 openclaw-gateway || true
  halt
fi
pass "setup.sh"

iteration=0
healthy=0
while (( iteration < MAX_DOCKER_LOOPS )); do
  iteration=$((iteration + 1))
  echo "docker_loop=${iteration}/${MAX_DOCKER_LOOPS}"
  set +e
  compose up -d openclaw-gateway
  UP_RC=$?
  set -e
  if [[ "${UP_RC}" -ne 0 ]]; then
    fail "compose up exit=${UP_RC} loop=${iteration}"
    compose logs --no-color --tail=80 openclaw-gateway || true
    continue
  fi
  for _ in $(seq 1 40); do
    st="$(compose ps --format '{{.Health}}' 2>/dev/null | head -1 || true)"
    echo "health_status=${st}"
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/healthz" || echo 000)"
    echo "healthz_http=${code}"
    if [[ "${st}" == "healthy" ]] || [[ "${code}" == "200" ]]; then
      healthy=1
      break
    fi
    sleep 3
  done
  if [[ "${healthy}" -eq 1 ]]; then
    pass "gateway healthy loop=${iteration}"
    break
  fi
  fail "gateway not healthy loop=${iteration}"
  compose logs --no-color --tail=120 openclaw-gateway || true
done

if [[ "${healthy}" -ne 1 ]]; then
  halt
fi

HEALTH_LOG="${EVIDENCE_DIR}/docker-gateway-health-${TS}.log.txt"
{
  echo "GET http://127.0.0.1:${GATEWAY_PORT}/healthz"
  curl -fsS -D - "http://127.0.0.1:${GATEWAY_PORT}/healthz" || echo "healthz_fail"
  echo
  echo "GET http://127.0.0.1:${GATEWAY_PORT}/startupz"
  curl -fsS -D - "http://127.0.0.1:${GATEWAY_PORT}/startupz" || echo "startupz_fail"
} >"${HEALTH_LOG}" 2>&1 || true
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/healthz" || echo 000)"
if [[ "${code}" == "200" ]]; then
  pass "HTTP healthz code=200"
else
  fail "HTTP healthz code=${code} see ${HEALTH_LOG}"
  compose logs --no-color --tail=80 openclaw-gateway || true
  halt
fi

# Confirm wrapper talks to gateway, not cli
echo "=== OPENCLAW_BIN ==="
set +e
BIN_VER="$(oc --version 2>&1)"
BIN_RC=$?
set -e
echo "${BIN_VER}"
if [[ "${BIN_RC}" -eq 0 ]]; then
  pass "OPENCLAW_BIN exec on openclaw-gateway --version"
else
  fail "OPENCLAW_BIN exec failed rc=${BIN_RC}"
  halt
fi

# --- INSTALL (gateway container) ---
echo "=== PLUGINS_INSTALL ==="
INSTALL_LOG="${EVIDENCE_DIR}/docker-gateway-install-${TS}.log.txt"
set +e
oc plugins install -l /plugin >"${INSTALL_LOG}" 2>&1
INSTALL_RC=$?
set -e
cat "${INSTALL_LOG}"
if [[ "${INSTALL_RC}" -eq 0 ]]; then
  pass "plugins install -l /plugin (openclaw-gateway)"
else
  echo "install -l /plugin rc=${INSTALL_RC}; retry copy into throwaway volume (no git-tree chown)"
  set +e
  compose exec -T openclaw-gateway sh -lc \
    'mkdir -p /home/node/.openclaw/plugin-src && cp -a /plugin/. /home/node/.openclaw/plugin-src/' \
    >>"${INSTALL_LOG}" 2>&1
  oc plugins install -l /home/node/.openclaw/plugin-src >>"${INSTALL_LOG}" 2>&1
  INSTALL_RC=$?
  set -e
  cat "${INSTALL_LOG}"
  if [[ "${INSTALL_RC}" -eq 0 ]]; then
    pass "plugins install -l from throwaway volume copy"
  else
    fail "plugins install -l rc=${INSTALL_RC} see ${INSTALL_LOG}"
  fi
fi

# Slot + engineImpl=ts
echo "=== SLOT_CONFIG ==="
SLOT_LOG="${EVIDENCE_DIR}/docker-gateway-slot-${TS}.log.txt"
set +e
oc config set --batch-json \
  '[{"path":"plugins.slots.contextEngine","value":"compressor"},{"path":"plugins.entries.compressor.enabled","value":true},{"path":"plugins.entries.compressor.config.engineImpl","value":"ts"}]' \
  >"${SLOT_LOG}" 2>&1
SLOT_RC=$?
if [[ "${SLOT_RC}" -ne 0 ]]; then
  oc plugins enable compressor >>"${SLOT_LOG}" 2>&1
  oc config set plugins.slots.contextEngine compressor >>"${SLOT_LOG}" 2>&1
  oc config set plugins.entries.compressor.enabled true >>"${SLOT_LOG}" 2>&1
  oc config set plugins.entries.compressor.config.engineImpl ts >>"${SLOT_LOG}" 2>&1
  SLOT_RC=$?
fi
set -e
cat "${SLOT_LOG}"
if [[ "${SLOT_RC}" -eq 0 ]]; then
  pass "slot contextEngine=compressor engineImpl=ts enabled=true"
else
  fail "config set slot/engineImpl rc=${SLOT_RC}"
fi

echo "=== RESTART ==="
compose restart openclaw-gateway
restarted=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/healthz" || echo 000)"
  if [[ "${code}" == "200" ]]; then
    pass "gateway restarted healthz=200"
    restarted=1
    break
  fi
  sleep 2
done
if [[ "${restarted}" -ne 1 ]]; then
  fail "gateway not healthy after restart"
  compose logs --no-color --tail=80 openclaw-gateway || true
fi

# --- INSPECT ---
echo "=== INSPECT ==="
INSPECT_LOG="${EVIDENCE_DIR}/docker-gateway-inspect-${TS}.log.txt"
set +e
oc plugins inspect compressor --runtime --json >"${INSPECT_LOG}" 2>&1
INSPECT_RC=$?
set -e
cat "${INSPECT_LOG}"
DOCKER_GATEWAY_GRADE="FAIL"
if [[ "${INSPECT_RC}" -eq 0 ]] && grep -qE '"id"[[:space:]]*:[[:space:]]*"compressor"' "${INSPECT_LOG}"; then
  pass "inspect --runtime id=compressor"
  DOCKER_GATEWAY_GRADE="PASS"
else
  fail "inspect missing id=compressor rc=${INSPECT_RC}"
fi

# --- DOCTOR ---
echo "=== DOCTOR ==="
DOCTOR_LOG="${EVIDENCE_DIR}/docker-gateway-doctor-${TS}.log.txt"
set +e
oc compressor doctor >"${DOCTOR_LOG}" 2>&1
DOCTOR_RC=$?
set -e
cat "${DOCTOR_LOG}"
if [[ "${DOCTOR_RC}" -eq 0 ]]; then
  pass "openclaw compressor doctor exit=0"
else
  fail "openclaw compressor doctor exit=${DOCTOR_RC}"
  DOCKER_GATEWAY_GRADE="FAIL"
fi

echo "=== LIVE_GATEWAY_MODEL ==="
LIVE_GATEWAY_GO="${LIVE_GATEWAY_GO:-0}"
BILLED_AB_GO="${BILLED_AB_GO:-0}"
HAS_PROVIDER=0
if [[ -n "${OPENAI_API_KEY:-}" ]] || [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  HAS_PROVIDER=1
fi
if [[ "${LIVE_GATEWAY_GO}" == "1" ]] && [[ "${HAS_PROVIDER}" -eq 1 ]]; then
  notrun "live_gateway_model reason=GO-2 set but automated live-turn helper not wired this session — operator one-shot via Control UI / openclaw agent"
else
  notrun "live_gateway_model reason=LIVE_GATEWAY_GO!=1 or no provider key in throwaway compose .env (GO-2)"
fi
echo "=== BILLED_AB ==="
if [[ "${BILLED_AB_GO}" == "1" ]]; then
  notrun "billed_ab reason=GO-3 set but Gateway usage A/B not automated; named units would be provider_prompt_tokens + provider_completion_tokens (never USD; never mix with tau)"
else
  notrun "billed_ab reason=BILLED_AB_GO!=1 (GO-3); named units: provider_prompt_tokens + provider_completion_tokens — never USD, never mix with tau"
fi

echo "=== PROBE_MATRIX ==="
export DOCKER_GATEWAY=1
# Multi-word compose-exec form so probe-openclaw.sh grades docker_gateway PASS
export OPENCLAW_BIN="docker compose -p ${COMPOSE_PROJECT_NAME} --project-directory ${DOCKER_DIR} -f ${DOCKER_DIR}/docker-compose.yml exec -T openclaw-gateway openclaw"
export RUN_LIVE_GATEWAY=0
export LIVE_GATEWAY_GO
set +e
"${ROOT}/scripts/probe-openclaw.sh"
PROBE_RC=$?
set -e
if [[ "${PROBE_RC}" -eq 0 ]]; then
  pass "probe-openclaw.sh DOCKER_GATEWAY matrix"
else
  fail "probe-openclaw.sh rc=${PROBE_RC}"
fi

echo "=== GRADE ==="
echo "environment_matrix:"
echo "  docker_gateway: ${DOCKER_GATEWAY_GRADE}"
echo "  live_gateway_model: NOT_RUN"
echo "  billed_ab: NOT_RUN"
echo "  cloud: skip"
echo "image_tag=${OPENCLAW_IMAGE}"
echo "cli_version=${VERSION_OUT}"
echo "engineImpl=ts"
echo "PASS=${PASS} FAIL=${FAIL} NOT_RUN=${NOT_RUN}"
echo "log=${LOG}"
echo "inspect_log=${INSPECT_LOG}"
echo "doctor_log=${DOCTOR_LOG}"

echo "=== TEARDOWN_NOTE ==="
echo "To stop: docker compose -p ${COMPOSE_PROJECT_NAME} --project-directory ${DOCKER_DIR} down"
echo "Volume delete requires explicit operator confirm (oc-compressor-gw-openclaw)."

if [[ "${DOCKER_GATEWAY_GRADE}" == "PASS" ]] && [[ "${FAIL}" -eq 0 ]]; then
  echo "convergence_status=CONVERGED"
  echo "[PASS] docker_gateway load row"
  exit 0
fi
echo "convergence_status=NOT_CONVERGED"
echo "[FAIL] docker_gateway load row"
exit 1
