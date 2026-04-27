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


# Credential TTL: how long a TURN credential is valid (seconds)
TURN_CREDENTIAL_TTL = 86400  # 24 hours


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "")
    if not raw:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _turn_secret() -> str:
    return os.getenv("TURN_SECRET", "").strip()


def _turn_domain() -> str:
    return os.getenv("TURN_DOMAIN", "localhost").strip() or "localhost"


def _turn_host() -> str:
    return os.getenv("TURN_HOST", "").strip() or _turn_domain()


def _turn_port() -> int:
    raw = os.getenv("TURN_PORT", "3478").strip()
    try:
        return int(raw)
    except ValueError:
        return 3478


def _turn_public_port() -> int:
    raw = os.getenv("TURN_PUBLIC_PORT", "").strip()
    if not raw:
        return _turn_port()
    try:
        return int(raw)
    except ValueError:
        return _turn_port()


def _turn_tls_port() -> int:
    raw = os.getenv("TURN_TLS_PORT", "5349").strip()
    try:
        return int(raw)
    except ValueError:
        return 5349


def _turn_public_tls_port() -> int:
    raw = os.getenv("TURN_PUBLIC_TLS_PORT", "").strip()
    if not raw:
        return _turn_tls_port()
    try:
        return int(raw)
    except ValueError:
        return _turn_tls_port()


def _turn_tls_enabled() -> bool:
    return _env_flag("TURN_TLS_ENABLED", default=False)


def _turn_tls_only() -> bool:
    return _env_flag("TURN_TLS_ONLY", default=False)


def _turn_external_ip() -> str:
    return os.getenv("TURN_EXTERNAL_IP", "").strip()


def _turn_bind_ip() -> str:
    listen_ip = os.getenv("TURN_LISTEN_IP", "").strip()
    if listen_ip:
        return listen_ip
    external_ip = _turn_external_ip()
    if "/" in external_ip:
        private_ip = external_ip.split("/", 1)[1].strip()
        if private_ip:
            return private_ip
    return "127.0.0.1"


def _build_turn_ice_servers(turn_host: str, username: str, credential: str) -> list[IceServer]:
    urls: list[str] = []
    if _turn_tls_enabled():
        urls.append(f"turns:{turn_host}:{_turn_public_tls_port()}?transport=tcp")
    if not (_turn_tls_enabled() and _turn_tls_only()):
        port = _turn_public_port()
        urls.extend([
            f"turn:{turn_host}:{port}?transport=udp",
            f"turn:{turn_host}:{port}?transport=tcp",
        ])

    return [
        IceServer(
            urls=urls,
            username=username,
            credential=credential,
        ),
        IceServer(urls="stun:stun.l.google.com:19302"),
    ]


def _generate_turn_credentials(user_id: str) -> list[IceServer]:
    """Generate time-limited TURN credentials using the shared secret (RFC 5389).

    coturn validates these using the same shared secret. The username encodes
    an expiry timestamp so credentials auto-expire without a database.
    """
    turn_secret = _turn_secret()
    if not turn_secret:
        return []

    import hashlib
    import base64
    import time as _time

    expiry = int(_time.time()) + TURN_CREDENTIAL_TTL
    username = f"{expiry}:{user_id}"
    # HMAC-SHA1 of the username with the shared secret
    mac = hmac.new(turn_secret.encode(), username.encode(), hashlib.sha1)
    credential = base64.b64encode(mac.digest()).decode()

    return _build_turn_ice_servers(_turn_host(), username, credential)


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
        room_name=channel.matrix_room_id,
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


class TurnCheckResponse(BaseModel):
    turn_configured: bool
    turn_reachable: bool = False
    turn_latency_ms: float | None = None
    turn_host: str | None = None
    turn_ports: list[str] = []
    livekit_healthy: bool = False
    diagnostics: str = ""


@router.get("/turn-check", response_model=TurnCheckResponse)
async def check_turn_health(
    user_id: str = Depends(get_user_id),
):
    """Diagnostic endpoint: check whether the bundled TURN relay is reachable.

    Generates ephemeral credentials and attempts a STUN binding request
    to the configured TURN host on port 3478/UDP. Also validates that
    the LiveKit SFU is reachable over its internal HTTP API. Returns
    structured diagnostics so operators and clients can pinpoint voice
    connectivity issues.

    Requires authentication (any logged-in user) to prevent abuse as a
    network scanning primitive.
    """
    turn_host = _turn_host()
    turn_port = _turn_public_port()
    tls_enabled = _turn_tls_enabled()
    tls_only = _turn_tls_only()
    tls_port = _turn_tls_port()
    public_tls_port = _turn_public_tls_port()
    turn_external_ip = _turn_external_ip()
    has_secret = bool(_turn_secret())

    if not has_secret:
        return TurnCheckResponse(
            turn_configured=False,
            diagnostics="TURN_SECRET not set — TURN relay is not configured. "
                        "Voice will only work on direct connections (no NAT traversal).",
        )

    turn_ports: list[str] = []
    if not (tls_enabled and tls_only):
        turn_ports.extend([
            f"turn:{turn_host}:{turn_port}/udp",
            f"turn:{turn_host}:{turn_port}/tcp",
        ])
    if tls_enabled:
        turn_ports.insert(0, f"turns:{turn_host}:{public_tls_port}/tcp")

    # Attempt a lightweight STUN binding check when plain TURN is advertised.
    import socket
    import struct
    import time as _time

    turn_reachable = False
    latency_ms: float | None = None
    diag_parts: list[str] = []

    if not (tls_enabled and tls_only):
        try:
            # STUN Binding Request: RFC 5389 minimal header (20 bytes)
            # Type=0x0001 (Binding Request), Length=0, Magic=0x2112A442, TxID=12 random bytes
            import secrets
            tx_id = secrets.token_bytes(12)
            stun_header = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tx_id

            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(3.0)
            start = _time.monotonic()
            sock.sendto(stun_header, (turn_host, turn_port))
            try:
                data, _ = sock.recvfrom(1024)
                elapsed = _time.monotonic() - start
                latency_ms = round(elapsed * 1000, 1)
                # Validate it's a STUN response (type 0x0101 = Binding Success)
                if len(data) >= 20:
                    resp_type = struct.unpack("!H", data[:2])[0]
                    if resp_type == 0x0101:
                        turn_reachable = True
                        diag_parts.append(f"STUN binding succeeded in {latency_ms}ms")
                    else:
                        diag_parts.append(f"Got STUN response type 0x{resp_type:04x} (expected 0x0101)")
                else:
                    diag_parts.append(f"Got {len(data)} bytes (too short for STUN)")
            except socket.timeout:
                diag_parts.append(f"STUN binding to {turn_host}:{turn_port}/udp timed out (3s)")
            finally:
                sock.close()
        except Exception as e:
            diag_parts.append(f"STUN check failed: {e}")
    else:
        diag_parts.append("Plain TURN disabled; skipping UDP STUN probe")

    if not turn_external_ip:
        diag_parts.append("TURN_EXTERNAL_IP not set; relay allocations may advertise a private host address")
    if tls_enabled:
        bind_ip = _turn_bind_ip()
        try:
            start = _time.monotonic()
            with socket.create_connection((bind_ip, tls_port), timeout=3.0):
                elapsed = _time.monotonic() - start
            if latency_ms is None:
                latency_ms = round(elapsed * 1000, 1)
            turn_reachable = True
            diag_parts.append(
                f"TLS TURN advertised on {turn_host}:{public_tls_port}/tcp via {bind_ip}:{tls_port}"
            )
        except Exception as exc:
            diag_parts.append(
                f"TLS TURN advertised on {turn_host}:{public_tls_port}/tcp but internal listener "
                f"{bind_ip}:{tls_port} is unreachable: {exc}"
            )
    else:
        diag_parts.append("TLS TURN disabled; relay uses 3478 udp/tcp only")

    # Check LiveKit health
    lk_healthy = False
    lk_url = LIVEKIT_URL.replace("ws://", "http://").replace("wss://", "https://")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(lk_url)
            lk_healthy = resp.status_code < 500
            if lk_healthy:
                diag_parts.append("LiveKit SFU reachable")
            else:
                diag_parts.append(f"LiveKit returned HTTP {resp.status_code}")
    except Exception as e:
        diag_parts.append(f"LiveKit unreachable: {e}")

    return TurnCheckResponse(
        turn_configured=True,
        turn_reachable=turn_reachable,
        turn_latency_ms=latency_ms,
        turn_host=turn_host,
        turn_ports=turn_ports,
        livekit_healthy=lk_healthy,
        diagnostics="; ".join(diag_parts),
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
