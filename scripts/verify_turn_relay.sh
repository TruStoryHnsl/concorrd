#!/usr/bin/env bash
# verify_turn_relay.sh — run the TURN relay smoke on a remote Concord deploy.
#
# Usage:
#   verify_turn_relay.sh <ssh-target> [remote-stack-dir]
#
# Env override (alternative to positional args):
#   TURN_VERIFY_HOST=<ssh-target>
#   TURN_VERIFY_DIR=<remote-stack-dir>   (default: /docker/stacks/concord)

set -euo pipefail

TARGET_HOST="${1:-${TURN_VERIFY_HOST:-}}"
REMOTE_DIR="${2:-${TURN_VERIFY_DIR:-/docker/stacks/concord}}"

if [[ -z "$TARGET_HOST" ]]; then
    printf 'error: ssh target not provided. Pass it as the first argument or set TURN_VERIFY_HOST.\n' >&2
    exit 2
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$TARGET_HOST" true 2>/dev/null; then
    printf 'error: cannot reach %s via ssh\n' "$TARGET_HOST" >&2
    exit 2
fi

ssh "$TARGET_HOST" "cd '$REMOTE_DIR' && python3 scripts/turn_relay_smoke.py --env-file .env --timeout 10"
