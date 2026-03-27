#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Run a second Concord instance with a separate data directory.
# The first instance should already be running via `cargo tauri dev`.
# This instance shares the Vite frontend but has its own identity + database.

export CONCORD_DATA_DIR="${CONCORD_DATA_DIR:-/tmp/concord-instance-2}"
export WEBKIT_DISABLE_DMABUF_RENDERER=1

mkdir -p "$CONCORD_DATA_DIR"

echo "=== Concord Instance 2 ==="
echo "Data: $CONCORD_DATA_DIR"
echo ""

# Check if Vite is running
if ! curl -s --max-time 1 "http://localhost:1420" >/dev/null 2>&1; then
    echo "ERROR: Vite not running on port 1420."
    echo "Start the first instance with 'cargo tauri dev' first."
    exit 1
fi

echo "Vite detected on :1420 — launching second node..."
echo ""

# Use cargo tauri dev — the start-frontend.sh script will detect Vite
# is already running and skip starting a second one.
cargo tauri dev "$@"
