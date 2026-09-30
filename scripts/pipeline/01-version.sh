#!/usr/bin/env bash
# Pin or bump package.json, then rewrite README / openclaw.plugin.json / CHANGELOG together.
set -euo pipefail

PIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${PIPE_DIR}/../.." && pwd)"
cd "${ROOT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-${ROOT}/test-results/pipeline}"
mkdir -p "${EVIDENCE_DIR}"
TS="${PIPELINE_TS:-$(date -u +%Y%m%d-%H%M%S)}"
LOG="${EVIDENCE_DIR}/01-version-${TS}.log.txt"

PIN_VERSION="${PIPELINE_VERSION:-}"
BUMP="${PIPELINE_BUMP:-}"
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/01-version.sh [--version X.Y.Z | --bump [patch|minor|major]] [--dry-run]

Rewrites together:
  package.json, openclaw.plugin.json, README.md package pins, CHANGELOG.md latest heading.

Does not git commit or tag. Does not publish.
EOF
}

log() { printf '%s\n' "$*" | tee -a "${LOG}"; }
pass() { log "[PASS] $*"; }
fail() { log "[FAIL] $*"; }
die() { fail "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
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
    *)
      die "Unknown option: $1 (try --help)"
      ;;
  esac
done

: >"${LOG}"
log "=== 01-version ==="
log "ts_utc=${TS} dry_run=${DRY_RUN}"

if [[ -n "${PIN_VERSION}" && -n "${BUMP}" ]]; then
  die "pass only one of --version or --bump"
fi
if [[ -z "${PIN_VERSION}" && -z "${BUMP}" ]]; then
  die "need --version X.Y.Z or --bump [patch|minor|major]"
fi
if [[ -n "${PIN_VERSION}" && ! "${PIN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "--version must be semver X.Y.Z (got ${PIN_VERSION})"
fi
if [[ -n "${BUMP}" && ! "${BUMP}" =~ ^(patch|minor|major)$ ]]; then
  die "--bump must be patch|minor|major (got ${BUMP})"
fi

CURRENT="$(node -p 'require("./package.json").version')"
log "current package.json version=${CURRENT}"

if [[ -n "${PIN_VERSION}" ]]; then
  TARGET="${PIN_VERSION}"
  NPM_ARGS=(npm version "${TARGET}" --no-git-tag-version --allow-same-version)
else
  TARGET="<after npm version ${BUMP}>"
  NPM_ARGS=(npm version "${BUMP}" --no-git-tag-version)
fi

log "planned: ${NPM_ARGS[*]}"
log "then sync openclaw.plugin.json, README.md, CHANGELOG.md to the new version"

if [[ "${DRY_RUN}" == "1" ]]; then
  pass "dry-run: would pin/bump and rewrite identity files together (no writes)"
  exit 0
fi

"${NPM_ARGS[@]}"
TARGET="$(node -p 'require("./package.json").version')"
log "package.json now ${TARGET}"

IDENTITY_VERSION="${TARGET}" node --input-type=commonjs -e '
const fs = require("fs");
const ver = process.env.IDENTITY_VERSION;
const pluginPath = "openclaw.plugin.json";
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.version = ver;
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
readme = readme.replace(
  /@soltrinox\/openclaw-compressor@\d+\.\d+\.\d+/g,
  "@soltrinox/openclaw-compressor@" + ver
);
fs.writeFileSync(readmePath, readme);

const changelogPath = "CHANGELOG.md";
let changelog = fs.readFileSync(changelogPath, "utf8");
const heading = "## " + ver;
const headingRe = new RegExp("^## " + ver.replace(/\./g, "\\.") + "$", "m");
if (!headingRe.test(changelog)) {
  const section =
    heading + "\n\n" +
    "Identity lock rewrite to " + ver + ". Live npm/ClawHub publish is not claimed by this section.\n\n";
  if (!changelog.startsWith("# Changelog")) {
    changelog = "# Changelog\n\n" + section + changelog;
  } else {
    changelog = changelog.replace(/^# Changelog\n+/, "# Changelog\n\n" + section);
  }
  fs.writeFileSync(changelogPath, changelog);
}
'

PLUGIN_VER="$(node -p 'require("./openclaw.plugin.json").version')"
README_BAD="$(grep -oE '@soltrinox/openclaw-compressor@[0-9]+\.[0-9]+\.[0-9]+' README.md | grep -v "@soltrinox/openclaw-compressor@${TARGET}" || true)"
CHANGELOG_VER="$(sed -nE 's/^## ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' CHANGELOG.md | head -1)"

[[ "${PLUGIN_VER}" == "${TARGET}" ]] || die "plugin.json still ${PLUGIN_VER}"
[[ -z "${README_BAD}" ]] || die "README still has ${README_BAD}"
[[ "${CHANGELOG_VER}" == "${TARGET}" ]] || die "CHANGELOG latest still ${CHANGELOG_VER}"

pass "identity files rewritten together to ${TARGET}"
log "log=${LOG}"
exit 0
