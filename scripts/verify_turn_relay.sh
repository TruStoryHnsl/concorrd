#!/usr/bin/env bash
# verify_turn_relay.sh — run the TURN relay smoke on a remote Concord deploy.

set -euo pipefail

TARGET_HOST="${1:-orrgate}"
REMOTE_DIR="${2:-/docker/stacks/concord}"

if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$TARGET_HOST" true 2>/dev/null; then
    printf 'error: cannot reach %s via ssh\n' "$TARGET_HOST" >&2
    exit 2
fi

ssh "$TARGET_HOST" "cd '$REMOTE_DIR' && python3 scripts/turn_relay_smoke.py --env-file .env"
