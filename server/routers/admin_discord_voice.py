from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from dependencies import require_server_admin
from models import Channel, DiscordVoiceBridge
from routers.servers import get_user_id
from services.discord_voice_config import (
    ROOMS_FILE,
    list_voice_bridge_rooms,
    write_voice_bridge_rooms,
)
from services.docker_control import (
    DockerControlError,
    restart_compose_service,
    start_compose_service,
    stop_compose_service,
)


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin/bridges/discord/voice",
    tags=["admin", "bridges", "voice"],
)


class DiscordVoiceBridgeRequest(BaseModel):
    channel_id: int = Field(description="Concord channel id for a voice channel")
    discord_guild_id: str = Field(min_length=1, max_length=32)
    discord_channel_id: str = Field(min_length=1, max_length=32)
    enabled: bool = True
    model_config = {"extra": "forbid"}


class DiscordVoiceBridgeResponse(BaseModel):
    id: int
    server_id: str
    channel_id: int
    matrix_room_id: str
    discord_guild_id: str
    discord_channel_id: str
    enabled: bool


class DiscordVoiceMutationResponse(BaseModel):
    ok: bool
    message: str
    docker: dict | None = None


def _bridge_response(row: DiscordVoiceBridge) -> DiscordVoiceBridgeResponse:
    return DiscordVoiceBridgeResponse(
        id=row.id,
        server_id=row.server_id,
        channel_id=row.channel_id,
        matrix_room_id=row.matrix_room_id,
        discord_guild_id=row.discord_guild_id,
        discord_channel_id=row.discord_channel_id,
        enabled=bool(row.enabled),
    )


async def _get_voice_channel(
    channel_id: int,
    user_id: str,
    db: AsyncSession,
) -> Channel:
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Voice channel not found")
    if channel.channel_type != "voice":
        raise HTTPException(status_code=422, detail="Only Concord voice channels can be bridged")
    await require_server_admin(channel.server_id, user_id, db)
    return channel


@router.get("/rooms", response_model=list[DiscordVoiceBridgeResponse])
async def discord_voice_bridge_rooms(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[DiscordVoiceBridgeResponse]:
    """List Discord voice mappings visible to the current admin."""
    result = await db.execute(select(DiscordVoiceBridge).order_by(DiscordVoiceBridge.id))
    rows: list[DiscordVoiceBridgeResponse] = []
    for row in result.scalars().all():
        await require_server_admin(row.server_id, user_id, db)
        rows.append(_bridge_response(row))
    return rows


@router.post("/rooms", response_model=DiscordVoiceBridgeResponse)
async def discord_voice_bridge_upsert_room(
    body: DiscordVoiceBridgeRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceBridgeResponse:
    """Create or replace the Discord voice mapping for one Concord voice channel."""
    channel = await _get_voice_channel(body.channel_id, user_id, db)

    result = await db.execute(
        select(DiscordVoiceBridge).where(
            DiscordVoiceBridge.matrix_room_id == channel.matrix_room_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        row = DiscordVoiceBridge(
            server_id=channel.server_id,
            channel_id=channel.id,
            matrix_room_id=channel.matrix_room_id,
            discord_guild_id=body.discord_guild_id,
            discord_channel_id=body.discord_channel_id,
            enabled=body.enabled,
            created_by=user_id,
        )
        db.add(row)
    else:
        row.discord_guild_id = body.discord_guild_id
        row.discord_channel_id = body.discord_channel_id
        row.enabled = body.enabled

    await db.commit()
    await db.refresh(row)
    await write_voice_bridge_rooms(db)
    logger.info("discord voice bridge mapping updated: id=%s by=%s", row.id, user_id)
    return _bridge_response(row)


@router.delete("/rooms/{bridge_id}", response_model=DiscordVoiceMutationResponse)
async def discord_voice_bridge_delete_room(
    bridge_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceMutationResponse:
    row = await db.get(DiscordVoiceBridge, bridge_id)
    if not row:
        raise HTTPException(status_code=404, detail="Bridge mapping not found")
    await require_server_admin(row.server_id, user_id, db)
    await db.delete(row)
    await db.commit()
    await write_voice_bridge_rooms(db)
    logger.info("discord voice bridge mapping deleted: id=%s by=%s", bridge_id, user_id)
    return DiscordVoiceMutationResponse(ok=True, message="Discord voice bridge mapping deleted.")


@router.post("/sync", response_model=DiscordVoiceMutationResponse)
async def discord_voice_bridge_sync(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceMutationResponse:
    """Rewrite rooms.json from the database without changing Docker state."""
    rooms = await list_voice_bridge_rooms(db)
    for room in rooms:
        await require_server_admin(room["server_id"], user_id, db)
    await write_voice_bridge_rooms(db)
    return DiscordVoiceMutationResponse(
        ok=True,
        message=f"Discord voice bridge config written to {ROOMS_FILE}.",
    )


@router.post("/start", response_model=DiscordVoiceMutationResponse)
async def discord_voice_bridge_start(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceMutationResponse:
    rooms = await list_voice_bridge_rooms(db)
    for room in rooms:
        await require_server_admin(room["server_id"], user_id, db)
    await write_voice_bridge_rooms(db)
    try:
        result = await start_compose_service("concord-discord-voice-bridge")
    except DockerControlError as exc:
        detail = str(exc)
        if "No container with label" in detail:
            detail = (
                "Discord voice bridge service has not been created on this host. "
                "Run `docker compose up -d --build concord-discord-voice-bridge` once, then retry."
            )
        raise HTTPException(status_code=502, detail=detail) from exc
    return DiscordVoiceMutationResponse(
        ok=True,
        message="Discord voice bridge started.",
        docker=result,
    )


@router.post("/restart", response_model=DiscordVoiceMutationResponse)
async def discord_voice_bridge_restart(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceMutationResponse:
    rooms = await list_voice_bridge_rooms(db)
    for room in rooms:
        await require_server_admin(room["server_id"], user_id, db)
    await write_voice_bridge_rooms(db)
    try:
        result = await restart_compose_service("concord-discord-voice-bridge")
    except DockerControlError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return DiscordVoiceMutationResponse(
        ok=True,
        message="Discord voice bridge restarted.",
        docker=result,
    )


@router.post("/stop", response_model=DiscordVoiceMutationResponse)
async def discord_voice_bridge_stop(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordVoiceMutationResponse:
    rooms = await list_voice_bridge_rooms(db)
    for room in rooms:
        await require_server_admin(room["server_id"], user_id, db)
    try:
        result = await stop_compose_service("concord-discord-voice-bridge")
    except DockerControlError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return DiscordVoiceMutationResponse(
        ok=True,
        message="Discord voice bridge stopped.",
        docker=result,
    )
