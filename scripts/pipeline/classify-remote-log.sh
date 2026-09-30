#!/usr/bin/env bash
# Classify a captured GitHub Actions / publish log. Prints one token to stdout:
#   KNOWN:npm-e403 | KNOWN:clawhub-whoami | KNOWN:typecheck | KNOWN:validate-hardError | UNKNOWN
# Does not auto-commit. Arbitrary test failures are UNKNOWN (fail closed).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/pipeline/classify-remote-log.sh <log-path>

Known tokens (first match wins):
  KNOWN:npm-e403            npm 403 / 2FA / granular-token policy
  KNOWN:clawhub-whoami      ClawHub auth / whoami failure
  KNOWN:validate-hardError  clawhub package validate hardError
  KNOWN:typecheck           tsc / npm run typecheck
  UNKNOWN                   including arbitrary test failures — do not auto-commit
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

LOG_PATH="${1:?path required (try --help)}"
if [[ ! -f "$LOG_PATH" ]]; then
  echo "UNKNOWN" >&2
  echo "[FAIL] classify-remote-log: not a file: ${LOG_PATH}" >&2
  echo "UNKNOWN"
  exit 1
fi

if grep -Eiq 'E403|403 Forbidden|Two-factor authentication|granular access token|bypass 2fa' "$LOG_PATH"; then
  echo "KNOWN:npm-e403"
  exit 0
fi

if grep -Eiq 'clawhub[[:space:]]+whoami|whoami.*fail|not logged in|authentication required|unauthorized' "$LOG_PATH"; then
  if grep -Eiq 'clawhub|ClawHub' "$LOG_PATH"; then
    echo "KNOWN:clawhub-whoami"
    exit 0
  fi
fi

if grep -Eq 'hardError|"hardError"' "$LOG_PATH"; then
  echo "KNOWN:validate-hardError"
  exit 0
fi

if grep -Eq 'error TS[0-9]+' "$LOG_PATH" || grep -Eiq 'npm run typecheck|tsc --noEmit|Typecheck' "$LOG_PATH"; then
  if grep -Eiq 'error TS[0-9]+|typecheck failed|tsc.*failed|error TS' "$LOG_PATH"; then
    echo "KNOWN:typecheck"
    exit 0
  fi
fi

echo "UNKNOWN"
exit 0
