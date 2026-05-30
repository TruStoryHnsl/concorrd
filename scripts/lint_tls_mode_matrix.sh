#!/usr/bin/env bash
# Validate both Caddyfiles adapt cleanly across the full TLS_MODE
# matrix. Runs `caddy validate` inside a vanilla `caddy:alpine` image
# for internal_longlived + letsencrypt_http01 modes, and `caddy adapt`
# inside the project's custom-built `concord-web` image (which carries
# the caddy-dns/cloudflare plugin) for letsencrypt_dns01_cloudflare.
#
# When `concord-web:latest` is not present locally (e.g. fresh CI run
# without a prior build), the DNS-01 case is skipped with a warning
# instead of failing the lint — building the web image just to validate
# config takes 5+ minutes and is not a useful CI gate. Operators run
# this locally after `docker compose build web` to exercise the DNS-01
# path.
#
# Exit codes:
#   0 — all modes adapt cleanly
#   1 — one or more modes fail adaptation
#   2 — Caddy image not available (network failure, etc.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:alpine}"
CONCORD_WEB_IMAGE="${CONCORD_WEB_IMAGE:-concord-web:latest}"

pass=0
fail=0
skipped=0

validate_one() {
    local caddyfile="$1"
    local mode="$2"
    local image="$3"

    # When `mode` is empty, leave TLS_MODE UNSET (not set-to-empty) so
    # Caddy's `{$TLS_MODE:<default>}` placeholder uses the in-file
    # fallback. Caddy treats set-to-empty as a valid empty value and
    # WON'T apply the default — which is fine in production because
    # docker-compose's `${TLS_MODE:-letsencrypt_http01}` substitution
    # always supplies a non-empty value, but for standalone Caddy
    # validation we need the in-file fallback to work too.
    local tls_arg=()
    if [ -n "${mode}" ]; then
        tls_arg=(-e "TLS_MODE=${mode}")
    fi

    local out
    out=$(docker run --rm \
        -v "${REPO_ROOT}/config:/etc/concord-config:ro" \
        -e SITE_ADDRESS=test.example.com \
        -e CONDUWUIT_SERVER_NAME=test.example.com \
        -e MATRIX_BASE_URL=https://test.example.com \
        "${tls_arg[@]}" \
        -e ACME_EMAIL="internal@example.invalid" \
        -e CLOUDFLARE_API_TOKEN="abcdefghijklmnopqrstuvwxyz0123456789ABCD" \
        --entrypoint caddy \
        "${image}" \
        adapt --config "/etc/concord-config/${caddyfile}" --adapter caddyfile \
        2>&1) || true

    if echo "${out}" | grep -q '^Error:'; then
        echo "[FAIL] ${caddyfile} TLS_MODE=${mode:-<unset>} (image ${image})"
        echo "${out}" | grep '^Error:' | head -3 | sed 's/^/    /'
        fail=$((fail + 1))
    else
        echo "[OK]   ${caddyfile} TLS_MODE=${mode:-<unset>} (image ${image})"
        pass=$((pass + 1))
    fi
}

skip_one() {
    local caddyfile="$1"
    local mode="$2"
    local reason="$3"
    echo "[SKIP] ${caddyfile} TLS_MODE=${mode} — ${reason}"
    skipped=$((skipped + 1))
}

# Modes that don't need a custom Caddy plugin can validate against
# vanilla caddy:alpine — cheap, no network/build required beyond an
# initial image pull (cached in CI).
if ! docker image inspect "${CADDY_IMAGE}" >/dev/null 2>&1; then
    echo "Pulling ${CADDY_IMAGE}..."
    if ! docker pull "${CADDY_IMAGE}"; then
        echo "ERROR: could not pull ${CADDY_IMAGE} — check network." >&2
        exit 2
    fi
fi

for caddyfile in Caddyfile Caddyfile.dev; do
    for mode in "" "internal_longlived" "letsencrypt_http01"; do
        validate_one "${caddyfile}" "${mode}" "${CADDY_IMAGE}"
    done
done

# letsencrypt_dns01_cloudflare requires the caddy-dns/cloudflare plugin,
# which only the project-built concord-web image carries. Skip if not
# present locally rather than building.
if docker image inspect "${CONCORD_WEB_IMAGE}" >/dev/null 2>&1; then
    for caddyfile in Caddyfile Caddyfile.dev; do
        validate_one "${caddyfile}" "letsencrypt_dns01_cloudflare" "${CONCORD_WEB_IMAGE}"
    done
else
    for caddyfile in Caddyfile Caddyfile.dev; do
        skip_one "${caddyfile}" "letsencrypt_dns01_cloudflare" "${CONCORD_WEB_IMAGE} not built (run 'docker compose build web')"
    done
fi

echo
echo "TLS_MODE matrix: ${pass} pass / ${fail} fail / ${skipped} skip"

if [ "${fail}" -gt 0 ]; then
    exit 1
fi
exit 0
