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

import os

from fastapi import APIRouter
from pydantic import BaseModel, Field

# No `/api` prefix: the path must live at the exact root
# `/.well-known/concord/client` because client discovery helpers hit
# that URL verbatim per the Matrix-inspired well-known pattern. Caddy
# routes `/.well-known/concord/*` directly to this service.
router = APIRouter(tags=["wellknown"])


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


def _resolve_api_base() -> str:
    """Derive the canonical Concord API base URL from env.

    Prefers ``PUBLIC_BASE_URL`` (explicit override) if set, else
    synthesises ``https://<CONDUWUIT_SERVER_NAME>/api`` from the
    already-required homeserver name. The result never carries a
    trailing slash because the client's Pydantic wire-model on the
    other side rejects one (same rule the Matrix spec enforces on
    homeserver base URLs).
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
    return f"https://{server_name}/api"


def _resolve_livekit_url() -> str | None:
    """Derive the public LiveKit URL from ``LIVEKIT_URL``.

    The Docker-internal value is ``ws://livekit:7880``, which is NOT
    what native clients should connect to — they need the public
    wss:// endpoint routed by Caddy at ``/livekit/``. We synthesise
    that public URL from ``CONDUWUIT_SERVER_NAME`` so the value is
    always consistent with how Caddy actually proxies the signaling
    channel. If the homeserver name is missing the caller is
    misconfigured, so we return ``None`` and the client disables
    voice rather than connecting to a bogus URL.
    """
    server_name = os.environ.get("CONDUWUIT_SERVER_NAME", "").strip()
    if not server_name:
        return None
    return f"wss://{server_name}/livekit/"


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
    host = turn_host or turn_domain

    servers: list[dict] = []
    if host:
        # Advertise the instance's own STUN endpoint (coturn serves
        # STUN on the same port as TURN, no credentials needed for STUN).
        servers.append({"urls": f"stun:{host}:3478"})
    # Always include Google's public STUN as a fallback
    servers.append({"urls": "stun:stun.l.google.com:19302"})
    return servers


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
    )
