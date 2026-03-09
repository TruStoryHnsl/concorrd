#!/usr/bin/env bash
set -euo pipefail

# ── Concord Install Wizard ─────────────────────────────────────────────
# Interactive installer for Concord — a Discord replacement on Matrix.
# Checks prerequisites, collects configuration, generates secrets, and
# launches the Docker stack.
# ─────────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║         Concord Install Wizard          ║${NC}"
  echo -e "${CYAN}${BOLD}║    Discord replacement on Matrix         ║${NC}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════╝${NC}"
  echo ""
}

info()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*"; }
step()    { echo -e "\n${BOLD}── $* ──${NC}"; }
prompt()  { echo -en "${CYAN}$*${NC}"; }

generate_secret() {
  openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64
}

# ── Prerequisites ────────────────────────────────────────────────────────

banner

step "Checking prerequisites"

MISSING=()

if command -v docker &>/dev/null; then
  DOCKER_VERSION=$(docker --version | head -1)
  info "Docker: $DOCKER_VERSION"
else
  MISSING+=("docker")
  error "Docker is not installed"
fi

if docker compose version &>/dev/null 2>&1; then
  COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || echo "unknown")
  info "Docker Compose: $COMPOSE_VERSION"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_VERSION=$(docker-compose --version | head -1)
  info "Docker Compose (standalone): $COMPOSE_VERSION"
else
  MISSING+=("docker-compose")
  error "Docker Compose is not installed"
fi

if command -v openssl &>/dev/null; then
  info "OpenSSL: $(openssl version | head -1)"
else
  warn "OpenSSL not found — will use /dev/urandom for secret generation"
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  error "Missing required tools: ${MISSING[*]}"
  echo ""
  echo "Install Docker:  https://docs.docker.com/engine/install/"
  echo ""
  exit 1
fi

# Check Docker daemon is running
if ! docker info &>/dev/null 2>&1; then
  error "Docker daemon is not running."
  echo "  Start it with: sudo systemctl start docker"
  echo "  Or for rootless: systemctl --user start podman.socket"
  exit 1
fi

info "Docker daemon is running"

# ── Configuration ────────────────────────────────────────────────────────

step "Instance Branding"

echo -e "${DIM}Give your instance a name. This is shown on the login page and browser tab.${NC}"
echo -e "${DIM}Examples: Concorrd, My Chat, Friends Server${NC}"
prompt "Instance name [Concord]: "
read -r INSTANCE_NAME
INSTANCE_NAME=${INSTANCE_NAME:-Concord}

step "Server Configuration"

echo -e "${DIM}Your domain or IP that users will connect to.${NC}"
echo -e "${DIM}Examples: example.com, 192.168.1.50, localhost${NC}"
prompt "Domain/hostname: "
read -r SERVER_NAME
SERVER_NAME=${SERVER_NAME:-localhost}

echo ""
echo -e "${DIM}HTTP port for the web interface (default: 8080).${NC}"
prompt "HTTP port [8080]: "
read -r HTTP_PORT
HTTP_PORT=${HTTP_PORT:-8080}

echo ""
echo -e "${DIM}Internal port for the Matrix homeserver (default: 6167).${NC}"
echo -e "${DIM}You usually don't need to change this.${NC}"
prompt "Conduwuit port [6167]: "
read -r CONDUWUIT_PORT
CONDUWUIT_PORT=${CONDUWUIT_PORT:-6167}

# ── Admin Account ────────────────────────────────────────────────────────

step "Admin Account"

echo -e "${DIM}Create the first admin user. This account will have full control.${NC}"
prompt "Admin username: "
read -r ADMIN_USERNAME
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}

while true; do
  prompt "Admin password: "
  read -rs ADMIN_PASSWORD
  echo ""
  if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
    warn "Password must be at least 8 characters."
    continue
  fi
  prompt "Confirm password: "
  read -rs ADMIN_PASSWORD_CONFIRM
  echo ""
  if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
    warn "Passwords do not match. Try again."
    continue
  fi
  break
done

ADMIN_USER_ID="@${ADMIN_USERNAME}:${SERVER_NAME}"

# ── Secrets ──────────────────────────────────────────────────────────────

step "Generating secrets"

REG_TOKEN=$(generate_secret)
info "Registration token generated"

LK_KEY="API$(generate_secret | tr -dc 'A-Za-z0-9' | head -c 12)"
LK_SECRET=$(generate_secret)
info "LiveKit API key/secret generated"

# ── Optional: TURN ───────────────────────────────────────────────────────

step "TURN Relay (optional)"

echo -e "${DIM}TURN relays help voice calls work behind strict NATs/firewalls.${NC}"
echo -e "${DIM}Get free credentials at https://www.metered.ca/${NC}"
prompt "Metered app name (leave empty to skip): "
read -r METERED_APP
METERED_APP=${METERED_APP:-}

METERED_KEY=""
if [ -n "$METERED_APP" ]; then
  prompt "Metered API key: "
  read -r METERED_KEY
fi

# ── Optional: SMTP ───────────────────────────────────────────────────────

step "Email Invites (optional)"

echo -e "${DIM}SMTP settings enable email-based server invitations.${NC}"
prompt "SMTP host (leave empty to skip): "
read -r SMTP_HOST
SMTP_HOST=${SMTP_HOST:-}

SMTP_PORT_VAL="587"
SMTP_USER=""
SMTP_PASS=""
SMTP_FROM=""

if [ -n "$SMTP_HOST" ]; then
  prompt "SMTP port [587]: "
  read -r SMTP_PORT_VAL
  SMTP_PORT_VAL=${SMTP_PORT_VAL:-587}
  prompt "SMTP username: "
  read -r SMTP_USER
  prompt "SMTP password: "
  read -rs SMTP_PASS
  echo ""
  prompt "From address: "
  read -r SMTP_FROM
fi

# ── Optional: Freesound ──────────────────────────────────────────────────

step "Sound Library (optional)"

echo -e "${DIM}Freesound API lets users browse/import sound effects for soundboards.${NC}"
echo -e "${DIM}Get a key at https://freesound.org/apiv2/apply${NC}"
prompt "Freesound API key (leave empty to skip): "
read -r FREESOUND_KEY
FREESOUND_KEY=${FREESOUND_KEY:-}

# ── Write .env ───────────────────────────────────────────────────────────

step "Writing configuration"

SITE_URL="http://${SERVER_NAME}:${HTTP_PORT}"
if [ "$HTTP_PORT" = "80" ]; then
  SITE_URL="http://${SERVER_NAME}"
fi

ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — backing up to .env.backup"
  cp "$ENV_FILE" ".env.backup"
fi

cat > "$ENV_FILE" <<ENVEOF
# Concord Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# WARNING: CONDUWUIT_SERVER_NAME cannot be changed after first run.

# ── Matrix Homeserver ────────────────────────────────────────────────
CONDUWUIT_SERVER_NAME=${SERVER_NAME}
CONDUWUIT_REGISTRATION_TOKEN=${REG_TOKEN}
CONDUWUIT_PORT=${CONDUWUIT_PORT}

# ── LiveKit (Voice/Video) ───────────────────────────────────────────
LIVEKIT_API_KEY=${LK_KEY}
LIVEKIT_API_SECRET=${LK_SECRET}
LIVEKIT_TURN_DOMAIN=${SERVER_NAME}

# ── TURN Relay ───────────────────────────────────────────────────────
METERED_APP_NAME=${METERED_APP}
METERED_API_KEY=${METERED_KEY}

# ── Admin ────────────────────────────────────────────────────────────
ADMIN_USER_IDS=${ADMIN_USER_ID}

# ── SMTP ─────────────────────────────────────────────────────────────
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT_VAL}
SMTP_USER=${SMTP_USER}
SMTP_PASSWORD=${SMTP_PASS}
SMTP_FROM=${SMTP_FROM}
SITE_URL=${SITE_URL}

# ── Freesound API ────────────────────────────────────────────────────
FREESOUND_API_KEY=${FREESOUND_KEY}

# ── Instance Branding ────────────────────────────────────────────────
INSTANCE_NAME=${INSTANCE_NAME}

# ── Nginx ────────────────────────────────────────────────────────────
NGINX_HTTP_PORT=${HTTP_PORT}
ENVEOF

info "Configuration written to .env"

# ── Build & Launch ───────────────────────────────────────────────────────

step "Building and starting Concord"

echo -e "${DIM}This will download container images and build the application.${NC}"
echo -e "${DIM}First run may take 2-5 minutes depending on your connection.${NC}"
echo ""

docker compose up -d --build 2>&1 | while IFS= read -r line; do
  echo -e "  ${DIM}${line}${NC}"
done

echo ""

# ── Wait for API to be ready ─────────────────────────────────────────────

step "Waiting for services to start"

MAX_WAIT=120
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sf "http://localhost:${HTTP_PORT}/api/health" &>/dev/null; then
    info "API is ready"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  echo -ne "\r  Waiting... ${ELAPSED}s"
done

echo ""

if [ $ELAPSED -ge $MAX_WAIT ]; then
  warn "Services are taking longer than expected to start."
  warn "Check logs with: docker compose logs -f"
  warn "You can register the admin account manually once services are ready."
  exit 0
fi

# ── Wait for Matrix homeserver ───────────────────────────────────────────

sleep 3  # Give conduwuit a moment after API is ready

# ── Create Admin Account ─────────────────────────────────────────────────

step "Creating admin account"

REG_RESPONSE=$(curl -sf "http://localhost:${HTTP_PORT}/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${ADMIN_USERNAME}\", \"password\": \"${ADMIN_PASSWORD}\"}" 2>&1) || true

if echo "$REG_RESPONSE" | grep -q "access_token"; then
  info "Admin account '${ADMIN_USERNAME}' created successfully"
else
  ERROR_MSG=$(echo "$REG_RESPONSE" | grep -o '"detail":"[^"]*"' | head -1 || echo "")
  if echo "$ERROR_MSG" | grep -qi "exists"; then
    warn "User '${ADMIN_USERNAME}' already exists — skipping"
  else
    warn "Could not create admin account automatically."
    warn "Response: ${REG_RESPONSE}"
    echo "  You can register manually at: ${SITE_URL}"
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       Concord is ready!                 ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Web interface:${NC}  ${SITE_URL}"
echo -e "  ${BOLD}Admin account:${NC}  ${ADMIN_USERNAME}"
echo ""
echo -e "  ${DIM}Useful commands:${NC}"
echo -e "    docker compose logs -f        ${DIM}# View live logs${NC}"
echo -e "    docker compose restart         ${DIM}# Restart services${NC}"
echo -e "    docker compose down            ${DIM}# Stop services${NC}"
echo -e "    docker compose up -d --build   ${DIM}# Rebuild after changes${NC}"
echo ""
echo -e "  ${YELLOW}Important:${NC} CONDUWUIT_SERVER_NAME (${SERVER_NAME}) cannot be"
echo -e "  changed after first run without wiping the database."
echo ""
