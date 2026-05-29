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
import os
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dependencies import get_user_id
from routers.admin import require_admin
from services import docker_control, voice_health

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/hosting", tags=["hosting"])


# ---------------------------------------------------------------------
# Phase 7 — deployment profile surface
# ---------------------------------------------------------------------

#: Env var the Rust servitude reads to override the persisted profile.
#: Docker compose sets this to ``web_first`` for the concord-api
#: container so the docker stack is guaranteed to come up with the
#: full web stack regardless of any other state. Mirror of
#: ``PROFILE_ENV_VAR`` in ``src-tauri/src/servitude/config.rs``.
PROFILE_ENV_VAR = "CONCORD_PROFILE"

#: The compose service name (set by ``docker-compose.yml``'s ``concord-api``
#: block) that represents "this concord-api process knows the web stack
#: is up". Used by :func:`_web_stack_running_heuristic` to answer the
#: ``web_stack_running`` field — if the operator's hosting flow is
#: meant to flip the switch, the concord-api container that answers
#: this request is necessarily one of the running web-stack services,
#: but we ALSO check that the upstream homeserver is up because that's
#: the user-visible signal of "this is actually a web-first instance"
#: rather than a docker run of just the api by itself.
_WEB_STACK_REPRESENTATIVE_SERVICES = ("conduwuit", "livekit")


class HostingProfileResponse(BaseModel):
    """Body of ``GET /api/hosting/profile``.

    `profile` mirrors the Rust ``Profile`` enum wire form
    (``p2p_only`` | ``web_first``).
    `web_stack_running` is a HEURISTIC — see the body of
    :func:`get_profile` for the precise rule. The frontend's
    Settings UI uses it to decide between "show the toggle as off
    with explanatory text" and "show the toggle as on with the
    Phase-0 hosting status panel inline".
    `last_changed` is None until something flips the profile — kept
    in the response shape so the UI can show "changed N minutes
    ago" later without changing the API contract.
    """

    profile: Literal["p2p_only", "web_first"]
    web_stack_running: bool
    last_changed: Optional[datetime] = None


class EnableWebStackResponse(BaseModel):
    """Body returned by ``POST /api/hosting/profile/enable_web_stack``.

    Mirrors the shape of ``GET /api/hosting/status`` so the UI can
    fold the result straight into its hosting-status panel after the
    toggle completes — no separate follow-up GET needed.
    """

    profile: Literal["p2p_only", "web_first"]
    web_stack_running: bool
    voice: dict
    started_services: list[str]
    already_running_services: list[str]
    message: Optional[str] = None


async def _web_stack_running_heuristic() -> bool:
    """Return ``True`` when the representative web-stack containers
    report ``running`` via the docker-socket-proxy.

    The heuristic checks every entry in
    :data:`_WEB_STACK_REPRESENTATIVE_SERVICES` and returns ``True``
    only if all of them are up. Used by the profile-status endpoint
    so the frontend toggle reflects ACTUAL running state, not just
    persisted intent.

    Docker-proxy failures collapse to ``False`` (handled inside
    :func:`docker_control.is_service_running`). That's the right
    default — when the proxy is unreachable, the operator's
    expectation is "the stack isn't running" and surfacing a 5xx
    here would block the entire Settings page from rendering.
    """
    for svc in _WEB_STACK_REPRESENTATIVE_SERVICES:
        if not await docker_control.is_service_running(svc):
            return False
    return True


def _current_profile_from_env() -> Literal["p2p_only", "web_first"]:
    """Read the runtime-effective profile from the ``CONCORD_PROFILE``
    env var. Falls back to ``p2p_only`` on any unrecognized value so a
    fresh native install reports correctly even before the user has
    touched the Settings toggle.

    Mirror of ``Profile::from_env`` in
    ``src-tauri/src/servitude/config.rs``. Kept duplicated rather
    than via an RPC into the Tauri sidecar because the backend can
    answer this from its own environment more cheaply, and the
    Rust-side toggle path persists through to disk which is what
    the next servitude boot reads anyway.
    """
    raw = os.environ.get(PROFILE_ENV_VAR, "").strip().lower()
    if raw in ("p2p_only", "p2ponly"):
        return "p2p_only"
    if raw in ("web_first", "webfirst"):
        return "web_first"
    return "p2p_only"


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


@router.get("/profile", response_model=HostingProfileResponse)
async def get_profile(_user_id: str = Depends(get_user_id)) -> HostingProfileResponse:
    """Return the current deployment profile and web-stack running state.

    `profile` comes from the ``CONCORD_PROFILE`` env var (the docker
    stack sets this to ``web_first``). A fresh native install
    reports ``p2p_only`` so the Settings UI knows to render the
    toggle in its off state.

    `web_stack_running` is the docker-proxy heuristic — see
    :func:`_web_stack_running_heuristic` for the exact rule. In a
    web-first deployment this should always be ``true`` once the
    stack is up; in a p2p-only deployment it is ``false`` because
    the web-stack containers don't exist.

    Authenticated, but not admin-gated — every logged-in user can
    see what profile their instance is on. The follow-up
    enable_web_stack POST is the admin-gated operation.
    """
    profile = _current_profile_from_env()
    web_running = await _web_stack_running_heuristic()
    return HostingProfileResponse(
        profile=profile,
        web_stack_running=web_running,
        last_changed=None,
    )


@router.post(
    "/profile/enable_web_stack",
    response_model=EnableWebStackResponse,
)
async def enable_web_stack(
    user_id: str = Depends(get_user_id),
) -> EnableWebStackResponse:
    """Flip a native install from ``p2p_only`` to ``web_first`` and
    bring the docker web stack up.

    Operator-gated (admin only). Calls
    :func:`docker_control.start_compose_service` for the four
    services that make up the web stack — conduwuit (Matrix homeserver),
    livekit (voice SFU), the docker-socket-proxy that
    administers them, and the concord-api (this container) which is
    a no-op self-start but kept in the list so the operator
    confirmation matches the documented set. Idempotent: a service
    that's already running is reported under ``already_running_services``
    instead of being touched again.

    Returns the same shape as ``/api/hosting/status`` so the UI can
    immediately show what's healthy and what still needs DNS /
    port-forwarding. The voice-subsystem panel that already exists
    in the hosting tab takes over from there.
    """
    require_admin(user_id)

    started: list[str] = []
    already_running: list[str] = []
    failures: list[str] = []
    # NOTE: concord-api restarts itself if we list it here, which
    # kills the request handler mid-response. The docker stack uses
    # `depends_on` to chain conduwuit + livekit -> docker-socket-proxy ->
    # concord-api, so starting the upstream services is what flips
    # the actual user-visible "web stack is up" signal.
    services_to_start = (
        "conduwuit",
        "livekit",
        "docker-socket-proxy",
    )
    for svc in services_to_start:
        try:
            result = await docker_control.start_compose_service(svc)
        except docker_control.DockerControlError as exc:
            logger.warning("enable_web_stack: %s failed to start: %s", svc, exc)
            failures.append(f"{svc}: {exc}")
            continue
        started.extend(result["started"])
        already_running.extend(result["already_running"])

    # Re-probe voice subsystem so the response reflects post-start state.
    voice_snap = await voice_health.probe_now()
    web_running = await _web_stack_running_heuristic()
    # Profile from env reports what the running docker-compose stack
    # set; on a native install where the operator just turned the
    # toggle on but hasn't restarted, the persisted Tauri-side config
    # is what matters and the env hasn't necessarily caught up. We
    # still report the env-derived value here because that's the only
    # truth source this Python process has access to — the Tauri
    # toggle is what writes the persisted value, and the Python
    # process inherits CONCORD_PROFILE from whatever started it.
    profile = _current_profile_from_env()

    message: Optional[str]
    if failures:
        message = (
            "Some services failed to start: "
            + "; ".join(failures)
            + ". Inspect docker logs for details."
        )
    elif not started and already_running:
        message = "Web stack already running — no action taken."
    else:
        message = None

    if failures and not started and not already_running:
        # Hard failure — none of the services moved. Surface as 503
        # so the UI can render a retry control instead of silently
        # claiming success.
        raise HTTPException(
            status_code=503,
            detail={
                "error_code": "DOCKER_PROXY_UNAVAILABLE",
                "failures": failures,
            },
        )

    return EnableWebStackResponse(
        profile=profile,
        web_stack_running=web_running,
        voice=voice_snap.to_dict(),
        started_services=started,
        already_running_services=already_running,
        message=message,
    )
