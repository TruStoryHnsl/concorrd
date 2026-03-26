#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Run a second Concord instance with a separate data directory.
# The first instance should already be running via `cargo tauri dev`.
# This instance shares the Vite frontend but has its own identity + database.

export CONCORD_DATA_DIR="${CONCORD_DATA_DIR:-/tmp/concord-instance-2}"
export WEBKIT_DISABLE_DMABUF_RENDERER=1

mkdir -p "$CONCORD_DATA_DIR"

echo "Starting second Concord instance (data: $CONCORD_DATA_DIR)"
echo "Make sure 'cargo tauri dev' is running in another terminal first."
echo ""

cargo run -p concord-app -- "$@"
