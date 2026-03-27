#!/bin/sh
# Stream orrpheus desktop (with emulator windows) to orrion
# Fully interactable via browser — zero install on orrion.
#
# Prerequisites on orrpheus:
#   1. macOS Screen Sharing must be ON:
#      System Settings → General → Sharing → Screen Sharing → toggle ON
#   2. noVNC + websockify (installed via pip3)
#
# Usage:
#   ./scripts/stream-to-orrion.sh        # Start streaming
#   ./scripts/stream-to-orrion.sh stop   # Stop streaming
#
# Then on orrion, open in any browser:
#   http://100.66.55.59:6080/vnc.html
#
# Full mouse + keyboard interaction is supported.

NOVNC_PORT=6080
VNC_PORT=5900
NOVNC_DIR="/tmp/noVNC"

case "${1:-start}" in
  start)
    # Check Screen Sharing
    if ! lsof -i :$VNC_PORT >/dev/null 2>&1; then
      echo "ERROR: macOS Screen Sharing is not running on port $VNC_PORT."
      echo ""
      echo "Enable it now:"
      echo "  System Settings → General → Sharing → Screen Sharing → ON"
      echo ""
      echo "Or run: sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist"
      exit 1
    fi

    # Kill existing instance
    pkill -f "websockify.*$NOVNC_PORT" 2>/dev/null

    # Get noVNC web client
    if [ ! -d "$NOVNC_DIR" ]; then
      echo "Downloading noVNC web client..."
      git clone --depth 1 https://github.com/novnc/noVNC "$NOVNC_DIR" 2>/dev/null
    fi

    echo "Starting noVNC on port $NOVNC_PORT..."
    python3 -m websockify --web "$NOVNC_DIR" "$NOVNC_PORT" "localhost:$VNC_PORT" &
    PID=$!
    sleep 1

    if kill -0 "$PID" 2>/dev/null; then
      echo ""
      echo "=== READY ==="
      echo "Open on orrion (or any machine on Tailscale):"
      echo ""
      echo "  http://100.66.55.59:$NOVNC_PORT/vnc.html"
      echo ""
      echo "Click 'Connect', enter your macOS password when prompted."
      echo "Full mouse + keyboard interaction is supported."
      echo ""
      echo "PID: $PID — press Ctrl+C to stop."
      wait "$PID"
    else
      echo "Failed to start websockify."
      exit 1
    fi
    ;;

  stop)
    pkill -f "websockify.*$NOVNC_PORT" 2>/dev/null && echo "Stopped." || echo "Not running."
    ;;

  *)
    echo "Usage: $0 [start|stop]"
    ;;
esac
