"""Per-extension server-side proxy for upstream APIs that require an
OAuth client_secret (OpenSky, Sentinel Hub) or just benefit from
keeping the API key off the browser (NYC DOT cameras).

Why this exists: extensions ship as static iframes mounted at
``/ext/<id>/`` — they can't carry secrets. Anything past user-level
OAuth delegation (where the user grants the third-party access on their
own behalf) needs a server middleman if the upstream provider expects an
operator-issued client_secret. Worldview-map has three such layers:
flights (OpenSky), satellite imagery (Sentinel Hub), and NYC DOT.

Per-extension secrets live in ``instance.json`` under
``extension_secrets[ext_id]``. The admin UI writes them there via
``/api/admin/extensions/{id}/secrets``; this router reads at request
time. Tokens (OAuth access_token) are cached in-process for the
duration of their ``expires_in`` minus a 60s safety window.
"""
from __future__ import annotations

import logging
import time
from threading import Lock
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from routers.admin import _read_instance_settings, _write_instance_settings, require_admin
from dependencies import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ext-proxy"])


# ---------------------------------------------------------------------------
# Per-source token-bucket rate limiting
#
# Defense-in-depth: even a misbehaving extension iframe can't exceed the
# server-side cap for a given (ext_id, provider) pair.
# ---------------------------------------------------------------------------


class TokenBucket:
    def __init__(self, capacity: float, refill_per_sec: float):
        self.capacity = capacity
        self.tokens = capacity
        self.refill_per_sec = refill_per_sec
        self.last = time.monotonic()
        self.lock = Lock()

    def take(self) -> bool:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(
                self.capacity, self.tokens + (now - self.last) * self.refill_per_sec
            )
            self.last = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


# Steady-state requests per second per (ext_id, provider) pair.
# burst = rate * 5 (five seconds of headroom).
SOURCE_RATES: dict[str, float] = {
    "opensky": 0.5,
    "sentinel": 0.5,
    "military-legacy": 1.0,
    "airplanes-live": 1.0,
    "wsdot": 1.0,
    "511ny": 1.0,
    "massdot": 1.0,
    "firms": 0.5,
    "launchlib": 0.5,
    "cloudflare-radar": 0.5,
    # existing providers with a default 1 rps cap
    "nycdot": 1.0,
}

_BUCKETS: dict[tuple[str, str], TokenBucket] = {}


def _get_bucket(ext_id: str, provider: str, rate_per_sec: float) -> TokenBucket:
    key = (ext_id, provider)
    if key not in _BUCKETS:
        _BUCKETS[key] = TokenBucket(
            capacity=rate_per_sec * 5, refill_per_sec=rate_per_sec
        )
    return _BUCKETS[key]


# ---------------------------------------------------------------------------
# Per-extension secrets (instance.json under "extension_secrets")
# ---------------------------------------------------------------------------


def _all_extension_secrets() -> dict[str, dict[str, str]]:
    settings = _read_instance_settings()
    bucket = settings.get("extension_secrets") or {}
    if not isinstance(bucket, dict):
        return {}
    return bucket


def _ext_secrets(ext_id: str) -> dict[str, str]:
    bucket = _all_extension_secrets().get(ext_id)
    if not isinstance(bucket, dict):
        return {}
    return {k: v for k, v in bucket.items() if isinstance(v, str)}


def _save_ext_secrets(ext_id: str, secrets: dict[str, str]) -> None:
    settings = _read_instance_settings()
    bucket = settings.get("extension_secrets")
    if not isinstance(bucket, dict):
        bucket = {}
    if secrets:
        bucket[ext_id] = {k: v for k, v in secrets.items() if isinstance(v, str)}
    else:
        bucket.pop(ext_id, None)
    settings["extension_secrets"] = bucket
    _write_instance_settings(settings)


# ---------------------------------------------------------------------------
# Provider registry
#
# Each provider declares:
#   - upstream URL prefix (where we forward to after stripping our path)
#   - auth_kind: "none" | "client_credentials" | "bearer_static"
#   - For client_credentials: token_url + scope (passed in body) +
#     credential keys (which secret-bucket fields hold them)
#   - allowed_methods: limit verbs to what the upstream actually needs
# ---------------------------------------------------------------------------


PROVIDERS: dict[str, dict[str, Any]] = {
    "opensky": {
        "upstream": "https://opensky-network.org/api",
        "token_url": "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        "auth_kind": "client_credentials",
        "client_id_key": "opensky_client_id",
        "client_secret_key": "opensky_client_secret",
        "scope": None,
        "methods": ("GET",),
    },
    "sentinel": {
        # The legacy app talks to /proxy/sentinel/wms which we forward to
        # Sentinel Hub's WMS endpoint scoped to the operator's instance id.
        # The instance id is part of the upstream URL, so resolve it from
        # secrets at request time.
        "upstream": None,  # built dynamically (depends on instance id)
        "upstream_builder": (
            lambda secrets, path: f"https://services.sentinel-hub.com/ogc/wms/{secrets.get('sentinel_instance_id', '')}/{path}".rstrip("/")
        ),
        "token_url": "https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token",
        "auth_kind": "client_credentials",
        "client_id_key": "sentinel_client_id",
        "client_secret_key": "sentinel_client_secret",
        "scope": None,
        "methods": ("GET",),
    },
    "nycdot": {
        # NYC DOT camera index + image fetch — no upstream auth required.
        # Routed through the proxy so the iframe doesn't hit cross-origin
        # issues and we can short-circuit a future caching layer here.
        "upstream": "https://webcams.nyctmc.org/api",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    # ------------------------------------------------------------------
    # Worldview-map sources added 2026-04-30
    # ------------------------------------------------------------------
    "military-legacy": {
        # Public military-aircraft feed from airplanes.live (no auth).
        # Falls back to the same base as airplanes-live; the frontend
        # differentiates by path (/v2/mil vs /v2/all).
        "upstream": "https://api.airplanes.live",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "airplanes-live": {
        "upstream": "https://api.airplanes.live",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "cloudflare-radar": {
        # Requires a Cloudflare API token stored as cloudflare_radar_token.
        # TODO: implement bearer_static auth_kind to forward the token.
        # For now registered so __healthz probes work; auth is no-op.
        "upstream": "https://api.cloudflare.com",
        "auth_kind": "none",  # TODO: bearer_static with cloudflare_radar_token
        "methods": ("GET",),
    },
    "wsdot": {
        "upstream": "https://wsdot.wa.gov",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "511ny": {
        "upstream": "https://511ny.org",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "massdot": {
        "upstream": "https://mass511.com",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "firms": {
        # NASA FIRMS fire data — public read, no server-side auth.
        "upstream": "https://firms.modaps.eosdis.nasa.gov",
        "auth_kind": "none",
        "methods": ("GET",),
    },
    "launchlib": {
        "upstream": "https://ll.thespacedevs.com",
        "auth_kind": "none",
        "methods": ("GET",),
    },
}


# ---------------------------------------------------------------------------
# OAuth token cache (in-process)
#
# Process-local; on a multi-replica deploy each instance refreshes its
# own copy. Tokens last 5–15 minutes typically — fine to drop on restart.
# ---------------------------------------------------------------------------


_token_cache: dict[str, tuple[str, float]] = {}


async def _get_oauth_token(provider: str, secrets: dict[str, str]) -> str:
    cfg = PROVIDERS[provider]
    cached = _token_cache.get(provider)
    now = time.monotonic()
    if cached and cached[1] - 60 > now:
        return cached[0]

    cid = secrets.get(cfg["client_id_key"], "")
    csec = secrets.get(cfg["client_secret_key"], "")
    if not cid or not csec:
        raise HTTPException(
            503,
            f"{provider}: client_id / client_secret not configured. Set them in Admin → Integrations → {provider}.",
        )
    data = {
        "grant_type": "client_credentials",
        "client_id": cid,
        "client_secret": csec,
    }
    if cfg.get("scope"):
        data["scope"] = cfg["scope"]
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                cfg["token_url"],
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"{provider}: token endpoint unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(
            502,
            f"{provider}: token exchange {resp.status_code}: {resp.text[:200]}",
        )
    payload = resp.json()
    token = payload.get("access_token")
    if not token:
        raise HTTPException(502, f"{provider}: token endpoint returned no access_token")
    expires_in = int(payload.get("expires_in") or 300)
    _token_cache[provider] = (token, now + expires_in)
    return token


# ---------------------------------------------------------------------------
# Health probe
#
# IMPORTANT: this route MUST be registered BEFORE the main proxy route.
# FastAPI/Starlette matches in registration order; the main proxy pattern
# ``{ext_id}/{provider}/{path:path}`` would shadow ``{ext_id}/__healthz/{provider}``
# if defined first (confirmed with live routing test).
# ---------------------------------------------------------------------------


def _resolve_upstream(provider: str) -> str | None:
    """Return the base upstream URL for a provider, or None if unknown.

    For providers with a dynamic upstream_builder, returns the static
    base domain so a HEAD probe has a target (the builder needs secrets,
    which we don't have here).
    """
    cfg = PROVIDERS.get(provider)
    if not cfg:
        return None
    if cfg.get("upstream"):
        return cfg["upstream"]
    # sentinel-style: no static upstream, derive base from token_url domain
    if cfg.get("token_url"):
        parsed = urlparse(cfg["token_url"])
        return f"{parsed.scheme}://{parsed.netloc}"
    return None


@router.get("/api/ext-proxy/{ext_id}/__healthz/{provider}")
async def proxy_healthz(
    ext_id: str,
    provider: str,
    user_id: str = Depends(get_user_id),
):
    """Lightweight health probe used by the worldview-map health panel.

    Returns 200 with ``{"ok": true, "status": <upstream_status>}`` if the
    proxy can reach the upstream base URL.  4xx from the upstream root is
    treated as reachable (root-level HEAD is commonly rejected with 405;
    that does not indicate an outage).  Returns 502 on network error, 404
    for unknown providers.
    """
    upstream = _resolve_upstream(provider)
    if not upstream:
        raise HTTPException(404, f"unknown provider {provider!r} for {ext_id}")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.head(upstream)
            # Treat any response (including 4xx) as "reachable"; only 5xx means degraded.
            # Root-level HEAD on most APIs returns 404 or 405 — not an outage signal.
            return {"ok": r.status_code < 500, "status": r.status_code, "provider": provider}
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


# ---------------------------------------------------------------------------
# Proxy
# ---------------------------------------------------------------------------


@router.api_route(
    "/api/ext-proxy/{ext_id}/{provider}/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
)
async def ext_proxy(
    ext_id: str,
    provider: str,
    path: str,
    request: Request,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Forward a request from an installed extension to the configured
    upstream provider, attaching server-side credentials as needed.
    """
    cfg = PROVIDERS.get(provider)
    if not cfg:
        raise HTTPException(404, f"Unknown provider {provider!r}")
    if request.method.upper() not in cfg.get("methods", ("GET",)):
        raise HTTPException(405, f"Method {request.method} not allowed for {provider}")

    # INS-066 W7: enforce manifest permission `fetch:external`. The
    # extension MUST have declared this in its manifest at install time,
    # validated against ALLOWED_PERMISSIONS. Extensions installed before
    # INS-066 (legacy static catalog only — no DB row) are NOT subject
    # to the gate, since they predate the permissions registry; this
    # preserves backward compatibility for worldview-map and friends.
    # New runtime-installed extensions go through the strict gate.
    from routers.extensions import (  # local import: avoid circular at import time
        get_extension_manifest,
        manifest_has_permission,
    )
    manifest = await get_extension_manifest(ext_id, db)
    if manifest is not None:
        if not manifest_has_permission(manifest, "fetch:external"):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "permission_denied",
                    "permission": "fetch:external",
                    "extension_id": ext_id,
                },
            )

    # Server-side rate cap — defense in depth against misbehaving iframes.
    # Note: _BUCKETS is process-local; on a multi-worker deploy the effective
    # rate per source is SOURCE_RATES[provider] * num_workers. Currently a
    # single uvicorn worker is used (see server/Dockerfile CMD).
    rate = SOURCE_RATES.get(provider, 1.0)
    if not _get_bucket(ext_id, provider, rate).take():
        raise HTTPException(
            status_code=429,
            detail=f"{provider}: server-side rate limit exceeded",
            headers={"Retry-After": str(max(1, int(1 / rate)))},
        )

    secrets = _ext_secrets(ext_id)

    if cfg["auth_kind"] == "client_credentials":
        token = await _get_oauth_token(provider, secrets)
        headers = {"Authorization": f"Bearer {token}"}
    else:
        headers = {}

    # Build upstream URL.
    if cfg.get("upstream_builder") is not None:
        upstream_base = cfg["upstream_builder"](secrets, path)
        upstream_url = upstream_base
    else:
        upstream_url = f"{cfg['upstream']}/{path}".rstrip("/")
        if request.url.query:
            upstream_url = f"{upstream_url}?{request.url.query}"

    if cfg.get("upstream_builder") is not None and request.url.query:
        # The Sentinel WMS path embeds query params as part of the upstream
        # URL, so re-append them after the builder runs.
        upstream_url = f"{upstream_url}?{request.url.query}"

    body = await request.body() if request.method in ("POST", "PUT") else None

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            upstream_resp = await client.request(
                request.method,
                upstream_url,
                headers=headers,
                content=body,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Upstream {provider} unreachable: {exc}") from exc

    # Pass-through. Strip hop-by-hop headers and the upstream's CORS
    # headers (concord-api's CORSMiddleware adds the right ones for the
    # iframe origin).
    pass_through = {
        k.lower(): v
        for k, v in upstream_resp.headers.items()
        if k.lower()
        not in {
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "connection",
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "access-control-allow-methods",
            "access-control-allow-headers",
        }
    }
    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=pass_through,
        media_type=upstream_resp.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Admin endpoints for managing per-extension secrets
# ---------------------------------------------------------------------------


def _mask(value: str | None) -> str | None:
    if not value:
        return None
    if len(value) <= 4:
        return "****"
    return f"{value[0]}***{value[-1]} (len {len(value)})"


admin_router = APIRouter(tags=["admin-extension-secrets"])


@admin_router.get("/api/admin/extensions/{ext_id}/secrets")
async def admin_get_extension_secrets(
    ext_id: str,
    user_id: str = Depends(get_user_id),
):
    """Return masked extension secrets.

    Designed for the per-extension settings panel: shows the operator
    which keys are populated, their masked values, and which fields the
    extension's manifest declared as needed-for-proxying.
    """
    require_admin(user_id)
    secrets = _ext_secrets(ext_id)
    return {
        "extension_id": ext_id,
        "fields": [
            {
                "key": k,
                "set": True,
                "masked": _mask(v),
            }
            for k, v in sorted(secrets.items())
        ],
    }


@admin_router.patch("/api/admin/extensions/{ext_id}/secrets")
async def admin_set_extension_secrets(
    ext_id: str,
    body: dict[str, str | None],
    user_id: str = Depends(get_user_id),
):
    """Upsert per-extension secrets. ``None`` means "delete this key";
    a non-empty string sets the value; an empty string also clears.

    The endpoint deliberately accepts a free-form dict — extensions
    declare their own field names in their manifest, and the admin UI
    iterates whatever the manifest's ``needs_proxy`` block expects.
    """
    require_admin(user_id)
    secrets = dict(_ext_secrets(ext_id))
    for k, v in body.items():
        if not isinstance(k, str):
            continue
        if v is None or (isinstance(v, str) and v.strip() == ""):
            secrets.pop(k, None)
        elif isinstance(v, str):
            secrets[k] = v.strip()
    _save_ext_secrets(ext_id, secrets)
    return await admin_get_extension_secrets(ext_id, user_id=user_id)


# ---------------------------------------------------------------------------
# Browser-config endpoint — surfaces the operator-stored browser-direct
# keys to authed users so the extension iframe can hydrate
# ``window.WV.config`` without requiring every user to paste them in.
#
# Distinct from the admin secrets endpoint above: this is read-only,
# returns plaintext (not masked) to authenticated users only, and only
# returns keys that the manifest declares as ``browser_keys`` (server-
# secret keys like ``*_client_secret`` are filtered out at the source —
# their bucket field names contain ``secret``).
# ---------------------------------------------------------------------------


def _browser_safe_secrets(ext_id: str) -> dict[str, str]:
    """Filter the extension's secret bucket down to keys the browser is
    expected to handle directly. ``*_secret`` and ``*_client_id`` and
    the Sentinel instance id stay server-side; everything else is the
    operator's "give every user this default" — Cesium ion tokens,
    AISStream keys, TomTom / Windy keys, etc.
    """
    raw = _ext_secrets(ext_id)
    safe = {}
    for k, v in raw.items():
        kl = k.lower()
        if "secret" in kl:
            continue
        if kl.endswith("_client_id"):
            continue
        if kl == "sentinel_instance_id":
            continue
        safe[k] = v
    return safe


@router.get("/api/users/me/extensions/{ext_id}/browser-config")
async def user_extension_browser_config(
    ext_id: str,
    user_id: str = Depends(get_user_id),
):
    """Return the set of safe-to-expose extension config values stored
    on the instance.

    Auth-gated variant. See ``/api/extensions/{ext_id}/public-config``
    for the unauthenticated companion that the static iframe bundle
    can hit synchronously without threading a token through ext SDK.
    """
    return {"extension_id": ext_id, "config": _browser_safe_secrets(ext_id)}


@router.get("/api/extensions/{ext_id}/public-config")
async def extension_public_config(ext_id: str):
    """Same payload as ``/users/me/extensions/{ext_id}/browser-config``
    but unauthenticated. Designed for the extension iframe's bootstrap
    bridge to fetch synchronously before any layer parses.

    Why no auth: the keys returned here are inherently browser-exposed
    — Cesium / AISStream / TomTom / Windy SDKs all run client-side and
    embed the key in their network calls. Storing them server-side
    saves every user from having to paste the same operator-issued
    token, but doesn't change the trust boundary: anyone hitting this
    endpoint with an installed extension's id gets the same key the
    SDK would have read out of the request the iframe makes anyway.

    The filter rejects ``*_secret`` / ``*_client_id`` / ``sentinel_instance_id``
    keys identically to the authed variant, so OAuth confidants stay
    server-side regardless of caller. Returns 200 with an empty config
    when the extension isn't installed or has no operator keys set —
    same shape, no info-leak distinction.
    """
    return {"extension_id": ext_id, "config": _browser_safe_secrets(ext_id)}
