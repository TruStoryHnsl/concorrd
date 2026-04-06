#!/usr/bin/env bash
# scripts/migrate-federation-config.sh
#
# One-time migration helper for the federation config move from .env
# environment variables to config/tuwunel.toml. Safe to run repeatedly —
# it's a no-op if there's nothing to migrate.
#
# What it does:
#   1. Detects if .env has CONDUWUIT_ALLOW_FEDERATION / FORBIDDEN_REMOTE_
#      SERVER_NAMES / ALLOWED_REMOTE_SERVER_NAMES set to non-default values.
#   2. If yes, parses them and rewrites config/tuwunel.toml to preserve
#      the existing allowlist (so federation doesn't regress after upgrade).
#   3. Comments out the old vars in .env with a pointer to the new file.
#   4. Backs up the original .env to .env.backup-fedmigrate before editing.
#
# Runs automatically near the end of install.sh, or can be invoked manually:
#   ./scripts/migrate-federation-config.sh
#
# Exit codes:
#   0  migration succeeded or no-op
#   1  .env not found (nothing to migrate from)
#   2  parse error — manual intervention needed

set -euo pipefail

# Resolve paths relative to the script, so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
TOML_FILE="${ROOT_DIR}/config/tuwunel.toml"
TOML_DIR="$(dirname "${TOML_FILE}")"

# Colors (only when stdout is a tty)
if [ -t 1 ]; then
  BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[32m'
  YELLOW='\033[33m'; CYAN='\033[36m'; NC='\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

say()  { printf '%b\n' "$*"; }
info() { say "${CYAN}${BOLD}→${NC} $*"; }
ok()   { say "${GREEN}${BOLD}✓${NC} $*"; }
warn() { say "${YELLOW}${BOLD}!${NC} $*"; }

# ─── Preconditions ──────────────────────────────────────────────────────
if [ ! -f "${ENV_FILE}" ]; then
  say "${DIM}No .env file at ${ENV_FILE} — nothing to migrate.${NC}"
  exit 1
fi

mkdir -p "${TOML_DIR}"

# ─── Detect old federation vars in .env ─────────────────────────────────
# We match only uncommented lines with a value. Quotes are allowed.
grab() {
  # grab VAR_NAME -> prints the value (with surrounding quotes stripped) or empty
  local var="$1"
  # shellcheck disable=SC2016
  awk -v v="${var}" '
    $0 ~ "^[[:space:]]*"v"[[:space:]]*=" {
      sub(/^[[:space:]]*[A-Z_]+[[:space:]]*=[[:space:]]*/, "")
      gsub(/^[\x27"]|[\x27"][[:space:]]*$/, "")
      print
      exit
    }
  ' "${ENV_FILE}"
}

OLD_ALLOW="$(grab CONDUWUIT_ALLOW_FEDERATION || true)"
OLD_FORBIDDEN="$(grab CONDUWUIT_FORBIDDEN_REMOTE_SERVER_NAMES || true)"
OLD_ALLOWED="$(grab CONDUWUIT_ALLOWED_REMOTE_SERVER_NAMES || true)"

if [ -z "${OLD_ALLOW}${OLD_FORBIDDEN}${OLD_ALLOWED}" ]; then
  say "${DIM}No legacy federation env vars found in .env — nothing to migrate.${NC}"
  # Still ensure config/tuwunel.toml exists so docker compose up won't fail
  # on the bind mount. If missing (unexpected for a fresh clone), seed with
  # the repo default.
  if [ ! -f "${TOML_FILE}" ]; then
    warn "config/tuwunel.toml missing — creating with defaults"
    cat > "${TOML_FILE}" <<'TOMLEOF'
[global]
allow_federation = true
forbidden_remote_server_names = [".*"]
allowed_remote_server_names = []
TOMLEOF
    ok "Wrote default config/tuwunel.toml"
  fi
  exit 0
fi

info "Legacy federation config detected in .env — migrating to config/tuwunel.toml"

# ─── Parse values ────────────────────────────────────────────────────────
# allow_federation: bool (default true)
NEW_ALLOW_FED="true"
if [ -n "${OLD_ALLOW}" ]; then
  case "$(printf '%s' "${OLD_ALLOW}" | tr '[:upper:]' '[:lower:]')" in
    false|0|no) NEW_ALLOW_FED="false" ;;
    *)          NEW_ALLOW_FED="true"  ;;
  esac
fi

# forbidden_remote_server_names / allowed_remote_server_names:
# both are stringified JSON arrays of regex patterns, e.g.:
#   '[".*"]'
#   '["friend\\.example\\.com$", "office\\.example\\.net$"]'
# We just strip the outer brackets/quotes and emit each element verbatim
# into the TOML array, since the regex escaping is already in the right
# form for Tuwunel.
json_array_to_toml() {
  local raw="$1"
  # Empty or missing -> []
  if [ -z "${raw}" ] || [ "${raw}" = "[]" ]; then
    printf '[]'
    return 0
  fi
  # Strip surrounding [ and ]. Keep the inner string — it's already TOML-ish
  # because JSON strings use "..." and TOML basic strings also use "...".
  local inner
  inner="${raw#\[}"
  inner="${inner%\]}"
  printf '[%s]' "${inner}"
}

NEW_FORBIDDEN="$(json_array_to_toml "${OLD_FORBIDDEN:-[\".*\"]}")"
NEW_ALLOWED="$(json_array_to_toml "${OLD_ALLOWED:-[]}")"

# ─── Back up and write new TOML ──────────────────────────────────────────
if [ -f "${TOML_FILE}" ]; then
  cp "${TOML_FILE}" "${TOML_FILE}.pre-migrate-$(date +%s).bak"
fi

TMP="${TOML_FILE}.tmp"
cat > "${TMP}" <<TOMLEOF
# Tuwunel runtime configuration — federation settings
# Migrated from .env by scripts/migrate-federation-config.sh on $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Managed by the Concord admin UI. Hand edits to [global] keys will be
# overwritten on the next federation allowlist update.

[global]
allow_federation = ${NEW_ALLOW_FED}
forbidden_remote_server_names = ${NEW_FORBIDDEN}
allowed_remote_server_names = ${NEW_ALLOWED}
TOMLEOF
mv "${TMP}" "${TOML_FILE}"
ok "Wrote ${TOML_FILE}"

# ─── Comment out old vars in .env ────────────────────────────────────────
cp "${ENV_FILE}" "${ENV_FILE}.backup-fedmigrate"

# Use portable sed-in-place. macOS and BSD sed need -i '' ; GNU sed needs -i.
# Detect which by trying the GNU form first.
sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"       # GNU
  else
    sed -i '' "$@"    # BSD/macOS
  fi
}

for var in CONDUWUIT_ALLOW_FEDERATION \
           CONDUWUIT_FORBIDDEN_REMOTE_SERVER_NAMES \
           CONDUWUIT_ALLOWED_REMOTE_SERVER_NAMES; do
  sed_inplace "s|^[[:space:]]*${var}[[:space:]]*=|# (migrated to config/tuwunel.toml) ${var}=|" "${ENV_FILE}" || true
done

ok "Commented out legacy vars in ${ENV_FILE} (backup at .env.backup-fedmigrate)"
say ""
say "${BOLD}Migration complete.${NC} The federation allowlist now lives in"
say "  ${CYAN}config/tuwunel.toml${NC}"
say ""
say "The Concord admin UI at ${DIM}Settings → Admin → Federation${NC} can edit this"
say "file at runtime and apply changes via a Matrix server restart. The legacy"
say "env vars in .env are no longer read by docker-compose.yml."
