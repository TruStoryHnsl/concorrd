import json
from typing import Any

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import MATRIX_HOMESERVER_URL
from database import get_db
from models import Channel, DMConversation, Server, ServerMember
from routers.servers import get_access_token, get_user_id

router = APIRouter(tags=["rooms"])


def _truncate(value: Any, limit: int = 500) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        text = json.dumps(value, separators=(",", ":"))
    else:
        text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


@router.get("/api/rooms/{room_id}/diagnostics")
async def get_room_diagnostics(
    room_id: str,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    channel_result = await db.execute(
        select(Channel, Server)
        .join(Server, Server.id == Channel.server_id)
        .join(ServerMember, ServerMember.server_id == Server.id)
        .where(
            Channel.matrix_room_id == room_id,
            ServerMember.user_id == user_id,
        )
        .limit(1)
    )
    channel_row = channel_result.first()

    dm_result = await db.execute(
        select(DMConversation).where(
            DMConversation.matrix_room_id == room_id,
            or_(
                DMConversation.user_a == user_id,
                DMConversation.user_b == user_id,
            ),
        )
    )
    dm = dm_result.scalar_one_or_none()

    binding: dict[str, Any] = {"kind": "unknown"}
    if channel_row:
        channel, server = channel_row
        binding = {
            "kind": "server_channel",
            "server_id": server.id,
            "server_name": server.name,
            "channel_id": channel.id,
            "channel_name": channel.name,
            "channel_type": channel.channel_type,
        }
    elif dm:
        binding = {
            "kind": "dm",
            "conversation_id": dm.id,
            "other_user_id": dm.user_b if dm.user_a == user_id else dm.user_a,
        }

    steps: list[dict[str, Any]] = []
    inference = "unknown"
    summary = "No diagnosis yet."

    async with httpx.AsyncClient(timeout=10.0) as client:
        async def probe(name: str, method: str, url: str) -> httpx.Response | None:
            try:
                resp = await client.request(
                    method,
                    url,
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            except Exception as err:
                steps.append(
                    {
                        "step": name,
                        "ok": False,
                        "status": None,
                        "detail": _truncate(err),
                    }
                )
                return None

            payload: Any
            try:
                payload = resp.json()
            except Exception:
                payload = resp.text

            detail = ""
            if name == "joined_members" and isinstance(payload, dict):
                joined = payload.get("joined", {})
                detail = f"joined_count={len(joined)} current_user_present={user_id in joined}"
            elif name == "messages_backfill" and isinstance(payload, dict):
                detail = (
                    f"chunk_count={len(payload.get('chunk', []))} "
                    f"start={payload.get('start')} end={payload.get('end')}"
                )
            elif name == "room_create_state" and isinstance(payload, dict):
                detail = f"type={payload.get('type')} creator={payload.get('creator')}"
            else:
                detail = _truncate(payload)

            steps.append(
                {
                    "step": name,
                    "ok": 200 <= resp.status_code < 300,
                    "status": resp.status_code,
                    "detail": detail,
                }
            )
            return resp

        joined_members = await probe(
            "joined_members",
            "GET",
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/joined_members",
        )
        messages_backfill = await probe(
            "messages_backfill",
            "GET",
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/messages?dir=b&limit=5",
        )
        room_create_state = await probe(
            "room_create_state",
            "GET",
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.create",
        )

    joined_status = joined_members.status_code if joined_members else None
    backfill_status = messages_backfill.status_code if messages_backfill else None
    state_status = room_create_state.status_code if room_create_state else None

    if joined_status == 403:
        inference = "membership_missing_or_forbidden"
        summary = "The homeserver does not currently allow this account to read joined-member state for the room."
    elif backfill_status == 403:
        inference = "history_forbidden"
        summary = "The room exists, but the homeserver is rejecting history backfill for this account."
    elif state_status == 404 and backfill_status == 404:
        inference = "room_missing"
        summary = "The homeserver no longer recognizes this room ID."
    elif joined_status == 200 and backfill_status == 200:
        try:
            payload = messages_backfill.json()
            chunk = payload.get("chunk", []) if isinstance(payload, dict) else []
        except Exception:
            chunk = []
        if len(chunk) == 0:
            inference = "room_accessible_but_empty"
            summary = "The room is reachable and history backfill succeeded, but no earlier events were returned."
        else:
            inference = "room_accessible"
            summary = "The room is reachable and the homeserver returned historical events."
    elif joined_status == 200 and backfill_status is None:
        inference = "backfill_request_failed"
        summary = "The room membership probe succeeded, but history backfill failed before a response came back."

    return {
        "room_id": room_id,
        "user_id": user_id,
        "binding": binding,
        "inference": inference,
        "summary": summary,
        "steps": steps,
    }
