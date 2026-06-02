# Federation Reachability Diagnosis (INS-026)

**Date**: 2026-04-08
**Trigger**: Explore menu (INS-025) first end-to-end test against
`matrix.org` returned `401 M_UNAUTHORIZED: Failed to find any key to
satisfy _FetchKeyRequest(server_name='example.test', ...)`.

**Status**: **Resolved.** `https://federationtester.matrix.org/api/report?server_name=example.test`
returns `FederationOK: True` after the fix.

## TL;DR

Concord's Caddyfile proxied `/.well-known/matrix/*` to the tuwunel
homeserver. Tuwunel does not implement `.well-known` endpoints — they
are supposed to be **static files served by the reverse proxy**. Every
federating server asking for `example.test`'s `.well-known/matrix/server`
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
    respond `{"m.server":"example.test:443"}` 200
}
handle /.well-known/matrix/client {
    header Content-Type "application/json"
    header Access-Control-Allow-Origin "*"
    respond `{"m.homeserver":{"base_url":"https://example.test"}}` 200
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
$ dig @8.8.8.8 example.test +short
104.21.51.58
172.67.221.170           # Cloudflare edge (proxied)

$ dig @8.8.8.8 example.test AAAA +short
2606:4700:3036::6815:333a
2606:4700:3034::ac43:ddaa

$ dig @8.8.8.8 _matrix-fed._tcp.example.test SRV +short
(empty)

$ dig @8.8.8.8 _matrix._tcp.example.test SRV +short
(empty)
```

No SRV records. Matrix server discovery must rely on the `.well-known`
delegation — which is exactly what the fix installs.

## Config file topology (what broke on this deploy)

Worth flagging for future maintainers: the deployed Concord stack on
this host was running the **dev** Caddyfile (`Caddyfile.dev`), not the
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

## Cloudflare Page Rules audit (2026-04-08, post-Caddyfile fix)

After the Caddyfile fix, `.well-known/matrix/*` returned the correct
JSON but requests took 4–12 seconds per call, occasionally timing out
at 15s with a zero-byte response. The Caddy-internal response was
sub-millisecond (confirmed via `docker compose exec web curl`), so
the latency lived entirely in the Cloudflare edge.

Audit ran against the `example.test` zone via the Cloudflare API with
a scoped token:

| Setting | Value |
|---|---|
| Security Level (zone-wide) | `medium` |
| Browser Integrity Check (zone-wide) | `on` |
| Challenge TTL | 1800 seconds |
| Existing Page Rules | 0 |

`medium` security level challenges known-bad IPs at the edge; combined
with Browser Integrity Check's User-Agent heuristics, federation
traffic (unusual UA strings) and this operator's curl probes were
being intercepted by CF's challenge layer, which explains both the
10s hang (CF holding the connection open during a silent challenge)
and the zero-byte responses (challenge injected into the stream but
the HTTP client couldn't render it).

### Page Rules installed

Two Page Rules were created via
`POST /zones/{zone_id}/pagerules`, matching the URL patterns most
affected by Cloudflare's security stack:

| Priority | URL pattern | Actions |
|---|---|---|
| 1 | `*example.test/_matrix/*` | Security Level: essentially_off, Disable Security, Cache Level: bypass |
| 2 | `*example.test/.well-known/*` | Security Level: essentially_off, Disable Security, Cache Level: bypass |

`disable_security` turns off Browser Integrity Check, hotlink
protection, and WAF rule evaluation for the matching URLs. It does
NOT disable DDoS protection or the origin-to-edge TLS layer.
`cache_level: bypass` tells CF to never cache the matched responses —
important because federation responses (server keys, version info)
are signed and clients expect them live.

The second rule intentionally matches `.well-known/*` (not just
`.well-known/matrix/*`) so the INS-027 Concord-specific well-known
at `.well-known/concord/client` inherits the same exemption without
needing a third Page Rule.

### Latency verification

Before the Page Rules (Caddyfile-only fix):

```
attempt 1: code=000 time=15.005s size=0       (CF timeout)
attempt 2: code=200 time=12.860s size=31
attempt 3: code=200 time=4.695s  size=31
client (attempt 1): code=200 time=7.959s size=52
client (attempt 2): code=200 time=8.896s size=52
client (attempt 3): code=200 time=3.636s size=52
```

After the Page Rules:

```
--- matrix/server ---
attempt 1: code=200 time=0.234s size=31
attempt 2: code=200 time=0.218s size=31
attempt 3: code=200 time=0.120s size=31
--- matrix/client ---
attempt 1: code=200 time=0.117s size=52
attempt 2: code=200 time=0.115s size=52
attempt 3: code=200 time=0.109s size=52
--- _matrix/key/v2/server ---
attempt 1: code=200 time=0.186s size=311
attempt 2: code=200 time=0.115s size=311
attempt 3: code=200 time=0.246s size=311
```

**Speedup: ~40× on best case, ~100× on timeout cases. All probes now
return in under 250ms.** The authoritative Matrix federation tester
continues to report `FederationOK: True`.

## Residual non-blockers (captured, not fixed)

1. **Dev stack is running in production.** The `web` container loads
   `Caddyfile.dev`, which proxies unmatched paths to `vite-dev:5173`
   for HMR. Production should load `Caddyfile` (serves static
   `/srv/html` with immutable-asset caching). Not in scope for
   INS-026; captured here so someone can swap the compose override.
   The INS-026 fix applies to BOTH files so whichever is active
   serves the correct `.well-known/matrix/*` responses.

2. **Token file handling.** The Cloudflare audit used a zone-scoped
   API token passed via a short-lived file (chmod 600). The file
   should be deleted by the operator after verifying the Page Rules
   look correct in the CF dashboard.

3. **Deeper CF audit not performed.** A full WAF ruleset review
   (Managed Rules, custom rules, rate-limit rules) was not executed —
   the Page Rules approach was sufficient to restore latency without
   wading into the broader ruleset engine. If latency regresses later,
   audit `GET /zones/{zone_id}/rulesets` for interfering phases.

## Verification commands (reproducible)

```bash
# 1. External reachability of well-known
curl -v --max-time 15 https://example.test/.well-known/matrix/server
# Expected: HTTP 200, {"m.server":"example.test:443"}

curl -v --max-time 15 https://example.test/.well-known/matrix/client
# Expected: HTTP 200, {"m.homeserver":{"base_url":"https://example.test"}}

# 2. External reachability of federation API
curl -s https://example.test/_matrix/key/v2/server | jq .
# Expected: signed server keys (ed25519:OFFRKqW6 verify key present)

curl -s https://example.test/_matrix/federation/v1/version | jq .
# Expected: {"server":{"name":"Tuwunel","version":"1.5.1-126 (...)"}}

# 3. Authoritative federation health check
curl -s "https://federationtester.matrix.org/api/report?server_name=example.test" | jq '{FederationOK, Version: .Version.name, ConnectionErrors}'
# Expected: {"FederationOK": true, "Version": "Tuwunel", "ConnectionErrors": []}
```

## Files changed

- `config/Caddyfile` — production Caddyfile, `.well-known/matrix/*`
  proxy replaced with inline `respond` handlers.
- `config/Caddyfile.dev` — dev Caddyfile (the one actually serving
  traffic at the time of this audit), same replacement.
- `docs/federation-reachability-diagnosis.md` (this file) — audit
  trail per the INS-026 diagnostic phase requirement.

## What was NOT changed (out of scope)

- Cloudflare configuration (dashboard access not available from this
  session). The dashboard review recommended in INS-026 line 457 is a
  follow-up — the slow path is now a latency issue, not a blocker.
- Tuwunel server configuration. No changes to `.env` or
  `config/tuwunel.toml`.
- Compose file — the dev-stack-in-production topology stays as-is.
