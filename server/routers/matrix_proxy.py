"""Rate-limited Matrix login proxy.

The Matrix Client-Server `/login` endpoint is normally exposed by the
homeserver (tuwunel/conduwuit) directly via Caddy's `handle /_matrix/*`
block. Because Caddy doesn't enforce per-IP rate limiting on that route
and tuwunel does not implement a configurable per-IP login throttle,
nothing in front of the homeserver stops a hostile page (or scripted
client) from running an online dictionary attack against a known
username.

This router moves `/_matrix/client/{version}/login` through concord-api
so the same per-IP rate-limit machinery used by `/api/register` covers
it. Everything else under `/_matrix/*` continues to go straight to
tuwunel — only the login endpoint is intercepted.

Caddy is updated (config/Caddyfile + config/Caddyfile.dev) so the more
specific `handle /_matrix/client/*/login` block matches before the
generic `/_matrix/*` catch-all.

Filed under F1 of the 2026-05-18 password-leak pentest report.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict, deque

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["matrix-proxy"])

# Upstream homeserver. Hard-coded service name on the docker network;
# concord-api always runs alongside tuwunel.
CONDUWUIT_URL = "http://conduwuit:6167"

# Per-IP login rate limit. 30 attempts per 5-minute sliding window
# tolerates legitimate password typos + form re-submits while making
# online dictionary attacks impractical (30 * 12 = 360 attempts/hour
# per IP, vs. a typical wordlist of millions). Tune in concert with
# any future server-side `forbidden_failed_login` lockout in tuwunel.
_LOGIN_RATE_LIMIT = 30
_LOGIN_WINDOW = 300  # seconds

# Same sliding-window deque-per-IP pattern as registration.py. See the
# docstring there for the periodic-sweep rationale.
_login_rate_limits: dict[str, deque[float]] = defaultdict(deque)
_login_sweep_counter = 0
_LOGIN_SWEEP_INTERVAL = 1000


def _sweep_login_rate_limits(now: float) -> None:
    cutoff = now - _LOGIN_WINDOW
    for key in list(_login_rate_limits.keys()):
        window = _login_rate_limits.get(key)
        if not window:
            _login_rate_limits.pop(key, None)
            continue
        while window and window[0] < cutoff:
            window.popleft()
        if not window:
            _login_rate_limits.pop(key, None)


def _check_login_rate_limit(ip: str) -> bool:
    """Return True if the IP is within the rate budget, False if exceeded."""
    global _login_sweep_counter
    now = time.time()

    _login_sweep_counter += 1
    if _login_sweep_counter >= _LOGIN_SWEEP_INTERVAL:
        _login_sweep_counter = 0
        _sweep_login_rate_limits(now)

    window = _login_rate_limits[ip]
    while window and window[0] < now - _LOGIN_WINDOW:
        window.popleft()
    if not window:
        del _login_rate_limits[ip]
        window = _login_rate_limits[ip]
    if len(window) >= _LOGIN_RATE_LIMIT:
        return False
    window.append(now)
    return True


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Trusts X-Forwarded-For (Caddy sets it for
    us; the request never reaches concord-api from outside the docker
    network, so a request without XFF is from a local source we already
    trust)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # First entry is the original client; later entries are proxies.
        return xff.split(",")[0].strip()
    if request.client is not None:
        return request.client.host
    return "unknown"


# Hop-by-hop headers per RFC 7230 §6.1 — these must not be forwarded
# through a proxy. Also drop Host so httpx can set the upstream value.
_HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",  # httpx sets this from the body
})


@router.api_route(
    "/_matrix/client/{version}/login",
    methods=["GET", "POST", "OPTIONS"],
    # FastAPI normally namespaces under the router prefix; for this
    # proxy we want the upstream path to match exactly, so no prefix.
)
async def matrix_login_proxy(version: str, request: Request) -> Response:
    """Proxy /_matrix/client/{version}/login to tuwunel with per-IP rate limit.

    Covers v3 (current), r0 (legacy), and unstable variants in one
    parameterised handler. CORS preflight (OPTIONS) is forwarded but
    not rate-limited — preflights carry no credentials and a hostile
    page that wants to mount a dictionary attack still has to send the
    POST that the rate limit catches.
    """
    if request.method != "OPTIONS":
        ip = _client_ip(request)
        if not _check_login_rate_limit(ip):
            logger.warning(
                "matrix_login_proxy: rate-limit hit for ip=%s version=%s",
                ip,
                version,
            )
            # Matrix spec error responses are bare JSON, not FastAPI's
            # `{"detail": ...}` envelope. Return JSONResponse directly so
            # Element / matrix-js-sdk / hydrogen surface the correct
            # errcode + retry_after_ms to the user.
            return JSONResponse(
                status_code=429,
                content={
                    "errcode": "M_LIMIT_EXCEEDED",
                    "error": "Too many login attempts. Try again later.",
                    "retry_after_ms": _LOGIN_WINDOW * 1000,
                },
            )

    upstream_url = f"{CONDUWUIT_URL}/_matrix/client/{version}/login"
    upstream_headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP
    }
    body = await request.body()

    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        try:
            upstream = await client.request(
                method=request.method,
                url=upstream_url,
                params=request.query_params,
                content=body,
                headers=upstream_headers,
            )
        except httpx.RequestError as exc:
            logger.error("matrix_login_proxy: upstream error: %s", exc)
            return JSONResponse(
                status_code=502,
                content={"errcode": "M_UNKNOWN", "error": "Homeserver unreachable"},
            )

    response_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )
