import hmac
import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from livekit import api as livekit_api
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from dependencies import require_server_member
from errors import ConcordError
from models import Channel, ServerMember
from routers.servers import get_user_id
from services.livekit_tokens import generate_token, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice", tags=["voice"])

METERED_APP_NAME = os.getenv("METERED_APP_NAME", "")
METERED_API_KEY = os.getenv("METERED_API_KEY", "")


class VoiceTokenRequest(BaseModel):
    # Matrix room IDs look like "!opaque:server.tld" — bound the length
    # so a malicious client can't ship a megabyte of "room_name" and
    # blow up the server.
    room_name: str = Field(
        min_length=1,
        max_length=255,
        description="The Matrix room ID of the voice channel.",
    )


class IceServer(BaseModel):
    urls: str | list[str]
    username: Optional[str] = None
    credential: Optional[str] = None


class VoiceTokenResponse(BaseModel):
    token: str
    livekit_url: str
    ice_servers: list[IceServer] = []


TURN_SECRET = os.getenv("TURN_SECRET", "")
TURN_DOMAIN = os.getenv("TURN_DOMAIN", "localhost")
# Credential TTL: how long a TURN credential is valid (seconds)
TURN_CREDENTIAL_TTL = 86400  # 24 hours


def _generate_turn_credentials(user_id: str) -> list[IceServer]:
    """Generate time-limited TURN credentials using the shared secret (RFC 5389).

    coturn validates these using the same shared secret. The username encodes
    an expiry timestamp so credentials auto-expire without a database.
    """
    if not TURN_SECRET:
        return []

    import hashlib
    import base64
    import time as _time

    expiry = int(_time.time()) + TURN_CREDENTIAL_TTL
    username = f"{expiry}:{user_id}"
    # HMAC-SHA1 of the username with the shared secret
    mac = hmac.new(TURN_SECRET.encode(), username.encode(), hashlib.sha1)
    credential = base64.b64encode(mac.digest()).decode()

    turn_host = os.getenv("TURN_HOST", TURN_DOMAIN)
    return [
        # TURNS (TLS) on port 443 — sslh on the host multiplexes by SNI:
        #   turn.concorrd.com → coturn TLS (port 5349)
        #   everything else   → npm (HTTPS)
        # This works through any firewall since 443 is always open.
        IceServer(
            urls=[
                f"turns:{turn_host}:443?transport=tcp",
                f"turn:{turn_host}:3478?transport=udp",
                f"turn:{turn_host}:3478?transport=tcp",
            ],
            username=username,
            credential=credential,
        ),
        # STUN (discovery only, no relay)
        IceServer(urls="stun:stun.l.google.com:19302"),
    ]


async def _fetch_turn_credentials(user_id: str = "") -> list[IceServer]:
    """Get TURN credentials — uses local coturn if configured, falls back to Metered.ca."""
    # Prefer local coturn with shared secret (no external dependency)
    local_creds = _generate_turn_credentials(user_id)
    if local_creds:
        return local_creds

    # Fallback: Metered.ca free TURN API
    if not METERED_API_KEY or not METERED_APP_NAME:
        return []
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"https://{METERED_APP_NAME}.metered.live/api/v1/turn/credentials"
                f"?apiKey={METERED_API_KEY}"
            )
            resp.raise_for_status()
            servers = resp.json()
            return [IceServer(**s) for s in servers]
    except Exception as e:
        logger.warning("Failed to fetch TURN credentials: %s", e)
        return []


@router.post("/token", response_model=VoiceTokenResponse)
async def get_voice_token(
    body: VoiceTokenRequest,
    request: Request,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Generate a LiveKit token for joining a voice channel.

    The room_name should be the matrix_room_id of the voice channel.
    The user_id from the auth header is used as the participant identity.
    Verifies the user is a member of the server that owns this room.
    """
    # Look up which server owns this room and verify membership
    result = await db.execute(
        select(Channel).where(Channel.matrix_room_id == body.room_name)
    )
    channel = result.scalar_one_or_none()
    if not channel:
        raise ConcordError(
            error_code="RESOURCE_NOT_FOUND",
            message="Voice channel not found",
            status_code=404,
        )

    await require_server_member(channel.server_id, user_id, db)

    # Extract display name from Matrix user ID (@user:server -> user)
    display_name = user_id.split(":")[0].replace("@", "")

    token = generate_token(
        identity=user_id,
        room_name=body.room_name,
        name=display_name,
    )

    # Build the client-facing LiveKit URL through the reverse proxy.
    # The browser can't reach the internal Docker hostname (ws://livekit:7880),
    # so we route through Caddy's /livekit/ path using the request's Host header.
    host = request.headers.get("host", "localhost:8080")
    scheme = "ws"
    # Detect HTTPS: check forwarded headers from any proxy in the chain
    # (Cloudflare, NPM, Caddy all may set different headers)
    if (request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https"
        or request.headers.get("x-forwarded-scheme") == "https"
        or request.headers.get("cf-visitor", "").find('"scheme":"https"') >= 0
    ):
        scheme = "wss"
    client_url = f"{scheme}://{host}/livekit/"

    # Fetch TURN credentials for NAT traversal
    ice_servers = await _fetch_turn_credentials(user_id)

    return VoiceTokenResponse(
        token=token, livekit_url=client_url, ice_servers=ice_servers
    )


class VoiceParticipant(BaseModel):
    identity: str
    name: str


@router.get("/participants")
async def get_voice_participants(
    rooms: str = Query(
        ...,
        min_length=1,
        max_length=8192,
        description="Comma-separated Matrix room IDs (max 8KB total).",
    ),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List active participants in voice channels.

    Returns a dict of room_id → participant list for each requested room.
    Only returns data for rooms the user has access to (member of the server).
    """
    room_ids = [r.strip() for r in rooms.split(",") if r.strip()]
    if not room_ids:
        return {}

    # Filter to only rooms the user has access to via server membership
    accessible_rooms = set()
    for room_id in room_ids:
        result = await db.execute(
            select(Channel).where(Channel.matrix_room_id == room_id)
        )
        channel = result.scalar_one_or_none()
        if channel:
            member_result = await db.execute(
                select(ServerMember).where(
                    ServerMember.server_id == channel.server_id,
                    ServerMember.user_id == user_id,
                )
            )
            if member_result.scalar_one_or_none():
                accessible_rooms.add(room_id)

    if not accessible_rooms:
        return {}
    room_ids = list(accessible_rooms)

    # Convert ws:// → http:// for LiveKit REST API
    lk_url = LIVEKIT_URL.replace("ws://", "http://").replace("wss://", "https://")
    lk_client = livekit_api.LiveKitAPI(lk_url, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

    result: dict[str, list[dict]] = {}
    try:
        for room_id in room_ids:
            try:
                resp = await lk_client.room.list_participants(
                    livekit_api.ListParticipantsRequest(room=room_id)
                )
                result[room_id] = [
                    {"identity": p.identity, "name": p.name}
                    for p in resp.participants
                ]
            except Exception:
                result[room_id] = []
    finally:
        await lk_client.aclose()

    return result
