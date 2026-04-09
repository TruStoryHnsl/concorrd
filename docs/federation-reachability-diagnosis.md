# Federation Reachability Diagnosis (INS-026)

**Date**: 2026-04-08
**Trigger**: Explore menu (INS-025) first end-to-end test against
`matrix.org` returned `401 M_UNAUTHORIZED: Failed to find any key to
satisfy _FetchKeyRequest(server_name='concorrd.com', ...)`.

**Status**: **Resolved.** `https://federationtester.matrix.org/api/report?server_name=concorrd.com`
returns `FederationOK: True` after the fix.

## TL;DR

Concord's Caddyfile proxied `/.well-known/matrix/*` to the tuwunel
homeserver. Tuwunel does not implement `.well-known` endpoints — they
are supposed to be **static files served by the reverse proxy**. Every
federating server asking for `concorrd.com`'s `.well-known/matrix/server`
received an HTTP 404 JSON body from tuwunel (`{"errcode":"M_NOT_FOUND"}`),
fell back through the Matrix server-discovery ladder to the default
federation port 8448, and failed to reach it because **port 8448 is not
exposed through Cloudflare's proxy tier** — Cloudflare only forwards a
fixed set of ports (80, 443, 8080, 8443, 2052, 2053, 2082, 2083, 2086,
2087, 2095, 2096, plus HTTPS variants). 8448 is not on that list.

The fix replaces the proxy directive with two inline `respond` handlers
that return static JSON directly from Caddy:

```caddy
handle /.well-known/matrix/server {
    header Content-Type "application/json"
    header Access-Control-Allow-Origin "*"
    respond `{"m.server":"concorrd.com:443"}` 200
}
handle /.well-known/matrix/client {
    header Content-Type "application/json"
    header Access-Control-Allow-Origin "*"
    respond `{"m.homeserver":{"base_url":"https://concorrd.com"}}` 200
}
```

The `m.server` delegation to port 443 routes federation traffic over the
same Cloudflare-proxied endpoint that the client-server API already
uses. Tuwunel listens on port 6167 inside the `concord` Docker network;
Caddy terminates TLS at the edge, strips the `/_matrix/federation/*`
prefix is not needed because tuwunel itself handles the federation API
under that path.

## Endpoint-by-endpoint diagnostic (pre-fix)

| Endpoint | Result (external curl) | Result (internal curl to Caddy) |
|---|---|---|
| `GET /.well-known/matrix/server` | **TIMES OUT** after 10s (Cloudflare holds the response open) | `HTTP/1.1 404` with `{"errcode":"M_NOT_FOUND"}` — returned in <50ms |
| `GET /.well-known/matrix/client` | **TIMES OUT** after 10s | Same 404 as above |
| `GET /_matrix/key/v2/server` | **HTTP 200** with signed keys via `Via: 1.1 Caddy`, `cf-cache-status: DYNAMIC` | Works the same way |
| `GET /_matrix/federation/v1/version` | **HTTP 200** returning `{"server":{"name":"Tuwunel","version":"1.5.1-126 (bdad6af8a5)"}}` | Works the same way |
| `GET /_matrix/client/versions` | **HTTP 200** with full client spec versions list | Works the same way |

**Observation that unlocked the fix**: tuwunel's 404 comes back in
milliseconds from inside the Caddy container, but is held open by
Cloudflare for ≥10 seconds externally. Other endpoints in the same
path prefix (`/_matrix/*`) pass through Cloudflare cleanly with
`cf-cache-status: DYNAMIC`. This suggests Cloudflare has a rule or
cache-miss handler on `.well-known/*` responses that chokes on
upstream 404s specifically. Serving a clean 200 JSON from Caddy
bypasses the problem entirely.

## DNS and SRV state

```
$ dig @8.8.8.8 concorrd.com +short
104.21.51.58
172.67.221.170           # Cloudflare edge (proxied)

$ dig @8.8.8.8 concorrd.com AAAA +short
2606:4700:3036::6815:333a
2606:4700:3034::ac43:ddaa

$ dig @8.8.8.8 _matrix-fed._tcp.concorrd.com SRV +short
(empty)

$ dig @8.8.8.8 _matrix._tcp.concorrd.com SRV +short
(empty)
```

No SRV records. Matrix server discovery must rely on the `.well-known`
delegation — which is exactly what the fix installs.

## Config file topology (what broke on the orrgate deploy)

Worth flagging for future maintainers: the deployed Concord stack on
orrgate is running the **dev** Caddyfile (`Caddyfile.dev`), not the
production one. Confirmed via `docker compose logs web`:

```
web-1 | msg":"using config from file","file":"/etc/concord-config/Caddyfile.dev"
```

Both `Caddyfile` and `Caddyfile.dev` contained the identical broken
`handle /.well-known/matrix/*` proxy block, so this diagnosis-and-fix
updates both files. The dev Caddyfile is the one currently in
production traffic via the `web` container's restart, but the
production Caddyfile also needs the fix for the day the deploy
switches back to it.

## Remaining follow-ups (non-blocking)

Federation works — `FederationOK: True` from the authoritative Matrix
tester — but there are two residual quality issues worth capturing:

1. **Cloudflare is still slow on `.well-known/matrix/*`.** Even
   post-fix, external `curl` probes take 4–12 seconds per request,
   including occasional 15s timeouts. Other paths return in <1s.
   Cloudflare is applying some challenge/WAF/rate-limit policy to
   these specific paths. A configuration rule in the Cloudflare
   dashboard exempting `/.well-known/matrix/*` and `/_matrix/*` from
   Bot Fight Mode / Security Level / Browser Integrity Check /
   Under Attack Mode would likely restore normal latency. Federation
   peers (matrix.org et al) have long timeouts so this doesn't break
   federation, but it makes the Concord client's Explore → Browse
   flow feel sluggish.

2. **Dev stack is running in production.** The `web` container loads
   `Caddyfile.dev`, which proxies unmatched paths to `vite-dev:5173`
   for HMR. Production should load `Caddyfile` (serves static
   `/srv/html` with immutable-asset caching). Not in scope for
   INS-026; captured here so someone can swap the compose override.

## Verification commands (reproducible)

```bash
# 1. External reachability of well-known
curl -v --max-time 15 https://concorrd.com/.well-known/matrix/server
# Expected: HTTP 200, {"m.server":"concorrd.com:443"}

curl -v --max-time 15 https://concorrd.com/.well-known/matrix/client
# Expected: HTTP 200, {"m.homeserver":{"base_url":"https://concorrd.com"}}

# 2. External reachability of federation API
curl -s https://concorrd.com/_matrix/key/v2/server | jq .
# Expected: signed server keys (ed25519:OFFRKqW6 verify key present)

curl -s https://concorrd.com/_matrix/federation/v1/version | jq .
# Expected: {"server":{"name":"Tuwunel","version":"1.5.1-126 (...)"}}

# 3. Authoritative federation health check
curl -s "https://federationtester.matrix.org/api/report?server_name=concorrd.com" | jq '{FederationOK, Version: .Version.name, ConnectionErrors}'
# Expected: {"FederationOK": true, "Version": "Tuwunel", "ConnectionErrors": []}
```

## Files changed

- `config/Caddyfile` — production Caddyfile, `.well-known/matrix/*`
  proxy replaced with inline `respond` handlers.
- `config/Caddyfile.dev` — dev Caddyfile (actually running on
  orrgate), same replacement.
- `docs/federation-reachability-diagnosis.md` (this file) — audit
  trail per the INS-026 diagnostic phase requirement.

## What was NOT changed (out of scope)

- Cloudflare configuration (dashboard access not available from this
  session). The dashboard review recommended in INS-026 line 457 is a
  follow-up — the slow path is now a latency issue, not a blocker.
- Tuwunel server configuration. No changes to `.env` or
  `config/tuwunel.toml`.
- Compose file — the dev-stack-in-production topology stays as-is.
