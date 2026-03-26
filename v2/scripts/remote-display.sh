#!/bin/sh
# Remote Emulator Display — View iOS Simulator & Android Emulator from orrion
#
# This script enables orrion (or any machine on Tailscale) to view and
# interact with emulator windows running on orrpheus via VNC.
#
# SETUP (run once):
#   1. Enable macOS Screen Sharing:
#      System Settings → General → Sharing → Screen Sharing → ON
#
#   2. On orrion, install a VNC client:
#      sudo pacman -S remmina          # GUI client (recommended)
#      # OR
#      sudo pacman -S tigervnc         # CLI: vncviewer
#
# USAGE:
#   From orrpheus (this machine):
#     ./scripts/remote-display.sh start    # Start VNC tunnel
#     ./scripts/remote-display.sh stop     # Stop VNC tunnel
#     ./scripts/remote-display.sh status   # Check if running
#
#   From orrion:
#     remmina  → New connection → VNC → 100.66.55.59:5900
#     # OR
#     vncviewer 100.66.55.59:5900
#
#   From any browser on orrion (noVNC mode):
#     ./scripts/remote-display.sh novnc    # Start noVNC proxy on orrpheus
#     Then open: http://100.66.55.59:6080/vnc.html
#
# NOTES:
#   - Uses Tailscale IP (100.66.55.59) for orrpheus
#   - macOS VNC runs on port 5900 by default
#   - noVNC web interface runs on port 6080
#   - Emulators are just macOS windows — they appear in the VNC session
#   - For lower latency, use Remmina with quality set to "Fast"

ORRPHEUS_TAILSCALE="100.66.55.59"
VNC_PORT=5900
NOVNC_PORT=6080

case "${1:-status}" in
  start)
    echo "Checking macOS Screen Sharing status..."
    # Verify screen sharing is enabled
    if ! sudo launchctl list 2>/dev/null | grep -q screensharing; then
      echo "ERROR: macOS Screen Sharing is not enabled."
      echo "Enable it: System Settings → General → Sharing → Screen Sharing → ON"
      exit 1
    fi
    echo "Screen Sharing is active on port $VNC_PORT"
    echo ""
    echo "Connect from orrion:"
    echo "  remmina → VNC → $ORRPHEUS_TAILSCALE:$VNC_PORT"
    echo "  OR: vncviewer $ORRPHEUS_TAILSCALE:$VNC_PORT"
    ;;

  novnc)
    echo "Starting noVNC web proxy..."
    if ! command -v websockify >/dev/null 2>&1; then
      echo "Installing websockify + noVNC via pip..."
      pip3 install websockify 2>/dev/null || python3 -m pip install websockify
      # Clone noVNC for the web frontend
      if [ ! -d /tmp/noVNC ]; then
        git clone --depth 1 https://github.com/novnc/noVNC /tmp/noVNC 2>/dev/null
      fi
    fi
    echo "Starting websockify on port $NOVNC_PORT → localhost:$VNC_PORT"
    websockify --web /tmp/noVNC "$NOVNC_PORT" "localhost:$VNC_PORT" &
    WSPID=$!
    echo "noVNC PID: $WSPID"
    echo ""
    echo "Open in browser on orrion:"
    echo "  http://$ORRPHEUS_TAILSCALE:$NOVNC_PORT/vnc.html"
    echo ""
    echo "Press Ctrl+C to stop."
    wait "$WSPID"
    ;;

  stop)
    pkill -f websockify 2>/dev/null && echo "Stopped noVNC proxy." || echo "No noVNC proxy running."
    ;;

  status)
    echo "=== Remote Display Status ==="
    echo "VNC (Screen Sharing):"
    if sudo launchctl list 2>/dev/null | grep -q screensharing; then
      echo "  ACTIVE on port $VNC_PORT"
    else
      echo "  INACTIVE — enable in System Settings → Sharing"
    fi
    echo ""
    echo "noVNC proxy:"
    if pgrep -f websockify >/dev/null 2>&1; then
      echo "  ACTIVE on port $NOVNC_PORT"
      echo "  URL: http://$ORRPHEUS_TAILSCALE:$NOVNC_PORT/vnc.html"
    else
      echo "  INACTIVE — run: $0 novnc"
    fi
    echo ""
    echo "Connect from orrion:"
    echo "  VNC client: $ORRPHEUS_TAILSCALE:$VNC_PORT"
    echo "  Browser:    http://$ORRPHEUS_TAILSCALE:$NOVNC_PORT/vnc.html (after starting novnc)"
    ;;

  *)
    echo "Usage: $0 {start|stop|novnc|status}"
    exit 1
    ;;
esac
