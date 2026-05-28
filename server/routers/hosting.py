"""Hosting-subsystem status endpoint.

Surfaces the live health of the components a Concord operator runs to
*host* an instance (TURN relay, LiveKit SFU, federation transport) so
misconfiguration becomes a visible problem instead of an invisible one.

Authenticated. Anyone who can already log in can see it — this is an
operator-and-power-user diagnostic, not a public probe. The output
intentionally includes only "is X working / how to fix it" data, never
secrets or credentials.

The CLIENT side of Concord (chat with other instances, login, settings,
etc.) does NOT depend on this subsystem. A user whose own hosting is
broken can still connect to other Concords; only their own ability to
serve others is degraded. That separation is enforced by the lifespan
hook in main.py (which starts the voice-health background loop but
never blocks startup on its result).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from dependencies import get_user_id
from services import voice_health

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/hosting", tags=["hosting"])


@router.get("/status")
async def get_hosting_status(_user_id: str = Depends(get_user_id)):
    """Return the current health snapshot of the hosting subsystem.

    Always returns 200 — the snapshot itself carries the healthy/unhealthy
    signal in the body. Callers (operator UI, admin tooling) treat the
    body as the source of truth, not the HTTP status.
    """
    snap = voice_health.current_status()
    return {
        "voice": snap.to_dict(),
    }


@router.post("/status/refresh")
async def refresh_hosting_status(_user_id: str = Depends(get_user_id)):
    """Force an immediate re-probe of voice subsystem health.

    Useful after the operator edits config and wants to confirm the fix
    landed without waiting for the periodic timer.
    """
    snap = await voice_health.probe_now()
    return {"voice": snap.to_dict()}
