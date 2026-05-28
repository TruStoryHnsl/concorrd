# Stage 1: Build React client
FROM node:22-alpine AS build
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Stage 2: Build a custom Caddy with the caddy-dns/cloudflare plugin baked in.
#
# Why a custom build: vanilla caddy:alpine does NOT include the Cloudflare DNS
# provider module. We need it for Let's Encrypt DNS-01 challenges on origins
# that aren't reachable from the public internet — e.g. dev.concorrd.com,
# whose A record points at a Tailscale IP. HTTP-01 ACME can't reach the
# origin in that topology, so DNS-01 (which proves control via DNS TXT
# records rather than HTTP) is the only viable path. Production deployments
# behind Cloudflare's CDN can also use DNS-01 if they prefer not to expose
# the origin's HTTP port to LE validation traffic.
#
# Required env var at runtime:
#   CLOUDFLARE_API_TOKEN — a Cloudflare API token with Zone:Read + DNS:Edit
#     permissions scoped to the zone(s) Caddy needs to issue certs for.
#     See .env.example for details and rotation guidance.
#
# When the Caddyfile does NOT include a `tls { dns cloudflare ... }` directive,
# this plugin sits inert; the binary still serves HTTP/HTTP-01-ACME builds
# identically to vanilla caddy:alpine. Safe to use for all deployment modes.
FROM caddy:2-builder-alpine AS caddy-build
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

# Stage 3: Final runtime image — vanilla caddy:alpine base with the custom
# binary swapped in. Keeps the rest of the image (CA bundle, default config
# layout, entrypoint) identical to the upstream image so behaviour matches
# what operators expect from `caddy:alpine` documentation.
FROM caddy:alpine
COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy
COPY --from=build /app/dist /srv/html
EXPOSE 8080 8443 443
