#!/usr/bin/env bash
# Start the Vite dev server ONLY if it isn't already running on port 1420.
# This allows multiple Tauri instances to share a single frontend server.
set -euo pipefail

PORT=1420

if curl -s --max-time 1 "http://localhost:$PORT" >/dev/null 2>&1; then
    echo "[concord] Vite already running on port $PORT — reusing"
    # Keep the script alive so Tauri doesn't think beforeDevCommand exited
    # (Tauri kills the devCommand when beforeDevCommand exits in some modes)
    # Wait indefinitely — Tauri will kill us when it exits
    sleep infinity &
    wait $!
else
    echo "[concord] Starting Vite on port $PORT"
    cd "$(dirname "$0")/../frontend"
    exec npm run dev
fi
