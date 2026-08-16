#!/usr/bin/env bash
# Publish @soltrinox/openclaw-compressor to the public npm registry (soltrinox scope).
# Requires NPM_TOKEN in the environment. Never embeds or commits tokens.
# Do not run without operator GO for live registry write.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_NAME="@soltrinox/openclaw-compressor"
FIRST_PUBLISH_VERSION="0.1.0"

: "${NPM_TOKEN:?NPM_TOKEN must be set (npm granular access token for soltrinox scope; see README Publish)}"

print_e403_remediation() {
  cat >&2 <<'EOF'

[FAIL] npm publish returned 403 (2FA / token policy).

Create a Granular Access Token on https://www.npmjs.com/settings/~/tokens
  - Type: Automation
  - Packages: scope soltrinox — Read and write
  - Bypass 2FA for automation: enabled (required for CI/script publish)

Then:
  export NPM_TOKEN=<new-granular-token>
  npm run release:publish

Do not reuse classic tokens or tokens pasted into chat. Never commit tokens.
EOF
}

PKG_NAME="$(node -p 'require("./package.json").name')"
if [[ "$PKG_NAME" != "$EXPECTED_NAME" ]]; then
  echo "[FAIL] package.json name is '$PKG_NAME'; expected '$EXPECTED_NAME'" >&2
  exit 1
fi

VERSION="$(node -p 'require("./package.json").version')"
if [[ "$VERSION" == "0.0.0-dev" ]]; then
  echo "[publish] bumping version 0.0.0-dev → $FIRST_PUBLISH_VERSION"
  npm version "$FIRST_PUBLISH_VERSION" --no-git-tag-version
  VERSION="$FIRST_PUBLISH_VERSION"
fi

echo "[publish] name=$PKG_NAME version=$VERSION"

# Ephemeral auth: prefer local gitignored .npmrc; fall back to a temp file.
NPMRC_PATH=""
CLEANUP_NPMRC=0
if [[ -f "$ROOT/.npmrc" ]]; then
  NPMRC_PATH="$ROOT/.npmrc"
  echo "[publish] using existing local .npmrc (gitignored)"
else
  NPMRC_PATH="$(mktemp "${TMPDIR:-/tmp}/soltrinox-npmrc.XXXXXX")"
  CLEANUP_NPMRC=1
  umask 077
  cat >"$NPMRC_PATH" <<EOF
//registry.npmjs.org/:_authToken=\${NPM_TOKEN}
registry=https://registry.npmjs.org/
always-auth=true
EOF
  echo "[publish] wrote ephemeral npmrc: $NPMRC_PATH"
fi

cleanup() {
  if [[ "$CLEANUP_NPMRC" -eq 1 && -n "$NPMRC_PATH" && -f "$NPMRC_PATH" ]]; then
    rm -f "$NPMRC_PATH"
  fi
}
trap cleanup EXIT

export npm_config_userconfig="$NPMRC_PATH"

echo "[publish] build gate: typecheck && build && pack"
npm run typecheck
npm run build
npm run pack

echo "[publish] npm publish --access public"
PUBLISH_LOG="$(mktemp "${TMPDIR:-/tmp}/soltrinox-npm-publish.XXXXXX")"
set +e
npm publish --access public >"$PUBLISH_LOG" 2>&1
PUBLISH_RC=$?
set -e
cat "$PUBLISH_LOG"
if [[ "$PUBLISH_RC" -ne 0 ]]; then
  if grep -Eiq 'E403|403 Forbidden|Two-factor authentication|granular access token|bypass 2fa' "$PUBLISH_LOG"; then
    print_e403_remediation
  fi
  rm -f "$PUBLISH_LOG"
  exit "$PUBLISH_RC"
fi
rm -f "$PUBLISH_LOG"

echo "[publish] verify: npm view"
npm view "$EXPECTED_NAME" name version repository.url

echo "[PASS] published $EXPECTED_NAME@$VERSION"
