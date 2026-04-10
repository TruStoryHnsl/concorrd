"""Admin endpoints for Discord bridge management (INS-024 Wave 2).

Provides enable / disable / rotate / status for the Discord bridge.
All endpoints are admin-only (gated by ``ADMIN_USER_IDS``). The bridge
runs as a separate Docker Compose service (``concord-discord-bridge``)
managed through the docker-socket-proxy sidecar.

The enable flow runs four ordered steps:
  1. ``write_registration`` — generate AS registration YAML
  2. ``inject_tuwunel_toml`` — write appservice entry into tuwunel config
  3. ``restart_conduwuit`` — reload tuwunel so it picks up the new AS
  4. ``start_bridge`` — bring up the bridge container

Disable reverses: stop bridge, remove appservice entry, restart conduwuit.
Rotate: new tokens, rewrite everything, restart both.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from config import ADMIN_USER_IDS
from routers.servers import get_user_id
from services.bridge_config import (
    read_registration_file,
    write_registration_file,
    delete_registration_file,
    rotate_tokens,
    ensure_appservice_entry,
    remove_appservice_entry,
    APPSERVICE_ID,
)
from services.docker_control import (
    restart_compose_service,
    start_compose_service,
    stop_compose_service,
    DockerControlError,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/bridges/discord", tags=["admin-bridges"])


# ── Helpers ──────────────────────────────────────────────────────────

def _require_admin(user_id: str) -> None:
    if user_id not in ADMIN_USER_IDS:
        raise HTTPException(403, "Admin access required")


def _redact_for_logging(detail: Any) -> str:
    """Redact token-like strings from detail dicts before returning to client."""
    s = str(detail)
    # Simple redaction — strip anything that looks like a token
    # (long alphanumeric strings). Good enough for step detail fields.
    return s[:500] if len(s) > 500 else s


# ── Models ───────────────────────────────────────────────────────────

class StepResult(BaseModel):
    name: str
    status: str  # "ok" | "failed" | "skipped"
    detail: str = ""


class EnableResponse(BaseModel):
    ok: bool
    action: str = "enable"
    steps: list[StepResult]


class DisableResponse(BaseModel):
    ok: bool
    action: str = "disable"
    steps: list[StepResult]


class RotateResponse(BaseModel):
    ok: bool
    action: str = "rotate"
    steps: list[StepResult]


class StatusResponse(BaseModel):
    enabled: bool
    appservice_id: str | None


class EmptyBody(BaseModel):
    """Request body that rejects unexpected fields."""
    model_config = ConfigDict(extra="forbid")


# ── GET /status ──────────────────────────────────────────────────────

@router.get("/status", response_model=StatusResponse)
async def bridge_status(
    user_id: str = Depends(get_user_id),
) -> StatusResponse:
    """Return current bridge configuration status."""
    _require_admin(user_id)
    reg = read_registration_file()
    return StatusResponse(
        enabled=reg is not None,
        appservice_id=APPSERVICE_ID if reg is not None else None,
    )


# ── POST /enable ─────────────────────────────────────────────────────

@router.post("/enable", response_model=EnableResponse)
async def enable_bridge(
    body: EmptyBody,
    user_id: str = Depends(get_user_id),
) -> EnableResponse:
    """Enable the Discord bridge: write registration, inject config, restart."""
    _require_admin(user_id)

    steps: list[StepResult] = []
    failed = False

    # Step 1: write registration
    try:
        reg = write_registration_file()
        steps.append(StepResult(name="write_registration", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="write_registration", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))
        return EnableResponse(ok=False, steps=steps)

    # Step 2: inject tuwunel.toml
    try:
        ensure_appservice_entry(reg)
        steps.append(StepResult(name="inject_tuwunel_toml", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="inject_tuwunel_toml", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))
        return EnableResponse(ok=False, steps=steps)

    # Step 3: restart conduwuit
    try:
        result = await restart_compose_service("conduwuit")
        steps.append(StepResult(
            name="restart_conduwuit", status="ok",
            detail=_redact_for_logging(result),
        ))
    except DockerControlError as exc:
        steps.append(StepResult(
            name="restart_conduwuit", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))
        failed = True

    # Step 4: start bridge (only if restart succeeded)
    if not failed:
        try:
            result = await start_compose_service("concord-discord-bridge")
            steps.append(StepResult(
                name="start_bridge", status="ok",
                detail=_redact_for_logging(result),
            ))
        except DockerControlError as exc:
            steps.append(StepResult(
                name="start_bridge", status="failed",
                detail=_redact_for_logging(str(exc)),
            ))
            failed = True
    else:
        steps.append(StepResult(
            name="start_bridge", status="skipped",
            detail="skipped because restart_conduwuit failed",
        ))

    return EnableResponse(ok=not failed, steps=steps)


# ── POST /disable ────────────────────────────────────────────────────

@router.post("/disable", response_model=DisableResponse)
async def disable_bridge(
    body: EmptyBody,
    user_id: str = Depends(get_user_id),
) -> DisableResponse:
    """Disable the Discord bridge: stop container, remove config, restart conduwuit."""
    _require_admin(user_id)

    steps: list[StepResult] = []

    # Step 1: stop the bridge container
    try:
        result = await stop_compose_service("concord-discord-bridge")
        steps.append(StepResult(
            name="stop_bridge", status="ok",
            detail=_redact_for_logging(result),
        ))
    except DockerControlError as exc:
        steps.append(StepResult(
            name="stop_bridge", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    # Step 2: remove appservice entry from tuwunel.toml
    try:
        remove_appservice_entry()
        steps.append(StepResult(name="remove_appservice_entry", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="remove_appservice_entry", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    # Step 3: delete registration file
    try:
        delete_registration_file()
        steps.append(StepResult(name="delete_registration", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="delete_registration", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    # Step 4: restart conduwuit to pick up removed appservice
    try:
        result = await restart_compose_service("conduwuit")
        steps.append(StepResult(
            name="restart_conduwuit", status="ok",
            detail=_redact_for_logging(result),
        ))
    except DockerControlError as exc:
        steps.append(StepResult(
            name="restart_conduwuit", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    return DisableResponse(ok=True, steps=steps)


# ── POST /rotate ─────────────────────────────────────────────────────

@router.post("/rotate", response_model=RotateResponse)
async def rotate_bridge_tokens(
    body: EmptyBody,
    user_id: str = Depends(get_user_id),
) -> RotateResponse:
    """Rotate AS/HS tokens: new tokens, rewrite config, restart both services."""
    _require_admin(user_id)

    steps: list[StepResult] = []

    # Step 1: rotate tokens (writes new registration file)
    try:
        reg = rotate_tokens()
        steps.append(StepResult(name="rotate_tokens", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="rotate_tokens", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))
        return RotateResponse(ok=False, steps=steps)

    # Step 2: inject updated config
    try:
        ensure_appservice_entry(reg)
        steps.append(StepResult(name="inject_tuwunel_toml", status="ok"))
    except Exception as exc:
        steps.append(StepResult(
            name="inject_tuwunel_toml", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))
        return RotateResponse(ok=False, steps=steps)

    # Step 3: restart conduwuit
    try:
        result = await restart_compose_service("conduwuit")
        steps.append(StepResult(
            name="restart_conduwuit", status="ok",
            detail=_redact_for_logging(result),
        ))
    except DockerControlError as exc:
        steps.append(StepResult(
            name="restart_conduwuit", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    # Step 4: restart bridge to pick up new tokens
    try:
        result = await restart_compose_service("concord-discord-bridge")
        steps.append(StepResult(
            name="restart_bridge", status="ok",
            detail=_redact_for_logging(result),
        ))
    except DockerControlError as exc:
        steps.append(StepResult(
            name="restart_bridge", status="failed",
            detail=_redact_for_logging(str(exc)),
        ))

    return RotateResponse(ok=True, steps=steps)
