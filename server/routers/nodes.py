"""Disposable anonymous node sessions.

A "disposable node" is a temporary, anonymous identity issued without
an email or password. The node receives a short-lived session token
and is required to contribute compute back to the network (the
``must_contribute_compute`` flag is a hint to the scheduler).

Place admins can ban all disposable nodes from their place via
``Server.bans_disposables``. The ban is structural — disposable users
are denied entry by the place auth check, no per-user ban needed.

This module follows the commercial-profile contract: every input is
validated via Pydantic Field(), every error is structured via
ConcordError, and rate limiting reuses the proven sliding-window
implementation from registration.py.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from errors import ConcordError
from models import DisposableNode, Server
from routers.servers import get_user_id
from config import ADMIN_USER_IDS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["nodes"])


# Per-IP sliding window — same shape as registration.py.
_disposable_rate_limits: dict[str, deque[float]] = defaultdict(deque)
_DISPOSABLE_RATE_LIMIT = 5
_DISPOSABLE_RATE_WINDOW = 900  # 15 minutes

# Periodic sweep counters. A per-call `del` handles the common case
# where a polite client stops hitting the endpoint, but an attacker
# spraying 1000 distinct IPs once each would never trigger it. The
# sweep walks the whole dict every ``_DISPOSABLE_SWEEP_INTERVAL`` calls
# and removes any empty or fully-expired entries.
_disposable_sweep_counter = 0
_DISPOSABLE_SWEEP_INTERVAL = 1000


def _sweep_disposable_rate_limits(now: float) -> None:
    """Walk the rate-limit dict and delete empty / fully-expired entries.

    Bounded O(dict_size) and infrequent — called every
    ``_DISPOSABLE_SWEEP_INTERVAL`` rate-limit checks. Catches the case
    where an attacker sprays many distinct IPs a single time each
    (so the per-call ``del`` below never fires).
    """
    cutoff = now - _DISPOSABLE_RATE_WINDOW
    # Materialize the key list so we can mutate the dict as we go.
    for key in list(_disposable_rate_limits.keys()):
        window = _disposable_rate_limits.get(key)
        if not window:
            _disposable_rate_limits.pop(key, None)
            continue
        # Drop expired entries from the front; if the whole deque is
        # now stale, drop the key itself.
        while window and window[0] < cutoff:
            window.popleft()
        if not window:
            _disposable_rate_limits.pop(key, None)


def _check_disposable_rate_limit(ip: str) -> bool:
    """Return True if within rate limit, False if exceeded.

    Mirrors ``_check_registration_rate_limit`` from registration.py.
    Per-IP sliding window deque, evict-on-read pattern. After popping
    expired entries, if the deque is empty, delete the IP key itself
    so the outer dict cannot grow unbounded. A periodic sweep catches
    one-shot attacker IPs that the per-call ``del`` would never touch.
    """
    global _disposable_sweep_counter
    now = time.time()

    _disposable_sweep_counter += 1
    if _disposable_sweep_counter >= _DISPOSABLE_SWEEP_INTERVAL:
        _disposable_sweep_counter = 0
        _sweep_disposable_rate_limits(now)

    window = _disposable_rate_limits[ip]
    while window and window[0] < now - _DISPOSABLE_RATE_WINDOW:
        window.popleft()
    # If the whole deque was evicted by the sliding-window pop, the
    # key would otherwise linger forever. Delete it; the ``append``
    # below recreates a fresh entry via the defaultdict.
    if not window:
        del _disposable_rate_limits[ip]
        window = _disposable_rate_limits[ip]
    if len(window) >= _DISPOSABLE_RATE_LIMIT:
        return False
    window.append(now)
    return True


def _client_ip(request: Request) -> str | None:
    return (
        request.headers.get("Cf-Connecting-Ip")
        or request.headers.get("X-Real-Ip")
        or (request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or None)
        or (request.client.host if request.client else None)
    )


# ---------------------------------------------------------------------------
# Disposable node creation
# ---------------------------------------------------------------------------


class DisposableNodeRequest(BaseModel):
    """Optional metadata for the disposable node creation request.

    All fields are optional — a disposable node can be requested with
    an empty body. The fields exist so future clients can hint at the
    compute they're willing to contribute.
    """

    contribute_compute: bool = Field(
        default=True,
        description="Whether the node agrees to contribute compute back to the network.",
    )
    user_agent_hint: str | None = Field(
        default=None,
        max_length=200,
        description="Optional user-agent hint for telemetry. Not used for auth.",
    )


class DisposableNodeResponse(BaseModel):
    session_token: str
    temp_identifier: str
    expires_at: str
    must_contribute_compute: bool


@router.post("/nodes/disposable", response_model=DisposableNodeResponse)
async def create_disposable_node(
    body: DisposableNodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Create a short-lived anonymous node session.

    No authentication required. Rate-limited per IP. The returned
    session_token can be presented in subsequent requests as a Bearer
    token (when the disposable-node auth shim ships in a follow-up
    pillar — for now the token is just an opaque identifier).
    """
    if not body.contribute_compute:
        # Hard requirement from PLAN.md feedback_open_questions:
        # disposable nodes MUST contribute compute. Refusing the
        # contribution is a fast-fail.
        raise ConcordError(
            error_code="DISPOSABLE_NODE_REJECTED",
            message=(
                "Disposable nodes must agree to contribute compute back to the network."
            ),
            status_code=403,
        )

    ip = _client_ip(request)
    if ip and not _check_disposable_rate_limit(ip):
        raise ConcordError(
            error_code="RATE_LIMITED",
            message="Too many disposable node creation attempts. Try again later.",
            status_code=429,
        )

    node = DisposableNode(must_contribute_compute=True)
    db.add(node)
    await db.commit()
    await db.refresh(node)

    logger.info(
        "Disposable node created: %s (ip=%s, ua=%r)",
        node.temp_identifier, ip, body.user_agent_hint,
    )

    return DisposableNodeResponse(
        session_token=node.session_token,
        temp_identifier=node.temp_identifier,
        expires_at=node.expires_at.isoformat(),
        must_contribute_compute=node.must_contribute_compute,
    )


# ---------------------------------------------------------------------------
# Place-level ban for all disposable nodes
# ---------------------------------------------------------------------------


class BanDisposablesResponse(BaseModel):
    place_id: str
    bans_disposables: bool
    revoked_count: int


@router.post(
    "/admin/places/{place_id}/ban-disposables",
    response_model=BanDisposablesResponse,
)
async def ban_disposables_from_place(
    place_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Ban every disposable node from a place.

    Sets ``Server.bans_disposables = True`` and revokes any
    currently-active disposable sessions associated with the place.
    Only place admins (server owners) and global admins can call this.

    Note: today disposable nodes have no per-place membership table —
    they're an opaque session pool. The "revocation" therefore marks
    every active disposable session as revoked. A future iteration
    will track per-place disposable membership; until then, the
    safest behavior is the broadest one (revoke all).
    """
    # Validate place exists
    server = await db.get(Server, place_id)
    if not server:
        raise ConcordError(
            error_code="RESOURCE_NOT_FOUND",
            message="Place not found",
            status_code=404,
        )

    # Auth: must be the owner of the place OR a global admin
    if user_id != server.owner_id and user_id not in ADMIN_USER_IDS:
        raise ConcordError(
            error_code="OWNER_REQUIRED",
            message="Only the place owner or a global admin can ban disposables.",
            status_code=403,
        )

    # Mark structural ban
    server.bans_disposables = True

    # Revoke all currently-active (non-expired, non-revoked) disposable sessions
    from sqlalchemy import select, update
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(DisposableNode).where(
            DisposableNode.revoked == False,  # noqa: E712
            DisposableNode.expires_at > now,
        )
    )
    active = result.scalars().all()
    for node in active:
        node.revoked = True

    await db.commit()

    logger.info(
        "Place %s banned %d disposable node(s) (by user=%s)",
        place_id, len(active), user_id,
    )

    return BanDisposablesResponse(
        place_id=place_id,
        bans_disposables=True,
        revoked_count=len(active),
    )
