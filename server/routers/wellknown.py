"""Concord-specific well-known discovery endpoint (INS-027).

Native Concord clients (iOS, Android, desktop standalone) use a
first-launch server picker to pick which Concord instance to talk to.
The client-side discovery helper (``client/src/api/wellKnown.ts``) reads
two well-known JSON documents:

1. ``/.well-known/matrix/client`` — the standard Matrix document. It's
   served as a STATIC file by Caddy in the INS-026 fix; Concord's
   FastAPI server never sees that request.

2. ``/.well-known/concord/client`` — this router. A Concord-specific
   extension that tells the client where to find the Concord API,
   LiveKit SFU, and the instance's human-readable name. Lives on the
   FastAPI side (not as a static Caddy file) because its contents are
   derived from environment variables that only the Concord container
   knows.

The route is intentionally unauthenticated — well-known discovery must
work before the client has any credentials. The only thing this
endpoint reveals is the instance's own public-facing configuration,
which is information the client is about to connect to anyway. No
user-specific data, no private keys, no federation allowlist.

Wire contract is stable and MUST match the `HomeserverConfig`
TypeScript interface in `client/src/api/wellKnown.ts`. Breaking this
contract breaks every native app in the wild — treat it the same as a
Matrix protocol endpoint. Add new fields, don't remove existing ones,
don't rename.
"""
from __future__ import annotations

import ipaddress
import os

from fastapi import APIRouter
from pydantic import BaseModel, Field


def _is_rfc1918(host: str) -> bool:
    """True for RFC1918 / loopback / link-local IPv4 literals.

    Mirrors ``server/routers/voice.py::_is_rfc1918`` — kept local rather
    than imported because ``wellknown.py`` is in the auth-free path and
    importing the voice router would pull its auth dependencies into
    well-known's import graph.
    """
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        return False

# No `/api` prefix: the path must live at the exact root
# `/.well-known/concord/client` because client discovery helpers hit
# that URL verbatim per the Matrix-inspired well-known pattern. Caddy
# routes `/.well-known/concord/*` directly to this service.
router = APIRouter(tags=["wellknown"])


# Hex colour pattern shared by BrandingConfig and the admin endpoint
# that writes it. Six-digit form only — `#abc` shortcuts and named
# colours are rejected so the wire is unambiguous and the client can
# safely interpolate the string into CSS color-mix() expressions.
_HEX_COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"


class BrandingConfig(BaseModel):
    """Per-instance branding (INS-069).

    Surfaced in ``GET /.well-known/concord/client`` so cross-instance
    Sources tiles can render with the instance's own colours, and
    written via the admin-only
    ``POST /api/admin/instance/branding`` endpoint.

    All fields are validated server-side so the client can trust the
    string and interpolate it into inline styles without re-validating.
    Six-digit hex required (``#aabbcc``) — short-form and named
    colours are rejected.
    """

    primary_color: str = Field(
        ...,
        pattern=_HEX_COLOR_PATTERN,
        description="Six-digit hex (#rrggbb). Used as the tinted background base.",
    )
    accent_color: str = Field(
        ...,
        pattern=_HEX_COLOR_PATTERN,
        description="Six-digit hex (#rrggbb). Used as the tile ring/accent.",
    )
    logo_url: str | None = Field(
        None,
        max_length=2048,
        pattern=r"^https?://.+",
        description=(
            "Optional logo URL (HTTP or HTTPS). Falls back to the "
            "default Source brand icon when absent."
        ),
    )


class ConcordClientWellKnown(BaseModel):
    """Schema returned from ``GET /.well-known/concord/client``.

    Every field has Field constraints per the commercial-scope profile —
    a malformed env var should surface as a 500 with an actionable
    error-code rather than silently shipping garbage JSON to the client.
    """

    api_base: str = Field(
        ...,
        min_length=1,
        max_length=2048,
        description=(
            "Absolute HTTPS URL of the Concord API base. Clients "
            "concatenate API paths onto this (e.g. '/servers', "
            "'/explore/servers'). Must NOT have a trailing slash."
        ),
    )
    livekit_url: str | None = Field(
        None,
        max_length=2048,
        description=(
            "LiveKit signaling URL (wss:// or https://). Optional — "
            "instances without LiveKit simply omit it. Clients fall "
            "back to disabled voice/video when this is absent."
        ),
    )
    instance_name: str | None = Field(
        None,
        max_length=128,
        description=(
            "Human-readable instance name displayed in the server "
            "picker UI. Falls back to the bare hostname on the client "
            "when absent."
        ),
    )
    features: list[str] = Field(
        default_factory=list,
        description=(
            "Stable feature identifiers advertised by this instance. "
            "Native clients may use this list to enable or disable UI "
            "affordances without shipping a new build. Only well-known "
            "identifiers are listed here to keep the contract stable."
        ),
    )
    turn_servers: list[dict] = Field(
        default_factory=list,
        description=(
            "STUN/TURN server list for ICE connectivity. Unauthenticated "
            "entries only (STUN URLs) — authenticated TURN credentials "
            "are issued per-user via the voice token endpoint. Clients "
            "can use these for pre-auth connectivity checks in the "
            "server picker screen."
        ),
    )
    node_role: str | None = Field(
        None,
        description=(
            "Structural role this node plays in the mesh. One of "
            "'frontend-only', 'hybrid', or 'anchor'. Null when the "
            "service-node config has not been written yet (defaults to "
            "'hybrid' in that case)."
        ),
    )
    tunnel_anchor: bool = Field(
        False,
        description=(
            "True when this node advertises itself as a tunnel anchor "
            "(i.e. accepts inbound WireGuard sessions from other nodes). "
            "Defaults to False when the service-node config is absent."
        ),
    )
    branding: BrandingConfig | None = Field(
        None,
        description=(
            "Per-instance branding (INS-069). Null when the operator "
            "has not configured branding — clients fall back to the "
            "default Source tile styling. When set, cross-instance "
            "Source rails render the tile with the instance's primary "
            "colour as the background tint and the accent colour as "
            "the ring."
        ),
    )


def _domain_for_server_name(server_name: str) -> str:
    """INS-051: expand a bare slug to ``<slug>.<DEFAULT_DOMAIN_ROOT>``.

    If ``server_name`` already contains a dot, treat it as a fully
    qualified host and return it unchanged. If it's a bare label (no
    dots) and not the literal ``localhost`` sentinel, advertise it under
    the default domain root (``concordchat.net`` by default; overridable
    via ``CONCORD_DEFAULT_DOMAIN_ROOT``).

    Examples:
        "alpha"                 -> "alpha.concordchat.net"
        "concord.example.com"   -> "concord.example.com" (unchanged)
        "localhost"             -> "localhost"            (unchanged)
    """
    from config import CONCORD_DEFAULT_DOMAIN_ROOT

    s = server_name.strip().lstrip(".")
    if not s:
        return s
    if s == "localhost":
        return s
    if "." in s:
        return s
    return f"{s}.{CONCORD_DEFAULT_DOMAIN_ROOT}"


def _resolve_api_base() -> str:
    """Derive the canonical Concord API base URL from env.

    Prefers ``PUBLIC_BASE_URL`` (explicit override) if set, else
    synthesises ``https://<expanded>/api`` from the homeserver name,
    expanding bare slugs to ``<slug>.<DEFAULT_DOMAIN_ROOT>`` per
    INS-051. The result never carries a trailing slash because the
    client's Pydantic wire-model on the other side rejects one (same
    rule the Matrix spec enforces on homeserver base URLs).
    """
    override = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if override:
        return f"{override}/api"
    server_name = os.environ.get("CONDUWUIT_SERVER_NAME", "").strip()
    if not server_name:
        # Commercial-scope fallback: rather than shipping a broken
        # endpoint, return an explicit sentinel. The Caddy route that
        # proxies this endpoint runs with the same env as concord-api
        # so this is a configuration bug, not a runtime error.
        server_name = "localhost"
    return f"https://{_domain_for_server_name(server_name)}/api"


def _resolve_public_host() -> str | None:
    """Return the public-facing host clients should reach this instance at.

    Precedence:
      1. ``PUBLIC_BASE_URL`` (hostname extracted) — explicit operator
         override. Always wins when set, because the operator has
         stated authoritatively how the outside world reaches them.
      2. ``CONDUWUIT_SERVER_NAME`` expanded via ``_domain_for_server_name``
         — fallback for deployments that haven't set ``PUBLIC_BASE_URL``.

    RFC1918 / loopback / link-local addresses are NEVER returned, because
    advertising them in well-known docs ships a broken contact card to
    every off-LAN peer that fetches the document. Same rule the voice
    router applies to ``TURN_HOST``. If neither source yields a routable
    public host, return ``None`` and the caller omits the field rather
    than serving a confidently-wrong value.
    """
    override = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if override:
        try:
            from urllib.parse import urlparse

            parsed = urlparse(override)
            host = (parsed.hostname or "").strip()
            if host and not _is_rfc1918(host):
                return host
        except ValueError:
            pass
    server_name = os.environ.get("CONDUWUIT_SERVER_NAME", "").strip()
    if not server_name:
        return None
    expanded = _domain_for_server_name(server_name)
    if not expanded or _is_rfc1918(expanded):
        return None
    return expanded


def _resolve_livekit_url() -> str | None:
    """Derive the public LiveKit URL from the operator's public host.

    The Docker-internal value is ``ws://livekit:7880``, which is NOT
    what native clients should connect to — they need the public
    wss:// endpoint routed by Caddy at ``/livekit/``. We synthesise
    that public URL from :func:`_resolve_public_host`, which prefers
    ``PUBLIC_BASE_URL`` and rejects RFC1918 hosts. If no routable
    public host can be resolved we return ``None`` and the client
    disables voice rather than connecting to a LAN IP that fails the
    moment a friend dials in from another network.
    """
    host = _resolve_public_host()
    if not host:
        return None
    return f"wss://{host}/livekit/"


def _resolve_instance_name() -> str | None:
    """Read the optional human-readable instance name."""
    name = os.environ.get("INSTANCE_NAME", "").strip()
    return name or None


def _resolve_turn_servers() -> list[dict]:
    """Return unauthenticated STUN/TURN server hints for pre-auth checks.

    Only includes STUN URLs (no credentials) so the well-known document
    stays safe to serve unauthenticated. Authenticated TURN credentials
    are issued per-user via ``POST /api/voice/token``. Clients can use
    these STUN entries in the server-picker screen to verify basic UDP
    connectivity before the user even logs in.
    """
    turn_host = os.environ.get("TURN_HOST", "").strip()
    turn_domain = os.environ.get("TURN_DOMAIN", "").strip()
    candidate = turn_host or turn_domain

    servers: list[dict] = []
    # Advertise the instance's own STUN endpoint (coturn serves STUN on
    # the same port as TURN, no credentials needed for STUN). Drop the
    # entry if the only candidate is an RFC1918 / loopback / link-local
    # literal — advertising those to off-LAN clients ships a STUN URL
    # that can never reach the relay, and on the dev stack used to
    # poison the well-known doc with ``stun:192.168.x.x:3478``. If no
    # routable LAN candidate, fall back to ``_resolve_public_host`` so
    # operators that only set ``PUBLIC_BASE_URL`` still advertise their
    # own STUN endpoint.
    if candidate and not _is_rfc1918(candidate):
        servers.append({"urls": f"stun:{candidate}:3478"})
    elif (public_host := _resolve_public_host()):
        servers.append({"urls": f"stun:{public_host}:3478"})
    # Always include Google's public STUN as a fallback
    servers.append({"urls": "stun:stun.l.google.com:19302"})
    return servers


def _resolve_branding() -> BrandingConfig | None:
    """Read the persisted branding block from ``instance.json``.

    Lives at the top-level ``branding`` key alongside ``name`` and
    other instance settings. Reuses the admin router's read helper so
    there's a single source of truth for instance settings parsing —
    if the file is missing, malformed, or the key is absent, return
    None and the well-known omits the field entirely.

    Imported inline (and lazily) so test fixtures that patch the
    admin module's settings reader see a fresh lookup per request.
    """
    try:
        from routers.admin import _read_instance_settings
    except Exception:
        return None
    settings = _read_instance_settings()
    raw = settings.get("branding") if isinstance(settings, dict) else None
    if not isinstance(raw, dict):
        return None
    try:
        return BrandingConfig.model_validate(raw)
    except Exception:
        # Persisted-but-malformed branding is a configuration bug —
        # serve the document without the field rather than 500'ing
        # the entire discovery endpoint.
        return None


def _advertised_features() -> list[str]:
    """Return the stable list of feature identifiers advertised.

    Kept as a hard-coded list (not env-driven) so the contract is
    reviewable via code search. Add new identifiers here when the
    corresponding feature ships; remove them only when the feature is
    retired AND no deployed native clients still check for them.
    """
    return ["chat", "voice", "federation", "soundboard", "explore", "extensions"]


@router.get(
    "/.well-known/concord/client",
    response_model=ConcordClientWellKnown,
    summary="Concord-specific well-known discovery document",
    description=(
        "Returns the public-facing endpoint configuration for this "
        "Concord instance. Consumed by native clients at first-launch "
        "time (INS-027). Unauthenticated by design — well-known "
        "discovery must work before the client has any credentials."
    ),
)
async def concord_client_wellknown() -> ConcordClientWellKnown:
    """Serve the Concord-specific client discovery document.

    All values are derived from environment variables read at request
    time (NOT at import time) so operators can rotate config via a
    container restart without code changes.

    INS-023: service-node role + tunnel_anchor flag are read from
    the admin-only ``service_node.json`` via
    ``services.service_node_config.public_view``. A missing file
    yields the default ``hybrid`` / ``false`` pair — no raw caps are
    ever exposed here.
    """
    # Imported inline so test patches of the service_node_config
    # module see a fresh lookup on each request. Importing at module
    # top-time would cache the symbol at import, and monkeypatching
    # ``services.service_node_config.public_view`` mid-test would not
    # reach this handler.
    from services.service_node_config import public_view as _public_node_view

    node_view = _public_node_view()
    return ConcordClientWellKnown(
        api_base=_resolve_api_base(),
        livekit_url=_resolve_livekit_url(),
        instance_name=_resolve_instance_name(),
        features=_advertised_features(),
        turn_servers=_resolve_turn_servers(),
        node_role=node_view.node_role,
        tunnel_anchor=node_view.tunnel_anchor_enabled,
        branding=_resolve_branding(),
    )
