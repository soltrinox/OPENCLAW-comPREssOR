#!/usr/bin/env bash
# Publish @eni6ma/compressor-oc to the public npm registry (eni6ma org).
# Requires NPM_TOKEN in the environment. Never embeds or commits tokens.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_NAME="@eni6ma/compressor-oc"
FIRST_PUBLISH_VERSION="0.1.0"

: "${NPM_TOKEN:?NPM_TOKEN must be set (npm automation/access token for eni6ma org)}"

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
  NPMRC_PATH="$(mktemp "${TMPDIR:-/tmp}/eni6ma-npmrc.XXXXXX")"
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
npm publish --access public

echo "[publish] verify: npm view"
npm view "$EXPECTED_NAME" name version repository.url

echo "[PASS] published $EXPECTED_NAME@$VERSION"
