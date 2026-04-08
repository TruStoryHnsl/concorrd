#!/usr/bin/env bash
# concord-dev-up.sh — bring up Concord in dev mode with HMR on orrgate.
#
# Run this ON orrgate (where the docker stack lives).
#
# Steps:
#   1. Verify we're in the concord stack directory
#   2. Compose up with the dev overlay (web switches to Caddyfile.dev,
#      vite-dev service starts). With the current Dockerfile.dev, deps are
#      installed at container startup rather than baked into the image, so
#      a rebuild is only needed if the base node image changes. Pass --build
#      to force a rebuild anyway.
#   3. Wait up to WAIT_TIMEOUT seconds for vite-dev to report "ready in"
#   4. Scan vite-dev logs for "Failed to resolve import" — a signal that
#      node_modules is out of sync with package-lock.json (shouldn't happen
#      with the runtime npm ci approach, but surface it if it does)
#   5. Trigger a Syncthing rescan on the concord-dev folder so any changes
#      the user just made on orrion propagate immediately
#   6. Print the final compose status table
#
# Usage:
#   Local:  /docker/stacks/concord/scripts/concord-dev-up.sh [--build]
#   Remote: ssh orrgate '/docker/stacks/concord/scripts/concord-dev-up.sh'
#
# Exit codes:
#   0 = dev stack is up and vite-dev is serving
#   1 = brought up but vite-dev did not report ready within the timeout,
#       or resolve-import warnings were found
#   2 = hard failure (missing stack dir, docker not available)

set -Eeuo pipefail

# --- config ---
CONCORD_DIR="${CONCORD_DIR:-/docker/stacks/concord}"
VITE_SERVICE="vite-dev"
VITE_CONTAINER="concord-vite-dev-1"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"
SYNCTHING_FOLDER="concord-dev"
SYNCTHING_API="http://localhost:8384"

# Compose overlay: base + the production override (for the 8443 port mapping)
# + the dev overlay. Order matters — later files override earlier.
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.override.yml -f docker-compose.dev.yml)

# --- logging ---
_ts() { date '+%H:%M:%S'; }
log()   { printf '\033[1;34m[%s]\033[0m %s\n'       "$(_ts)" "$*"; }
warn()  { printf '\033[1;33m[%s] WARN:\033[0m %s\n' "$(_ts)" "$*" >&2; }
error() { printf '\033[1;31m[%s] ERROR:\033[0m %s\n' "$(_ts)" "$*" >&2; }
die()   { error "$@"; exit 2; }

# --- preflight ---
[[ -d "$CONCORD_DIR" ]] || die "Concord stack dir not found: $CONCORD_DIR"
cd "$CONCORD_DIR"
command -v docker >/dev/null || die "docker not installed"
[[ -f docker-compose.yml && -f docker-compose.dev.yml ]] \
  || die "docker-compose.yml or docker-compose.dev.yml missing in $CONCORD_DIR"

# --- args ---
BUILD_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_FLAG="--build" ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      warn "Unknown argument: $arg (ignored)"
      ;;
  esac
done

# --- bring up ---
log "Bringing up concord dev stack in $CONCORD_DIR"
if [[ -n "$BUILD_FLAG" ]]; then
  log "Rebuild requested — this will run 'docker compose build vite-dev' before up"
fi

# shellcheck disable=SC2086  # $BUILD_FLAG is intentionally unquoted to expand empty
docker compose "${COMPOSE_FILES[@]}" up -d $BUILD_FLAG

# --- wait for vite-dev ---
log "Waiting for ${VITE_CONTAINER} to report ready (up to ${WAIT_TIMEOUT}s)"
deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
ready=0
while (( $(date +%s) < deadline )); do
  if docker logs "$VITE_CONTAINER" 2>&1 | grep -qE "ready in [0-9]+ ms"; then
    ready=1
    break
  fi
  # If npm ci is running, tell the user so they don't think it's stuck
  if docker logs "$VITE_CONTAINER" 2>&1 | grep -q "Installing deps (npm ci)" \
     && ! docker logs "$VITE_CONTAINER" 2>&1 | grep -qE "added [0-9]+ packages|up to date"; then
    printf '\r[%s] npm ci in progress (first startup or lockfile changed)...' "$(_ts)"
  fi
  sleep 2
done
echo

if (( ready == 0 )); then
  warn "${VITE_CONTAINER} did not report ready within ${WAIT_TIMEOUT}s"
  warn "Last 30 log lines:"
  docker logs --tail 30 "$VITE_CONTAINER" 2>&1 | sed 's/^/  /'
else
  log "${VITE_CONTAINER}: ready"
fi

# --- check for resolution errors ---
resolve_errors=0
if docker logs "$VITE_CONTAINER" 2>&1 | grep -q "Failed to resolve import"; then
  resolve_errors=1
  warn "${VITE_CONTAINER} logs contain 'Failed to resolve import':"
  docker logs "$VITE_CONTAINER" 2>&1 | grep "Failed to resolve" | head -5 | sed 's/^/  /'
  warn "Hint: try '$0 --build' to force a rebuild of the vite-dev image."
fi

# --- trigger Syncthing rescan on concord-dev folder (best-effort) ---
if command -v curl >/dev/null && [[ -r "$HOME/.local/state/syncthing/config.xml" ]]; then
  api_key=$(grep -oP '(?<=<apikey>)[^<]+' "$HOME/.local/state/syncthing/config.xml" 2>/dev/null || true)
  if [[ -n "$api_key" ]]; then
    if curl -sS -m 5 -X POST -H "X-API-Key: $api_key" \
         "${SYNCTHING_API}/rest/db/scan?folder=${SYNCTHING_FOLDER}" >/dev/null 2>&1; then
      log "Triggered Syncthing rescan on folder '${SYNCTHING_FOLDER}'"
    else
      warn "Syncthing rescan API call failed (non-fatal)"
    fi
  fi
fi

# --- final status ---
log "--- Stack status ---"
docker compose "${COMPOSE_FILES[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

if (( ready == 1 && resolve_errors == 0 )); then
  log "Dev stack is up. HMR is active — saves on orrion will propagate via Syncthing and hot-reload in your browser."
  exit 0
else
  exit 1
fi
