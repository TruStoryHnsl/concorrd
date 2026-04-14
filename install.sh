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

step_header() {
  local current="$1"
  local label="$2"
  echo ""
  echo -e "${BOLD}── Step ${current}/${TOTAL_STEPS}: ${label} ──${NC}"
  echo -e "${DIM}(type 'back' at any prompt to return to the previous step)${NC}"
}

# ── Input helpers ──────────────────────────────────────────────────────
# read_input: Shows a prompt with an editable default (bash 4+ uses
# readline -ei; falls back to displaying the default in brackets).
# Returns 1 if the user typed 'back' (triggers step navigation).

WENT_BACK=false

# Detect readline -ei support once at startup
_READ_HAS_EI=false
if echo "" | bash -c 'read -rei "test" _v' 2>/dev/null; then
  _READ_HAS_EI=true
fi

read_input() {
  local label="$1"
  local default="$2"
  local varname="$3"

  local input
  if [ "$_READ_HAS_EI" = true ]; then
    echo -en "${CYAN}${label}${NC}"
    read -rei "$default" input
  else
    if [ -n "$default" ]; then
      echo -en "${CYAN}${label}${NC}${DIM}[${default}] ${NC}"
    else
      echo -en "${CYAN}${label}${NC}"
    fi
    read -r input
    input="${input:-$default}"
  fi
  if [ "$input" = "back" ]; then
    WENT_BACK=true
    return 1
  fi
  WENT_BACK=false
  printf -v "$varname" '%s' "${input:-$default}"
  return 0
}

read_secret() {
  local label="$1"
  local varname="$2"

  echo -en "${CYAN}${label}${NC}"
  local input
  read -rs input 2>/dev/null || read -r input
  echo ""
  if [ "$input" = "back" ]; then
    WENT_BACK=true
    return 1
  fi
  WENT_BACK=false
  printf -v "$varname" '%s' "$input"
  return 0
}

generate_secret() {
  if command -v openssl &>/dev/null; then
    openssl rand -base64 32 2>/dev/null | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n='
  fi
}

detect_lan_ip() {
  if command -v ip &>/dev/null; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || true
  elif command -v hostname &>/dev/null; then
    hostname -I 2>/dev/null | awk '{print $1}' || true
  fi
}

detect_hostname() {
  hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "server"
}

detect_public_ip() {
  curl -4 -sf --max-time 5 https://ifconfig.me 2>/dev/null || \
  curl -4 -sf --max-time 5 https://api.ipify.org 2>/dev/null || \
  echo ""
}

# ── Prerequisites (runs once, not part of step loop) ─────────────────────

banner

echo -e "${BOLD}── Checking prerequisites ──${NC}"

if ! command -v curl &>/dev/null; then
  error "curl is required but not installed."
  echo "  Install it with your package manager, e.g.:"
  echo "    sudo apt install curl          # Debian/Ubuntu"
  echo "    sudo dnf install curl          # Fedora"
  echo "    sudo pacman -S curl            # Arch"
  echo "    brew install curl              # macOS"
  exit 1
fi
info "curl: $(curl --version | head -1 | awk '{print $1, $2}')"

install_docker() {
  echo ""
  info "Installing Docker via official install script..."
  echo -e "${DIM}This may ask for your sudo password.${NC}"
  echo ""
  if curl -fsSL https://get.docker.com | sh; then
    info "Docker installed successfully"
    if [ "$(id -u)" -ne 0 ] && ! groups | grep -qw docker; then
      sudo usermod -aG docker "$USER" 2>/dev/null || true
      warn "Added $USER to docker group — you may need to log out and back in"
      warn "for group changes to take effect. For now, using sudo."
      DOCKER_SUDO="sudo"
    fi
  else
    error "Docker installation failed."
    echo "  Try installing manually: https://docs.docker.com/engine/install/"
    exit 1
  fi
}

DOCKER_SUDO=""

if command -v docker &>/dev/null; then
  info "Docker: $(docker --version | head -1)"
else
  echo ""
  echo -e "${DIM}Docker is not installed. It's required to run Concord.${NC}"
  echo -en "${CYAN}Install Docker now? [Y/n]: ${NC}"
  read -r INSTALL_DOCKER
  INSTALL_DOCKER=${INSTALL_DOCKER:-Y}
  if [[ "$INSTALL_DOCKER" =~ ^[Yy] ]]; then
    install_docker
  else
    error "Docker is required. Install it from https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

if $DOCKER_SUDO docker compose version &>/dev/null 2>&1; then
  info "Docker Compose: $($DOCKER_SUDO docker compose version --short 2>/dev/null || echo "available")"
elif command -v docker-compose &>/dev/null; then
  info "Docker Compose (standalone): $(docker-compose --version | head -1)"
else
  error "Docker Compose is not available."
  echo "  It should be included with Docker. Try reinstalling Docker."
  exit 1
fi

if ! $DOCKER_SUDO docker info &>/dev/null 2>&1; then
  warn "Docker daemon is not running — starting it..."
  if sudo systemctl start docker 2>/dev/null; then
    sleep 2
    if $DOCKER_SUDO docker info &>/dev/null 2>&1; then
      info "Docker daemon started"
    else
      error "Docker daemon failed to start. Check: sudo systemctl status docker"
      exit 1
    fi
  else
    error "Could not start Docker daemon."
    echo "  Start it with: sudo systemctl start docker"
    exit 1
  fi
fi

info "Docker daemon is running"

# ═══════════════════════════════════════════════════════════════════════
# Wizard steps as functions
# ═══════════════════════════════════════════════════════════════════════

TOTAL_STEPS=4

# Initialize all config with defaults
SERVER_NAME="Concord"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD=""
DOMAIN=""
NET_CHOICE=""
NET_MODE=""
HTTP_PORT="8080"
BIND_HOST=""
USE_HTTPS=false
SITE_ADDRESS=""
SITE_URL=""
LIVEKIT_TURN_DOMAIN=""
TURN_HOST=""
DNS_API_TOKEN=""
TUNNEL_TOKEN=""
INTEGRATIONS=""
SMTP_HOST=""
SMTP_PORT_VAL="587"
SMTP_USER=""
SMTP_PASS=""
SMTP_FROM=""
FREESOUND_KEY=""

# ── Step 1: Server Name ──────────────────────────────────────────────

wizard_step_1() {
  step_header 1 "Name Your Server"
  echo -e "${DIM}Choose a display name for your chat server. This is what users see${NC}"
  echo -e "${DIM}on the login page and in the app header.${NC}"
  echo -e "${DIM}Examples: Concord, The Hideout, Squad Chat${NC}"
  read_input "Server name: " "$SERVER_NAME" SERVER_NAME || return 1
}

# ── Step 2: Admin Account ────────────────────────────────────────────

wizard_step_2() {
  step_header 2 "Admin Account"
  echo -e "${DIM}Create the first admin user. This account will have full control.${NC}"
  read_input "Username: " "$ADMIN_USERNAME" ADMIN_USERNAME || return 1

  while true; do
    read_secret "Password: " ADMIN_PASSWORD || return 1
    if [ -z "$ADMIN_PASSWORD" ]; then
      warn "Password cannot be empty."
      continue
    fi
    if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
      warn "Password is shorter than 8 characters."
      echo -en "${CYAN}Continue anyway? [y/N]: ${NC}"
      read -r SHORT_PW_OK
      if [[ ! "$SHORT_PW_OK" =~ ^[Yy] ]]; then
        continue
      fi
    fi
    read_secret "Confirm password: " ADMIN_PASSWORD_CONFIRM || return 1
    if [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]; then
      warn "Passwords do not match. Try again."
      continue
    fi
    break
  done
}

# ── Step 3: Domain & Network ──────────────────────────────────────────

# Helper: extract Cloudflare error message from JSON response
cf_error() {
  local resp="$1"
  echo "$resp" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4
}

# Helper: verify Cloudflare API token, find zone ID + account ID
# Sets: CF_ZONE_ID, CF_ACCOUNT_ID, CF_ZONE_NAME
cf_setup() {
  local token="$1" domain="$2"

  echo -e "${DIM}Verifying API token...${NC}"
  local VERIFY_RESPONSE
  VERIFY_RESPONSE=$(curl -s -H "Authorization: Bearer $token" \
    "https://api.cloudflare.com/client/v4/user/tokens/verify" 2>&1) || true

  if ! echo "$VERIFY_RESPONSE" | grep -q '"success":true'; then
    local VERIFY_ERR
    VERIFY_ERR=$(cf_error "$VERIFY_RESPONSE")
    error "Invalid API token: ${VERIFY_ERR:-unknown error}"
    return 1
  fi
  info "API token valid"

  echo -e "${DIM}Looking up Cloudflare zone for ${domain}...${NC}"

  CF_ZONE_ID="" CF_ACCOUNT_ID="" CF_ZONE_NAME=""
  local ZONE_SEARCH="$domain"
  while [[ "$ZONE_SEARCH" == *.* ]]; do
    local ZONE_RESPONSE
    ZONE_RESPONSE=$(curl -s -H "Authorization: Bearer $token" \
      "https://api.cloudflare.com/client/v4/zones?name=${ZONE_SEARCH}" 2>&1) || true
    CF_ZONE_ID=$(echo "$ZONE_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$CF_ZONE_ID" ]; then
      CF_ZONE_NAME="$ZONE_SEARCH"
      CF_ACCOUNT_ID=$(echo "$ZONE_RESPONSE" | grep -o '"account":{"id":"[^"]*"' | head -1 | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
      break
    fi
    ZONE_SEARCH="${ZONE_SEARCH#*.}"
  done

  if [ -z "$CF_ZONE_ID" ]; then
    error "Could not find a Cloudflare zone for ${domain}"
    return 1
  fi
  info "Found zone: ${CF_ZONE_NAME}"
  return 0
}

install_cloudflared() {
  echo ""
  echo -e "${DIM}Installing cloudflared...${NC}"

  if command -v cloudflared &>/dev/null; then
    info "cloudflared already installed: $(cloudflared --version 2>&1 | head -1)"
    return 0
  fi

  # Detect OS and install
  if [ -f /etc/debian_version ]; then
    # Debian/Ubuntu
    echo -e "${DIM}Detected Debian/Ubuntu — installing via apt...${NC}"
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null 2>&1
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs 2>/dev/null || echo "bookworm") main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null 2>&1
    sudo apt-get update -qq 2>/dev/null && sudo apt-get install -y -qq cloudflared 2>/dev/null
  elif [ -f /etc/redhat-release ]; then
    # RHEL/Fedora/CentOS
    echo -e "${DIM}Detected RHEL/Fedora — installing via rpm...${NC}"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').rpm" -o /tmp/cloudflared.rpm
    sudo rpm -i /tmp/cloudflared.rpm 2>/dev/null
    rm -f /tmp/cloudflared.rpm
  elif [ -f /etc/arch-release ]; then
    # Arch
    echo -e "${DIM}Detected Arch Linux — installing via pacman...${NC}"
    sudo pacman -S --noconfirm cloudflared 2>/dev/null
  elif command -v brew &>/dev/null; then
    # macOS
    echo -e "${DIM}Installing via Homebrew...${NC}"
    brew install cloudflared 2>/dev/null
  else
    # Direct binary download as fallback
    echo -e "${DIM}Downloading cloudflared binary...${NC}"
    local ARCH
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" -o /tmp/cloudflared
    sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
    rm -f /tmp/cloudflared
  fi

  if command -v cloudflared &>/dev/null; then
    info "cloudflared installed: $(cloudflared --version 2>&1 | head -1)"
    return 0
  else
    error "Failed to install cloudflared."
    echo "  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    return 1
  fi
}

wizard_step_3() {
  step_header 3 "Domain & Network"

  local LAN_IP
  LAN_IP=$(detect_lan_ip)
  LAN_IP=${LAN_IP:-localhost}

  echo ""
  echo -e "${DIM}Concord works best with a domain and Cloudflare Tunnel — no port${NC}"
  echo -e "${DIM}forwarding needed, automatic HTTPS, and your server's IP stays hidden.${NC}"
  echo ""
  echo -e "  ${BOLD}1${NC}  ${BOLD}Set up with a domain${NC}  ${DIM}(recommended — guided Cloudflare Tunnel setup)${NC}"
  echo -e "  ${BOLD}2${NC}  Other options          ${DIM}(local only, own reverse proxy, or manual)${NC}"
  echo ""

  while true; do
    echo -en "${CYAN}Choose [1-2]: ${NC}"
    read -r NET_CHOICE
    if [ "$NET_CHOICE" = "back" ]; then return 1; fi
    NET_CHOICE=${NET_CHOICE:-1}
    case "$NET_CHOICE" in
      1|2) break ;;
      *) warn "Please choose 1 or 2." ;;
    esac
  done

  # Reset network defaults
  DOMAIN=""
  USE_HTTPS=false
  BIND_HOST=""

  if [ "$NET_CHOICE" = "1" ]; then
    # ══════════════════════════════════════════════════════════════════
    # Default path: Cloudflare Tunnel (guided)
    # ══════════════════════════════════════════════════════════════════
    NET_MODE="automatic"

    echo ""
    echo -e "${BOLD}Great! Let's connect your domain.${NC}"
    echo ""
    echo -e "${DIM}This is the domain your users will visit to reach your server.${NC}"
    echo -e "${DIM}It must already be on Cloudflare (free plan works).${NC}"
    echo ""

    read_input "Domain (e.g. chat.example.com): " "${DOMAIN:-}" DOMAIN || return 1

    if [ -z "$DOMAIN" ]; then
      warn "A domain is required for tunnel setup."
      return 1
    fi

    SITE_ADDRESS=":8080"
    HTTP_PORT="8080"
    BIND_HOST="127.0.0.1"
    SITE_URL="https://${DOMAIN}"
    LIVEKIT_TURN_DOMAIN="$DOMAIN"
    TURN_HOST="turn.${DOMAIN}"

    echo ""
    info "Domain: ${BOLD}${DOMAIN}${NC}"

    # ── Install cloudflared ─────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Installing cloudflared${NC}"
    echo -e "${DIM}cloudflared creates a secure tunnel between Cloudflare and this machine.${NC}"

    if ! install_cloudflared; then
      echo ""
      warn "Could not install cloudflared. You can still set up manually later."
      echo -en "${CYAN}Continue anyway? [Y/n]: ${NC}"
      read -r CF_CONTINUE
      if [[ "${CF_CONTINUE:-Y}" =~ ^[Nn] ]]; then return 1; fi
    fi

    # ── Cloudflare API token ────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Cloudflare API Token${NC}"
    echo ""
    echo -e "${DIM}The wizard needs an API token to create the tunnel and DNS record.${NC}"
    echo -e "${DIM}Here's how to create one (takes ~30 seconds):${NC}"
    echo ""
    echo -e "  ${BOLD}1.${NC} Open ${BOLD}https://dash.cloudflare.com/profile/api-tokens${NC}"
    echo -e "  ${BOLD}2.${NC} Click ${BOLD}Create Token${NC}"
    echo -e "  ${BOLD}3.${NC} Click ${BOLD}Create Custom Token${NC}"
    echo -e "  ${BOLD}4.${NC} Give it a name (e.g. \"Concord Installer\")"
    echo -e "  ${BOLD}5.${NC} Add these permissions:"
    echo -e "       ${CYAN}Account${NC} — Cloudflare Tunnel — ${BOLD}Edit${NC}"
    echo -e "       ${CYAN}Zone${NC}    — DNS              — ${BOLD}Edit${NC}"
    echo -e "  ${BOLD}6.${NC} Under Zone Resources, select ${BOLD}your domain's zone${NC}"
    echo -e "  ${BOLD}7.${NC} Click ${BOLD}Continue to summary${NC} → ${BOLD}Create Token${NC}"
    echo -e "  ${BOLD}8.${NC} Copy the token and paste it below"
    echo ""

    read_input "API token: " "${DNS_API_TOKEN:-}" DNS_API_TOKEN || return 1

    if [ -z "$DNS_API_TOKEN" ]; then
      warn "No token provided — cannot create tunnel."
      return 1
    fi

    # ── Validate token and find zone ────────────────────────────────
    echo ""
    if ! cf_setup "$DNS_API_TOKEN" "$DOMAIN"; then
      echo ""
      echo -en "${CYAN}Go back to fix? [Y/n]: ${NC}"
      read -r FIX_CHOICE
      if [[ "${FIX_CHOICE:-Y}" =~ ^[Yy] ]]; then return 1; fi
      return 0
    fi

    # ── Create tunnel ───────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Creating Cloudflare Tunnel${NC}"

    local TUNNEL_NAME="concord-${DOMAIN//\./-}"

    # Clean up existing tunnel with same name
    echo -e "${DIM}Checking for existing tunnel...${NC}"
    local EXISTING_TUNNELS
    EXISTING_TUNNELS=$(curl -s -H "Authorization: Bearer $DNS_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false" 2>&1) || true
    local EXISTING_TUNNEL_ID
    EXISTING_TUNNEL_ID=$(echo "$EXISTING_TUNNELS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$EXISTING_TUNNEL_ID" ]; then
      warn "Tunnel '${TUNNEL_NAME}' already exists — replacing it"
      curl -s -X DELETE \
        -H "Authorization: Bearer $DNS_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${EXISTING_TUNNEL_ID}" > /dev/null 2>&1 || true
    fi

    echo -e "${DIM}Creating tunnel '${TUNNEL_NAME}'...${NC}"
    local TUNNEL_SECRET
    TUNNEL_SECRET=$(generate_secret)
    local TUNNEL_RESPONSE
    TUNNEL_RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bearer $DNS_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" \
      -d "{\"name\":\"${TUNNEL_NAME}\",\"tunnel_secret\":\"${TUNNEL_SECRET}\",\"config_src\":\"cloudflare\"}" 2>&1) || true

    if ! echo "$TUNNEL_RESPONSE" | grep -q '"success":true'; then
      local TUN_ERR
      TUN_ERR=$(cf_error "$TUNNEL_RESPONSE")
      error "Failed to create tunnel: ${TUN_ERR:-unknown error}"
      echo -e "${DIM}Response: ${TUNNEL_RESPONSE}${NC}"
      return 1
    fi

    local TUNNEL_ID
    TUNNEL_ID=$(echo "$TUNNEL_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    TUNNEL_TOKEN=$(echo "$TUNNEL_RESPONSE" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
    info "Tunnel created: ${TUNNEL_NAME}"

    # ── Configure ingress ───────────────────────────────────────────
    echo -e "${DIM}Configuring tunnel routing...${NC}"
    local INGRESS_RESPONSE
    INGRESS_RESPONSE=$(curl -s -X PUT \
      -H "Authorization: Bearer $DNS_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" \
      -d "{\"config\":{\"ingress\":[{\"hostname\":\"${DOMAIN}\",\"service\":\"http://web:8080\"},{\"service\":\"http_status:404\"}]}}" 2>&1) || true

    if echo "$INGRESS_RESPONSE" | grep -q '"success":true'; then
      info "Tunnel routes ${DOMAIN} → Concord"
    else
      local ING_ERR
      ING_ERR=$(cf_error "$INGRESS_RESPONSE")
      warn "Ingress config issue: ${ING_ERR:-check Cloudflare dashboard}"
    fi

    # ── Set up DNS ──────────────────────────────────────────────────
    echo -e "${DIM}Setting up DNS for ${DOMAIN}...${NC}"

    # Remove existing records
    local EXISTING_RECORDS
    EXISTING_RECORDS=$(curl -s -H "Authorization: Bearer $DNS_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=${DOMAIN}" 2>&1) || true
    local OLD_RECORD_ID
    OLD_RECORD_ID=$(echo "$EXISTING_RECORDS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$OLD_RECORD_ID" ]; then
      curl -s -X DELETE \
        -H "Authorization: Bearer $DNS_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${OLD_RECORD_ID}" > /dev/null 2>&1 || true
    fi

    local CNAME_RESPONSE
    CNAME_RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bearer $DNS_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
      -d "{\"type\":\"CNAME\",\"name\":\"${DOMAIN}\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}" 2>&1) || true

    if echo "$CNAME_RESPONSE" | grep -q '"success":true'; then
      info "DNS record created: ${DOMAIN} → tunnel"
    else
      local DNS_ERR
      DNS_ERR=$(cf_error "$CNAME_RESPONSE")
      warn "DNS issue: ${DNS_ERR:-create a CNAME to ${TUNNEL_ID}.cfargotunnel.com manually}"
    fi

    # ── TURN DNS (direct, no proxy) ───────────────────────────────
    # Voice relay (coturn) needs a direct connection — CDN proxies block
    # UDP/TURN traffic. Create a DNS-only A record for turn.DOMAIN that
    # points straight to the server's public IP.
    echo ""
    echo -e "${BOLD}Setting up voice relay DNS${NC}"
    echo -e "${DIM}Voice chat needs a direct connection that bypasses the tunnel.${NC}"
    echo -e "${DIM}Creating a DNS record for turn.${DOMAIN}...${NC}"

    local SERVER_PUBLIC_IP
    SERVER_PUBLIC_IP=$(detect_public_ip)

    if [ -z "$SERVER_PUBLIC_IP" ]; then
      warn "Could not detect server's public IP."
      echo -en "${CYAN}Enter this server's public IP: ${NC}"
      read -r SERVER_PUBLIC_IP
    fi

    if [ -n "$SERVER_PUBLIC_IP" ]; then
      # Remove existing turn. record
      local EXISTING_TURN_RECORDS
      EXISTING_TURN_RECORDS=$(curl -s -H "Authorization: Bearer $DNS_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=turn.${DOMAIN}" 2>&1) || true
      local OLD_TURN_ID
      OLD_TURN_ID=$(echo "$EXISTING_TURN_RECORDS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ -n "$OLD_TURN_ID" ]; then
        curl -s -X DELETE \
          -H "Authorization: Bearer $DNS_API_TOKEN" \
          "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${OLD_TURN_ID}" > /dev/null 2>&1 || true
      fi

      # Create DNS-only A record (proxied:false = gray cloud = direct)
      local TURN_DNS_RESPONSE
      TURN_DNS_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $DNS_API_TOKEN" \
        -H "Content-Type: application/json" \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
        -d "{\"type\":\"A\",\"name\":\"turn.${DOMAIN}\",\"content\":\"${SERVER_PUBLIC_IP}\",\"proxied\":false,\"ttl\":300}" 2>&1) || true

      if echo "$TURN_DNS_RESPONSE" | grep -q '"success":true'; then
        info "DNS record created: turn.${DOMAIN} → ${SERVER_PUBLIC_IP} (direct, no proxy)"
        TURN_HOST="turn.${DOMAIN}"
      else
        local TURN_DNS_ERR
        TURN_DNS_ERR=$(cf_error "$TURN_DNS_RESPONSE")
        warn "Could not create turn DNS record: ${TURN_DNS_ERR:-unknown}"
        echo -e "  ${DIM}Create an A record for turn.${DOMAIN} → ${SERVER_PUBLIC_IP} manually.${NC}"
        echo -e "  ${DIM}IMPORTANT: Disable Cloudflare proxy (gray cloud) for this record.${NC}"
      fi
    else
      warn "No public IP available — voice relay DNS not configured."
      echo -e "  ${DIM}Create an A record for turn.${DOMAIN} → your server IP manually.${NC}"
      echo -e "  ${DIM}IMPORTANT: Disable Cloudflare proxy (gray cloud) for this record.${NC}"
    fi

    # ── Summary ─────────────────────────────────────────────────────
    echo ""
    info "Tunnel is fully configured!"
    echo -e "  ${DIM}Traffic flow: internet → Cloudflare (HTTPS) → tunnel → this server${NC}"
    echo -e "  ${DIM}Voice relay: internet → turn.${DOMAIN} (direct) → coturn on this server${NC}"
    echo -e "  ${DIM}Ports to open: 3478/udp+tcp, 5349/tcp, 49152-49252/udp${NC}"

  else
    # ══════════════════════════════════════════════════════════════════
    # Alternative network modes
    # ══════════════════════════════════════════════════════════════════
    echo ""
    echo -e "  ${BOLD}a${NC}  Self-proxy      ${DIM}I have my own reverse proxy (nginx, Traefik, npm, etc.)${NC}"
    echo -e "  ${BOLD}b${NC}  Local only      ${DIM}Only accessible from this machine (127.0.0.1)${NC}"
    echo -e "  ${BOLD}c${NC}  Manual          ${DIM}Configure every field myself${NC}"
    echo ""

    local ALT_CHOICE
    while true; do
      echo -en "${CYAN}Choose [a/b/c]: ${NC}"
      read -r ALT_CHOICE
      if [ "$ALT_CHOICE" = "back" ]; then return 1; fi
      case "$ALT_CHOICE" in
        a|A|b|B|c|C) break ;;
        *) warn "Please choose a, b, or c." ;;
      esac
    done

    case "$ALT_CHOICE" in
      a|A) # ── Self-proxy ───────────────────────────────────────────
        NET_MODE="self-proxy"
        echo ""
        echo -e "${DIM}Concord will listen on all interfaces on the port below.${NC}"
        echo -e "${DIM}Point your reverse proxy at this port — Concord serves plain HTTP${NC}"
        echo -e "${DIM}internally, so your proxy handles TLS termination.${NC}"
        echo ""

        read_input "Listen port: " "${HTTP_PORT:-8080}" HTTP_PORT || return 1

        echo ""
        echo -e "${DIM}What URL will users use to access the app through your proxy?${NC}"
        echo -e "${DIM}This is used for invite links and client configuration.${NC}"
        read_input "External URL (e.g. https://chat.example.com): " "${SITE_URL:-}" SITE_URL || return 1

        SITE_ADDRESS=":8080"
        LIVEKIT_TURN_DOMAIN=$(echo "$SITE_URL" | sed 's|^https\?://||' | sed 's|[:/].*||')
        LIVEKIT_TURN_DOMAIN=${LIVEKIT_TURN_DOMAIN:-$LAN_IP}
        TURN_HOST="${LIVEKIT_TURN_DOMAIN}"

        echo ""
        info "Listening on 0.0.0.0:${HTTP_PORT}"
        echo -e "  ${DIM}Proxy your domain → http://<this-host>:${HTTP_PORT}${NC}"
        echo ""
        echo -e "  ${YELLOW}Voice relay note:${NC} If your domain goes through a CDN (Cloudflare, etc.),"
        echo -e "  ${DIM}create a DNS record for ${BOLD}turn.${LIVEKIT_TURN_DOMAIN}${NC}${DIM} pointing directly to this${NC}"
        echo -e "  ${DIM}server's IP (no CDN proxy), then set TURN_HOST in .env.${NC}"
        ;;

      b|B) # ── Local only ───────────────────────────────────────────
        NET_MODE="local"
        echo ""
        echo -e "${DIM}Concord will only be accessible from this machine (127.0.0.1).${NC}"
        echo ""

        read_input "Port: " "${HTTP_PORT:-8080}" HTTP_PORT || return 1

        BIND_HOST="127.0.0.1"
        SITE_ADDRESS=":8080"
        SITE_URL="http://localhost:${HTTP_PORT}"
        LIVEKIT_TURN_DOMAIN="localhost"
        TURN_HOST="localhost"

        echo ""
        info "Bound to localhost:${HTTP_PORT}"
        ;;

      c|C) # ── Manual ───────────────────────────────────────────────
        NET_MODE="manual"
        echo ""
        echo -e "${DIM}Caddy site address: domain = auto-HTTPS, :PORT = HTTP-only${NC}"
        read_input "Caddy site address: " "${SITE_ADDRESS:-:8080}" SITE_ADDRESS || return 1

        echo ""
        read_input "HTTP port: " "${HTTP_PORT:-8080}" HTTP_PORT || return 1

        if [[ "$SITE_ADDRESS" != :* ]]; then
          USE_HTTPS=true
          DOMAIN="$SITE_ADDRESS"
        fi

        echo ""
        if [ "$USE_HTTPS" = true ]; then
          read_input "Site URL: " "${SITE_URL:-https://${SITE_ADDRESS}:8443}" SITE_URL || return 1
        else
          read_input "Site URL: " "${SITE_URL:-http://${LAN_IP}:${HTTP_PORT}}" SITE_URL || return 1
        fi

        echo ""
        read_input "Bind address [0.0.0.0]: " "${BIND_HOST:-0.0.0.0}" BIND_HOST || return 1

        echo ""
        read_input "TURN domain (realm): " "${LIVEKIT_TURN_DOMAIN:-${DOMAIN:-$LAN_IP}}" LIVEKIT_TURN_DOMAIN || return 1
        echo ""
        echo -e "${DIM}TURN host is the address clients connect to for voice relay.${NC}"
        echo -e "${DIM}If your domain is behind a CDN, use a direct IP or subdomain.${NC}"
        read_input "TURN host: " "${TURN_HOST:-${LIVEKIT_TURN_DOMAIN}}" TURN_HOST || return 1

        echo ""
        info "Manual network configuration set"
        ;;
    esac
  fi
}

# ── Step 4: Optional Integrations ────────────────────────────────────

wizard_step_4() {
  step_header 4 "Optional Integrations"

  echo -e "${DIM}These are all optional. Select the ones you'd like to set up.${NC}"
  echo -e "${DIM}You can always configure these later by editing .env${NC}"
  echo ""
  echo -e "  ${BOLD}1${NC}  Email Invites          ${DIM}Send server invitations via email (requires SMTP)${NC}"
  echo -e "  ${BOLD}2${NC}  Sound Effects Library   ${DIM}Browse/import sounds from Freesound.org${NC}"
  echo ""
  echo -e "  ${DIM}Voice relay (coturn) is built-in — no external service needed.${NC}"
  echo ""
  echo -en "${CYAN}Enter choices (e.g. 1 2), or press Enter to skip: ${NC}"
  read -r INTEGRATIONS
  if [ "$INTEGRATIONS" = "back" ]; then return 1; fi
  INTEGRATIONS=${INTEGRATIONS:-}

  local WANT_SMTP=false
  local WANT_FREESOUND=false
  for choice in $INTEGRATIONS; do
    case "$choice" in
      1) WANT_SMTP=true ;;
      2) WANT_FREESOUND=true ;;
      *) warn "Unknown option '$choice' — skipping" ;;
    esac
  done

  # Reset integrations that weren't selected
  if [ "$WANT_SMTP" = false ]; then
    SMTP_HOST="" SMTP_PORT_VAL="587" SMTP_USER="" SMTP_PASS="" SMTP_FROM=""
  fi
  if [ "$WANT_FREESOUND" = false ]; then FREESOUND_KEY=""; fi

  # ── Email Invites setup ──
  if [ "$WANT_SMTP" = true ]; then
    echo ""
    echo -e "${BOLD}Email Invites Setup${NC}"
    echo -e "${DIM}Enter your SMTP server details for sending invitation emails.${NC}"
    read_input "SMTP host: " "${SMTP_HOST:-smtp.gmail.com}" SMTP_HOST || return 1
    read_input "SMTP port: " "$SMTP_PORT_VAL" SMTP_PORT_VAL || return 1
    read_input "SMTP username: " "$SMTP_USER" SMTP_USER || return 1
    read_secret "SMTP password: " SMTP_PASS || return 1
    read_input "From address: " "${SMTP_FROM:-$SMTP_USER}" SMTP_FROM || return 1
    info "Email invites configured"
  fi

  # ── Sound Effects Library setup ──
  if [ "$WANT_FREESOUND" = true ]; then
    echo ""
    echo -e "${BOLD}Sound Effects Library Setup${NC}"
    echo -e "${DIM}Freesound.org lets users browse and import sound effects into${NC}"
    echo -e "${DIM}their soundboards. Sign up for a free API key at:${NC}"
    echo -e "${BOLD}https://freesound.org/apiv2/apply${NC}"
    echo ""
    read_input "Freesound API key: " "$FREESOUND_KEY" FREESOUND_KEY || return 1
    info "Sound effects library configured"
  fi

}

# ═══════════════════════════════════════════════════════════════════════
# Main wizard loop
# ═══════════════════════════════════════════════════════════════════════

CURRENT_STEP=1
GOING_BACK=false

while [ $CURRENT_STEP -le $TOTAL_STEPS ]; do
  if "wizard_step_${CURRENT_STEP}"; then
    # Step completed — advance
    GOING_BACK=false
    CURRENT_STEP=$((CURRENT_STEP + 1))
  else
    # User typed 'back' — go to previous step (minimum 1)
    GOING_BACK=true
    if [ $CURRENT_STEP -gt 1 ]; then
      CURRENT_STEP=$((CURRENT_STEP - 1))
    else
      warn "Already at the first step."
    fi
  fi
done

# ═══════════════════════════════════════════════════════════════════════
# Generate secrets & write config
# ═══════════════════════════════════════════════════════════════════════

# ── Derive CONDUWUIT_SERVER_NAME from network config ─────────────────
# Matrix server names are permanent and appear in user IDs (@user:name).
# They must be domain-like (lowercase, no spaces). Use the actual domain
# when available; otherwise generate a safe slug.
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9.-'
}

case "$NET_MODE" in
  automatic)
    # Has a real domain from step 3
    MATRIX_SERVER_NAME="$DOMAIN"
    ;;
  self-proxy)
    # Extract domain from the external URL
    MATRIX_SERVER_NAME=$(echo "$SITE_URL" | sed 's|^https\?://||' | sed 's|[:/].*||')
    ;;
  local)
    MATRIX_SERVER_NAME="localhost"
    ;;
  manual)
    if [ -n "$DOMAIN" ]; then
      MATRIX_SERVER_NAME="$DOMAIN"
    else
      MATRIX_SERVER_NAME="$(slugify "$SERVER_NAME").local"
    fi
    ;;
  *)
    MATRIX_SERVER_NAME="$(slugify "$SERVER_NAME").local"
    ;;
esac

ADMIN_USER_ID="@${ADMIN_USERNAME}:${MATRIX_SERVER_NAME}"

echo ""
echo -e "${BOLD}── Generating secrets ──${NC}"

REG_TOKEN=$(generate_secret)
info "Registration token generated"

LK_KEY="API$(generate_secret | tr -dc 'A-Za-z0-9' | head -c 12)"
LK_SECRET=$(generate_secret)
info "LiveKit API key/secret generated"

TURN_SECRET_VAL=$(generate_secret)
info "TURN shared secret generated"

# Generate override based on network mode
rm -f docker-compose.override.yml

# Start override with header
echo "# Auto-generated by install.sh — do not edit manually" > docker-compose.override.yml
echo "services:" >> docker-compose.override.yml

if [ "$NET_MODE" = "automatic" ] && [ -n "$TUNNEL_TOKEN" ]; then
  cat >> docker-compose.override.yml <<'OVERRIDEEOF'
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    depends_on:
      web:
        condition: service_healthy
    networks:
      - concord
OVERRIDEEOF
  info "Cloudflare Tunnel service added (docker-compose.override.yml)"
elif [ "$USE_HTTPS" = true ]; then
  cat >> docker-compose.override.yml <<'OVERRIDEEOF'
  web:
    ports:
      - "${BIND_HOST:-0.0.0.0}:8443:8443"
OVERRIDEEOF
  info "HTTPS port mapping enabled (docker-compose.override.yml)"
fi

COTURN_PUBLIC_IP="${SERVER_PUBLIC_IP:-$(detect_public_ip)}"
COTURN_LOCAL_IP="$(detect_lan_ip)"
TURN_EXTERNAL_IP=""
if [ -n "$COTURN_PUBLIC_IP" ] && [ -n "$COTURN_LOCAL_IP" ] && [ "$COTURN_PUBLIC_IP" != "$COTURN_LOCAL_IP" ]; then
  TURN_EXTERNAL_IP="${COTURN_PUBLIC_IP}/${COTURN_LOCAL_IP}"
  info "coturn external-ip: ${TURN_EXTERNAL_IP}"
elif [ -n "$COTURN_PUBLIC_IP" ]; then
  TURN_EXTERNAL_IP="${COTURN_PUBLIC_IP}"
  info "coturn external-ip: ${TURN_EXTERNAL_IP}"
fi

# ── Write .env ───────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Writing configuration ──${NC}"

ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  warn ".env already exists — backing up to .env.backup"
  cp "$ENV_FILE" ".env.backup"
  rm -f "$ENV_FILE"
fi

cat > "$ENV_FILE" <<ENVEOF
# Concord Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# WARNING: CONDUWUIT_SERVER_NAME cannot be changed after first run.

# ── Matrix Server Name ─────────────────────────────────────────────
# PERMANENT: appears in user IDs (@user:${MATRIX_SERVER_NAME}).
# Changing this after first run will break the database.
CONDUWUIT_SERVER_NAME="${MATRIX_SERVER_NAME}"
CONDUWUIT_REGISTRATION_TOKEN="${REG_TOKEN}"
CONDUWUIT_PORT=6167

# ── Instance Title ─────────────────────────────────────────────────
# Display name shown on the login page and in the app. Safe to change
# at any time — does not affect user IDs or the Matrix server name.
INSTANCE_NAME="${SERVER_NAME}"

# ── Network ────────────────────────────────────────────────────────
# SITE_ADDRESS controls Caddy: a domain enables auto-HTTPS,
# :PORT enables HTTP-only. Change and restart to switch modes.
SITE_ADDRESS="${SITE_ADDRESS}"
HTTP_PORT=${HTTP_PORT}
BIND_HOST="${BIND_HOST}"
SITE_URL="${SITE_URL}"

# ── Cloudflare Tunnel ────────────────────────────────────────────
# Set by the installer when using automatic mode. Leave empty to disable.
TUNNEL_TOKEN="${TUNNEL_TOKEN}"

# ── LiveKit (Voice/Video) ─────────────────────────────────────────
LIVEKIT_API_KEY="${LK_KEY}"
LIVEKIT_API_SECRET="${LK_SECRET}"

# ── TURN Relay (bundled coturn) ───────────────────────────────────
TURN_SECRET="${TURN_SECRET_VAL}"
TURN_DOMAIN="${LIVEKIT_TURN_DOMAIN}"
TURN_HOST="${TURN_HOST:-${LIVEKIT_TURN_DOMAIN}}"
TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP}"
TURN_PUBLIC_PORT=3478
TURN_TLS_ENABLED=false
TURN_TLS_PORT=5349
TURN_PUBLIC_TLS_PORT=443
TURN_TLS_ONLY=false
TURN_TLS_CERT_DIR="./config/turn-certs"
TURN_TLS_CERT_FILE="/certs/fullchain.pem"
TURN_TLS_KEY_FILE="/certs/privkey.pem"

# ── Admin ──────────────────────────────────────────────────────────
ADMIN_USER_IDS="${ADMIN_USER_ID}"

# ── SMTP ───────────────────────────────────────────────────────────
SMTP_HOST="${SMTP_HOST}"
SMTP_PORT=${SMTP_PORT_VAL}
SMTP_USER="${SMTP_USER}"
SMTP_PASSWORD="${SMTP_PASS}"
SMTP_FROM="${SMTP_FROM}"

# ── Freesound API ──────────────────────────────────────────────────
FREESOUND_API_KEY="${FREESOUND_KEY}"
ENVEOF

info "Configuration written to .env"

# ── Federation config migration ──────────────────────────────────────────
# Concord 0.2.0 moved federation allowlist settings from .env environment
# variables to config/tuwunel.toml so the admin UI can hot-edit them at
# runtime. This runs on every install and is a no-op for fresh setups.
if [ -x "./scripts/migrate-federation-config.sh" ]; then
  ./scripts/migrate-federation-config.sh || warn "Federation config migration reported a non-zero exit — review output above"
fi

# ═══════════════════════════════════════════════════════════════════════
# Launch prompt
# ═══════════════════════════════════════════════════════════════════════

echo ""
info "Configuration complete."
echo ""
echo -en "${CYAN}Bring ${SERVER_NAME} online now? [Y/n]: ${NC}"
read -r LAUNCH_NOW
LAUNCH_NOW=${LAUNCH_NOW:-Y}

if [[ ! "$LAUNCH_NOW" =~ ^[Yy] ]]; then
  echo ""
  info "Configuration saved. To start later, run:"
  echo ""
  echo -e "  ${BOLD}docker compose up -d --build${NC}"
  echo ""
  exit 0
fi

# ── Build & Launch ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── Building and starting ${SERVER_NAME} ──${NC}"

echo -e "${DIM}This will download container images and build the application.${NC}"
echo -e "${DIM}First run may take 2-5 minutes depending on your connection.${NC}"
echo ""

$DOCKER_SUDO docker compose up -d --build --pull=missing 2>&1 | while IFS= read -r line; do
  echo -e "  ${DIM}${line}${NC}"
done

echo ""

# ── Wait for API to be ready ─────────────────────────────────────────────

echo -e "${BOLD}── Waiting for services to start ──${NC}"

MAX_WAIT=120
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sf "http://localhost:${HTTP_PORT}/api/health" &>/dev/null 2>&1; then
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

sleep 3  # Give conduwuit a moment after API is ready

# ── Create Admin Account ─────────────────────────────────────────────────

echo -e "${BOLD}── Creating admin account ──${NC}"

REG_URL="http://localhost:${HTTP_PORT}/api/register"

REG_RESPONSE=$(curl -sf "$REG_URL" \
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

# ═══════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════

NAME_LEN=${#SERVER_NAME}
PAD=$((23 - NAME_LEN))
PAD_STR=""
if [ $PAD -gt 0 ]; then
  PAD_STR=$(printf '%*s' "$PAD" '')
fi

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       ${SERVER_NAME} is ready!${PAD_STR}║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Web interface:${NC}  ${SITE_URL}"
echo -e "  ${BOLD}Admin account:${NC}  ${ADMIN_USERNAME}"
echo -e "  ${BOLD}User IDs:${NC}       @username:${MATRIX_SERVER_NAME}"
echo -e "  ${BOLD}Display name:${NC}   ${SERVER_NAME}  ${DIM}(change INSTANCE_NAME in .env anytime)${NC}"
echo ""
echo -e "  ${DIM}Useful commands:${NC}"
echo -e "    docker compose logs -f        ${DIM}# View live logs${NC}"
echo -e "    docker compose restart         ${DIM}# Restart services${NC}"
echo -e "    docker compose down            ${DIM}# Stop services${NC}"
echo -e "    docker compose up -d --build   ${DIM}# Rebuild after changes${NC}"
echo ""

case "$NET_MODE" in
  self-proxy)
    echo -e "  ${YELLOW}Note:${NC} Proxy your domain → http://localhost:${HTTP_PORT}"
    echo -e "  ${DIM}Make sure your proxy forwards WebSocket connections for voice chat.${NC}"
    echo ""
    ;;
  local)
    echo -e "  ${YELLOW}Note:${NC} Bound to localhost only — not accessible from other machines."
    echo -e "  ${DIM}Re-run the installer to change network mode.${NC}"
    echo ""
    ;;
  automatic)
    echo -e "  ${DIM}Traffic is routed through a Cloudflare Tunnel — no ports exposed.${NC}"
    echo -e "  ${DIM}HTTPS is handled by Cloudflare.${NC}"
    echo ""
    ;;
esac
