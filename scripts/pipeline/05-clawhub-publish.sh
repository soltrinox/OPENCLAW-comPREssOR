#!/usr/bin/env bash
# CLI publish of the packed .tgz. Never the website folder picker.
# Require --go + clawhub whoami. Same semver as npm / package.json.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/05-clawhub-publish-${TS}.log.txt"

GO="${PIPELINE_GO:-0}"
DRY_RUN="${DRY_RUN:-0}"
SOURCE_REPO="soltrinox/OPENCLAW-comPREssOR"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/05-clawhub-publish.sh --go [--dry-run]

Publishes the packed soltrinox-openclaw-compressor-<ver>.tgz via the ClawHub CLI.
Never opens or uses the website folder picker (do not run stage-clawhub-upload.sh).
Requires --go (or PIPELINE_GO=1) and a successful `clawhub whoami`.
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
    --go) GO=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

: >"${LOG}"
log "=== 05-clawhub-publish ==="
log "ts_utc=${TS} go=${GO} dry_run=${DRY_RUN}"
log "note=CLI .tgz only; never website folder picker"

CLAWHUB=()
if command -v clawhub >/dev/null 2>&1; then
  CLAWHUB=(clawhub)
elif command -v npx >/dev/null 2>&1; then
  CLAWHUB=(npx clawhub)
else
  CLAWHUB=()
fi

if [[ "${GO}" != "1" ]]; then
  export LIVE_PUBLISH=forbidden
  fail "DEPLOY_HELD: ClawHub publish requires --go (LIVE_PUBLISH=forbidden)"
  log "log=${LOG}"
  exit 2
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  export LIVE_PUBLISH=forbidden
  notrun "clawhub-publish reason=--dry-run (LIVE_PUBLISH=forbidden)"
  log "log=${LOG}"
  exit 0
fi

if [[ "${#CLAWHUB[@]}" -eq 0 ]]; then
  die "clawhub not on PATH and npx unavailable"
fi

log "clawhub whoami"
set +e
"${CLAWHUB[@]}" whoami 2>&1 | tee -a "${LOG}"
WHOAMI_RC=${PIPESTATUS[0]}
set -e
if [[ "${WHOAMI_RC}" -ne 0 ]]; then
  die "clawhub whoami failed — log in before live publish (CLI session, not website picker)"
fi
pass "clawhub whoami"

export EVIDENCE_DIR
export LIVE_PUBLISH=1
log "ensuring packed .tgz via scripts/pack.sh"
bash "${ROOT}/scripts/pack.sh" 2>&1 | tee -a "${LOG}"

PKG_NAME="$(node -p 'require("./package.json").name.replace(/^@/, "").replace(/\//g, "-")')"
PKG_VERSION="$(node -p 'require("./package.json").version')"
EXPECTED_TGZ="${ROOT}/${PKG_NAME}-${PKG_VERSION}.tgz"
if [[ ! -f "${EXPECTED_TGZ}" ]]; then
  die "missing packed tarball ${EXPECTED_TGZ}"
fi
pass "tarball=${EXPECTED_TGZ}"

SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")"
log "LIVE_PUBLISH=1 CLI publish of ${EXPECTED_TGZ}"
log "source-repo=${SOURCE_REPO} source-commit=${SOURCE_COMMIT}"

set +e
"${CLAWHUB[@]}" package publish "${EXPECTED_TGZ}" --no-input --json \
  --source-repo "${SOURCE_REPO}" \
  --source-commit "${SOURCE_COMMIT}" 2>&1 | tee -a "${LOG}"
PUB_RC=${PIPESTATUS[0]}
set -e

if [[ "${PUB_RC}" -ne 0 ]]; then
  log "[INFO] tarball path rejected or failed; extracting tgz and publishing package dir via CLI (not website picker)"
  TMPDIR_PUB="$(mktemp -d "${TMPDIR:-/tmp}/clawhub-cli-tgz.XXXXXX")"
  tar -xzf "${EXPECTED_TGZ}" -C "${TMPDIR_PUB}"
  if [[ ! -d "${TMPDIR_PUB}/package" ]]; then
    die "extracted tarball missing package/ dir"
  fi
  set +e
  "${CLAWHUB[@]}" package publish "${TMPDIR_PUB}/package" --no-input --json \
    --source-repo "${SOURCE_REPO}" \
    --source-commit "${SOURCE_COMMIT}" 2>&1 | tee -a "${LOG}"
  PUB_RC=${PIPESTATUS[0]}
  set -e
  rm -rf "${TMPDIR_PUB}"
fi

if [[ "${PUB_RC}" -eq 0 ]]; then
  pass "clawhub CLI publish ${PKG_NAME}@${PKG_VERSION}"
  log "log=${LOG}"
  exit 0
fi

fail "clawhub package publish exit=${PUB_RC}"
log "log=${LOG}"
exit "${PUB_RC}"
