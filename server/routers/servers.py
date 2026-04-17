import asyncio
import logging
import shutil
import time
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from config import MATRIX_HOMESERVER_URL, SOUNDBOARD_DIR
from database import get_db
from dependencies import require_server_member, require_server_admin, require_server_owner
from errors import ConcordError
from models import Server, Channel, ServerMember, ServerBan, ServerWhitelist, SoundboardClip
from services.matrix_admin import create_matrix_room, invite_to_room, join_room, set_room_name


# Matrix user ID regex shared across server endpoints. Bounds the
# input length and shape so a malicious client can't ship a megabyte
# blob to /api/servers/{id}/bans.
_MATRIX_USER_ID_PATTERN = r"^@[a-zA-Z0-9._=\-/+]+:[a-zA-Z0-9.\-]+$"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["servers"])

# Simple TTL cache for token -> user_id validation
# Avoids hitting Matrix homeserver on every request
_token_cache: dict[str, tuple[str, float]] = {}
_token_cache_lock = asyncio.Lock()
_CACHE_TTL = 300  # 5 minutes
_CACHE_MAX_SIZE = 1000

# One-shot per-process backfill tracking. When an owner first lists their
# servers after a deploy, we fan out invites for any channel created BEFORE
# the auto-invite code shipped (where members were never invited). The set
# resets on process restart, which is fine — the work is idempotent.
_reconciled_owner_servers: set[tuple[str, str]] = set()
_reconcile_lock = asyncio.Lock()


class ServerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    visibility: Literal["public", "private"] = "private"
    abbreviation: str | None = Field(
        default=None,
        min_length=1,
        max_length=3,
        pattern=r"^[A-Za-z0-9]+$",
    )


class ChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_\- ]+$")
    channel_type: Literal["text", "voice"] = "text"


class ChannelUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_\- ]+$")


class ChannelReorder(BaseModel):
    order: list[int] = Field(
        ...,
        min_length=0,
        max_length=1000,
        description="Channel IDs in desired order. Must contain every channel of the server exactly once.",
    )


class ChannelOut(BaseModel):
    id: int
    name: str
    channel_type: str
    matrix_room_id: str
    position: int

    model_config = {"from_attributes": True}


class ServerOut(BaseModel):
    id: str
    name: str
    icon_url: str | None
    owner_id: str
    visibility: str
    abbreviation: str | None
    media_uploads_enabled: bool = True
    rules_text: str | None = None
    allow_user_channel_creation: bool = False
    channels: list[ChannelOut]

    model_config = {"from_attributes": True}


class ServerSettingsUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    visibility: Literal["public", "private"] | None = None
    abbreviation: str | None = Field(
        default=None,
        max_length=3,
        pattern=r"^[A-Za-z0-9]*$",
    )
    media_uploads_enabled: bool | None = None
    rules_text: str | None = Field(default=None, max_length=2000)


class MemberOut(BaseModel):
    user_id: str
    role: str
    display_name: str | None
    joined_at: str
    can_kick: bool = False
    can_ban: bool = False

    model_config = {"from_attributes": True}


class RoleUpdate(BaseModel):
    role: Literal["admin", "member"]


class DisplayNameUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=32)


class BanCreate(BaseModel):
    user_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=_MATRIX_USER_ID_PATTERN,
    )


class WhitelistAdd(BaseModel):
    user_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=_MATRIX_USER_ID_PATTERN,
    )


class ServerDiscoverOut(BaseModel):
    id: str
    name: str
    icon_url: str | None
    abbreviation: str | None
    member_count: int


async def get_user_id(authorization: Optional[str] = Header(None)) -> str:
    """Validate the Bearer token against the Matrix homeserver and return the user ID.

    The client sends: Authorization: Bearer <matrix_access_token>
    We call /_matrix/client/v3/account/whoami to verify ownership.
    Results are cached for 5 minutes to reduce per-request overhead.
    """
    if authorization is None:
        raise HTTPException(401, "Authorization header required")
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization header must use Bearer scheme")

    token = authorization[7:]  # Strip "Bearer "
    if not token:
        raise HTTPException(401, "Missing access token")

    # Check cache (lock-free read for the fast path)
    now = time.time()
    cached = _token_cache.get(token)
    if cached:
        user_id, expires = cached
        if now < expires:
            return user_id

    # Validate against Matrix homeserver
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/account/whoami",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.RequestError:
        raise HTTPException(502, "Unable to reach Matrix homeserver for auth")

    if resp.status_code == 401:
        logger.warning("Auth failed: invalid or expired token (first 8 chars: %s...)", token[:8])
        raise HTTPException(401, "Invalid or expired access token")
    if resp.status_code != 200:
        logger.warning("Auth failed: Matrix homeserver returned %d", resp.status_code)
        raise HTTPException(502, "Matrix homeserver auth check failed")

    user_id = resp.json().get("user_id")
    if not user_id:
        raise HTTPException(401, "Token did not resolve to a user")

    # Write to cache under lock to prevent race conditions
    async with _token_cache_lock:
        # Evict if cache is at capacity
        if len(_token_cache) >= _CACHE_MAX_SIZE:
            expired = [k for k, (_, exp) in _token_cache.items() if now >= exp]
            for k in expired:
                del _token_cache[k]
            if len(_token_cache) >= _CACHE_MAX_SIZE:
                sorted_keys = sorted(_token_cache, key=lambda k: _token_cache[k][1])
                for k in sorted_keys[: len(sorted_keys) // 4]:
                    del _token_cache[k]

        _token_cache[token] = (user_id, now + _CACHE_TTL)

    return user_id


def get_access_token(authorization: str = Header(...)) -> str:
    """Extract the Matrix access token from the Authorization: Bearer header."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization header must use Bearer scheme")
    return authorization[7:]


async def _backfill_channel_invites(
    server_id: str,
    owner_id: str,
    owner_token: str,
    db: AsyncSession,
) -> None:
    """Re-invite every server member to every channel of a server.

    Used as a one-shot backfill for channels that existed before the
    auto-invite-on-create code shipped. Runs idempotently — Matrix's
    invite endpoint silently no-ops when the user is already a member,
    so calling this repeatedly is safe.

    Uses the OWNER's access token (PL 100 in every channel they created)
    so it can invite anyone, regardless of whether the target user has
    ever logged into Concord recently.
    """
    channels_result = await db.execute(
        select(Channel).where(Channel.server_id == server_id)
    )
    channels = list(channels_result.scalars().all())

    members_result = await db.execute(
        select(ServerMember.user_id).where(ServerMember.server_id == server_id)
    )
    member_ids = [uid for (uid,) in members_result.all() if uid != owner_id]

    if not channels or not member_ids:
        logger.info(
            "backfill: server=%s nothing to do (channels=%d members=%d)",
            server_id, len(channels), len(member_ids),
        )
        return

    logger.info(
        "backfill: server=%s reconciling %d channel(s) x %d member(s) = %d invites",
        server_id, len(channels), len(member_ids), len(channels) * len(member_ids),
    )

    async def _invite(ch: Channel, uid: str) -> tuple[str, str, bool, str]:
        try:
            await invite_to_room(owner_token, ch.matrix_room_id, uid)
            return (ch.name, uid, True, "")
        except Exception as e:
            return (ch.name, uid, False, str(e))

    tasks = [_invite(ch, uid) for ch in channels for uid in member_ids]
    results = await asyncio.gather(*tasks)
    ok = sum(1 for _, _, success, _ in results if success)
    for ch_name, uid, success, err in results:
        if success:
            logger.info("  backfill %s -> %s OK", ch_name, uid)
        else:
            logger.warning("  backfill %s -> %s FAIL: %s", ch_name, uid, err)
    logger.info(
        "backfill: server=%s complete %d/%d invites succeeded",
        server_id, ok, len(tasks),
    )


@router.get("", response_model=list[ServerOut])
async def list_servers(
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """List servers the user is a member of.

    Also auto-joins the user to the default lobby if they aren't already a member.
    """
    # Auto-join lobby for users who aren't members yet
    try:
        import json
        from config import INSTANCE_SETTINGS_FILE

        if INSTANCE_SETTINGS_FILE.exists():
            inst_settings = json.loads(INSTANCE_SETTINGS_FILE.read_text())
            default_id = inst_settings.get("default_server_id")
            if default_id:
                existing = await db.execute(
                    select(ServerMember).where(
                        ServerMember.server_id == default_id,
                        ServerMember.user_id == user_id,
                    )
                )
                if not existing.scalar_one_or_none():
                    db.add(ServerMember(
                        server_id=default_id,
                        user_id=user_id,
                        role="member",
                    ))
                    # Join all lobby Matrix rooms
                    lobby_channels = await db.execute(
                        select(Channel).where(Channel.server_id == default_id)
                    )
                    for ch in lobby_channels.scalars().all():
                        try:
                            await join_room(access_token, ch.matrix_room_id)
                        except Exception:
                            pass
                    await db.commit()
                    logger.info("Auto-joined %s to lobby", user_id)
    except Exception as e:
        logger.warning("Lobby auto-join failed for %s: %s", user_id, e)

    result = await db.execute(
        select(Server)
        .join(ServerMember, ServerMember.server_id == Server.id)
        .where(ServerMember.user_id == user_id)
        .options(selectinload(Server.channels))
        .order_by(Server.created_at)
    )
    servers = list(result.scalars().all())
    # Sort channels in-Python by position so the client can render them
    # in the order the owner picked via drag-and-drop reorder. Done after
    # load rather than via a relationship order_by so we don't need to
    # touch the model relationship definition.
    for srv in servers:
        srv.channels.sort(key=lambda c: c.position)

    # One-shot per-process backfill: for every server this caller owns,
    # invite all members to every channel they aren't already in. Catches
    # channels created before the auto-invite-on-create code shipped.
    # Runs in the background so the response isn't blocked. The set is
    # process-local; on restart we re-run, which is idempotent.
    owned_to_backfill: list[str] = []
    async with _reconcile_lock:
        for srv in servers:
            if srv.owner_id != user_id:
                continue
            key = (srv.id, user_id)
            if key in _reconciled_owner_servers:
                continue
            _reconciled_owner_servers.add(key)
            owned_to_backfill.append(srv.id)

    for srv_id in owned_to_backfill:
        # Schedule as a background task — don't block list_servers
        asyncio.create_task(_run_backfill_safely(srv_id, user_id, access_token))

    return servers


async def _run_backfill_safely(server_id: str, owner_id: str, owner_token: str) -> None:
    """Wrapper that opens its own DB session for the background backfill task."""
    from database import async_session
    try:
        async with async_session() as session:
            await _backfill_channel_invites(server_id, owner_id, owner_token, session)
    except Exception as e:
        logger.warning("backfill task failed for server=%s: %s", server_id, e)
        # Allow retry on next list_servers call
        async with _reconcile_lock:
            _reconciled_owner_servers.discard((server_id, owner_id))


@router.get("/default")
async def get_default_server(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get the default public lobby server info."""
    import json
    from config import INSTANCE_SETTINGS_FILE

    settings: dict = {}
    if INSTANCE_SETTINGS_FILE.exists():
        settings = json.loads(INSTANCE_SETTINGS_FILE.read_text())

    server_id = settings.get("default_server_id")
    if not server_id:
        return {"server_id": None}

    # Check if user is already a member
    existing = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == user_id,
        )
    )
    is_member = existing.scalar_one_or_none() is not None

    server = await db.get(Server, server_id)
    if not server:
        return {"server_id": None}

    return {
        "server_id": server_id,
        "server_name": server.name,
        "is_member": is_member,
    }


@router.post("", response_model=ServerOut)
async def create_server(
    body: ServerCreate,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Create a new server with a default 'general' text channel."""
    # Create the server record and flush to populate the generated ID
    server = Server(
        name=body.name,
        owner_id=user_id,
        visibility=body.visibility,
        abbreviation=body.abbreviation,
    )
    db.add(server)
    await db.flush()

    # Auto-create owner membership
    db.add(ServerMember(server_id=server.id, user_id=user_id, role="owner"))

    # Create a default "general" channel as a Matrix room
    room_id = await create_matrix_room(access_token, f"{body.name} - general")
    channel = Channel(
        server_id=server.id,
        matrix_room_id=room_id,
        name="general",
        channel_type="text",
        position=0,
    )
    db.add(channel)
    await db.commit()

    # Reload with channels
    result = await db.execute(
        select(Server).options(selectinload(Server.channels)).where(Server.id == server.id)
    )
    created = result.scalar_one()
    created.channels.sort(key=lambda c: c.position)
    return created


@router.post("/{server_id}/channels", response_model=ChannelOut)
async def create_channel(
    server_id: str,
    body: ChannelCreate,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Add a new channel to a server.

    All existing server members are invited to the new Matrix room so the
    channel is immediately visible to everyone — not just the creator.

    INS-053: Requires admin/owner OR the server's allow_user_channel_creation
    flag to be True.
    """
    member = await require_server_member(server_id, user_id, db)

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    is_admin = member.role in ("owner", "admin")
    if not is_admin and not server.allow_user_channel_creation:
        raise HTTPException(403, "Channel creation requires admin role or server permission")

    # Get the next position
    result = await db.execute(
        select(Channel).where(Channel.server_id == server_id).order_by(Channel.position.desc())
    )
    last = result.scalars().first()
    position = (last.position + 1) if last else 0

    room_id = await create_matrix_room(access_token, f"{server.name} - {body.name}")
    channel = Channel(
        server_id=server_id,
        matrix_room_id=room_id,
        name=body.name,
        channel_type=body.channel_type,
        position=position,
    )
    db.add(channel)
    await db.commit()
    await db.refresh(channel)

    # Fan out Matrix invites to every other server member so the new channel
    # appears in their client immediately. Best-effort — a failed invite for
    # one user must not block channel creation. Runs concurrently to keep the
    # request fast on servers with many members.
    members_result = await db.execute(
        select(ServerMember.user_id).where(ServerMember.server_id == server_id)
    )
    member_ids = [uid for (uid,) in members_result.all() if uid != user_id]
    logger.info(
        "create_channel: inviting %d member(s) to new channel %s (room %s)",
        len(member_ids), body.name, room_id,
    )
    if member_ids:
        async def _invite(uid: str) -> tuple[str, bool, str]:
            try:
                await invite_to_room(access_token, room_id, uid)
                return (uid, True, "")
            except Exception as e:
                return (uid, False, str(e))

        results = await asyncio.gather(*(_invite(uid) for uid in member_ids))
        ok = sum(1 for _, success, _ in results if success)
        for uid, success, err in results:
            if success:
                logger.info("  invited %s -> OK", uid)
            else:
                logger.warning("  invited %s -> FAIL: %s", uid, err)
        logger.info("create_channel: %d/%d invites succeeded", ok, len(member_ids))

    return channel


class ServerChannelCreationUpdate(BaseModel):
    """INS-053: Toggle per-server user channel creation permission."""
    allow_user_channel_creation: bool


@router.patch("/{server_id}/settings/channel-creation")
async def update_channel_creation_setting(
    server_id: str,
    body: ServerChannelCreationUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Toggle allow_user_channel_creation for a server. Admin-only.

    INS-053: When True, any server member can create channels. When False
    (the default), only admins and the owner can.
    """
    await require_server_admin(server_id, user_id, db)
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    server.allow_user_channel_creation = body.allow_user_channel_creation
    await db.commit()
    return {"allow_user_channel_creation": server.allow_user_channel_creation}


@router.patch("/{server_id}/channels/reorder", response_model=list[ChannelOut])
async def reorder_channels(
    server_id: str,
    body: ChannelReorder,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Persist a new channel ordering for a server. Owner only.

    Accepts a full list of channel IDs in the desired display order.
    Every channel belonging to the server must appear exactly once; the
    request is rejected with 400 otherwise so clients can never end up
    with a partially-reordered sidebar.

    Positions are re-numbered densely starting at 0 to match the
    convention used by `create_channel` (first channel = position 0).
    Returns the updated channel list sorted by the new position.
    """
    await require_server_owner(server_id, user_id, db)

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    requested = body.order
    if len(requested) != len(set(requested)):
        raise HTTPException(400, "order contains duplicate channel ids")

    # Load all channels for this server and build an id -> channel map
    result = await db.execute(
        select(Channel).where(Channel.server_id == server_id)
    )
    channels = list(result.scalars().all())
    by_id = {c.id: c for c in channels}

    existing_ids = set(by_id.keys())
    requested_ids = set(requested)

    if requested_ids - existing_ids:
        raise HTTPException(
            400,
            "order contains channel ids that do not belong to this server",
        )
    if requested_ids != existing_ids:
        raise HTTPException(
            400,
            f"order must list every channel of the server exactly once "
            f"(expected {len(existing_ids)}, got {len(requested)})",
        )

    # Bulk-assign new positions densely from 0
    for new_position, channel_id in enumerate(requested):
        by_id[channel_id].position = new_position

    await db.commit()

    # Return the updated list in the new order
    updated = sorted(channels, key=lambda c: c.position)
    return updated


@router.patch("/{server_id}/channels/{channel_id}", response_model=ChannelOut)
async def rename_channel(
    server_id: str,
    channel_id: int,
    body: ChannelUpdate,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Rename a channel. Owner only.

    Updates both the Concord DB record and the underlying Matrix room name
    so federated clients see the change too.
    """
    await require_server_owner(server_id, user_id, db)

    channel = await db.get(Channel, channel_id)
    if not channel or channel.server_id != server_id:
        raise HTTPException(404, "Channel not found")

    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(400, "Channel name cannot be empty")

    channel.name = new_name

    # Update the Matrix room name too. Best-effort — if the homeserver call
    # fails we still want the DB rename to land so the UI doesn't get stuck.
    server = await db.get(Server, server_id)
    display_name = f"{server.name} - {new_name}" if server else new_name
    try:
        await set_room_name(access_token, channel.matrix_room_id, display_name)
    except Exception as e:
        logger.warning("Failed to update Matrix room name for %s: %s", channel.matrix_room_id, e)

    await db.commit()
    await db.refresh(channel)
    return channel


@router.delete("/{server_id}")
async def delete_server(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Delete a server. Owner/admin. Cascades to channels, members, invites, soundboard clips."""
    await require_server_admin(server_id, user_id, db)

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    # Delete soundboard files from disk
    clip_dir = SOUNDBOARD_DIR / server_id
    if clip_dir.exists():
        shutil.rmtree(clip_dir)

    # SQLAlchemy cascade handles channels, invites, members
    # But soundboard_clips don't have cascade on Server, so delete explicitly
    result = await db.execute(
        select(SoundboardClip).where(SoundboardClip.server_id == server_id)
    )
    for clip in result.scalars().all():
        await db.delete(clip)

    await db.delete(server)
    await db.commit()
    return {"status": "deleted"}


@router.get("/{server_id}/channels/{channel_id}/matrix-members")
async def get_channel_matrix_members(
    server_id: str,
    channel_id: int,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Diagnostic: ask the homeserver who is actually in this channel's room.

    Returns the joined-members list as seen via the requesting user's
    access token. Useful for debugging "user X claims to be a server
    member but doesn't appear in the channel" symptoms.
    """
    await require_server_member(server_id, user_id, db)
    channel = await db.get(Channel, channel_id)
    if not channel or channel.server_id != server_id:
        raise HTTPException(404, "Channel not found")

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{channel.matrix_room_id}/joined_members",
            headers={"Authorization": f"Bearer {access_token}"},
        )

    return {
        "channel_id": channel.id,
        "channel_name": channel.name,
        "matrix_room_id": channel.matrix_room_id,
        "homeserver_status": resp.status_code,
        "homeserver_body": resp.json() if resp.status_code == 200 else resp.text,
    }


@router.delete("/{server_id}/channels/{channel_id}")
async def delete_channel(
    server_id: str,
    channel_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Delete a channel from a server. Owner only."""
    await require_server_owner(server_id, user_id, db)

    channel = await db.get(Channel, channel_id)
    if not channel or channel.server_id != server_id:
        raise HTTPException(404, "Channel not found")

    await db.delete(channel)
    await db.commit()
    return {"status": "deleted"}


@router.delete("/{server_id}/members/me")
async def leave_server(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Leave a server. Owners cannot leave — they must delete the server."""
    member = await require_server_member(server_id, user_id, db)

    if member.role == "owner":
        raise HTTPException(400, "Owners cannot leave their server. Delete the server instead.")

    await db.delete(member)
    await db.commit()
    return {"status": "left"}


# --- Discovery ---

@router.get("/discover", response_model=list[ServerDiscoverOut])
async def discover_servers(
    q: str = Query(default="", max_length=200),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List public servers, optionally filtered by search query."""
    from sqlalchemy import func

    query = select(
        Server.id,
        Server.name,
        Server.icon_url,
        Server.abbreviation,
        func.count(ServerMember.id).label("member_count"),
    ).join(ServerMember, ServerMember.server_id == Server.id).where(
        Server.visibility == "public"
    ).group_by(Server.id)

    if q.strip():
        query = query.where(Server.name.ilike(f"%{q.strip()}%"))

    query = query.order_by(Server.name)
    result = await db.execute(query)
    return [
        ServerDiscoverOut(
            id=row.id,
            name=row.name,
            icon_url=row.icon_url,
            abbreviation=row.abbreviation,
            member_count=row.member_count,
        )
        for row in result.all()
    ]


@router.post("/{server_id}/join")
async def join_server(
    server_id: str,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Join a public server. Creates membership and joins all Matrix rooms."""
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    if server.visibility != "public":
        raise HTTPException(403, "This server is private. You need an invite.")

    # Check if banned
    ban = await db.execute(
        select(ServerBan).where(
            ServerBan.server_id == server_id,
            ServerBan.user_id == user_id,
        )
    )
    if ban.scalar_one_or_none():
        raise HTTPException(403, "You are banned from this server")

    # Check if already a member
    existing = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "Already a member")

    db.add(ServerMember(server_id=server_id, user_id=user_id, role="member"))

    # Join all Matrix rooms
    result = await db.execute(select(Channel).where(Channel.server_id == server_id))
    for channel in result.scalars().all():
        try:
            await join_room(access_token, channel.matrix_room_id)
        except Exception:
            pass  # Best-effort join

    await db.commit()
    return {"status": "joined"}


@router.post("/{server_id}/rejoin")
async def rejoin_server_rooms(
    server_id: str,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Re-join all Matrix rooms for a server. Fixes membership after server restarts."""
    membership = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == user_id,
        )
    )
    if not membership.scalar_one_or_none():
        raise HTTPException(403, "Not a member of this server")

    result = await db.execute(select(Channel).where(Channel.server_id == server_id))
    channels = result.scalars().all()
    joined = 0
    failures: list[str] = []
    for channel in channels:
        try:
            await join_room(access_token, channel.matrix_room_id)
            joined += 1
        except Exception as e:
            failures.append(f"{channel.name}={e}")
    logger.info(
        "rejoin_server_rooms: user=%s server=%s joined=%d/%d failures=%s",
        user_id, server_id, joined, len(channels), failures or "none",
    )
    return {"status": "ok", "rooms_joined": joined}


# --- Server Settings ---

@router.get("/{server_id}/settings")
async def get_server_settings(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get full server settings. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    return {
        "id": server.id,
        "name": server.name,
        "visibility": server.visibility,
        "abbreviation": server.abbreviation,
        "icon_url": server.icon_url,
        "owner_id": server.owner_id,
        "media_uploads_enabled": server.media_uploads_enabled,
        "rules_text": server.rules_text,
    }


@router.patch("/{server_id}/settings")
async def update_server_settings(
    server_id: str,
    body: ServerSettingsUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Update server settings. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    if body.name is not None:
        server.name = body.name
    if body.visibility is not None:
        if body.visibility not in ("public", "private"):
            raise HTTPException(400, "Visibility must be 'public' or 'private'")
        server.visibility = body.visibility
    if body.abbreviation is not None:
        server.abbreviation = body.abbreviation if body.abbreviation else None
    if body.media_uploads_enabled is not None:
        server.media_uploads_enabled = body.media_uploads_enabled
    if body.rules_text is not None:
        # Empty string clears the rules.
        server.rules_text = body.rules_text if body.rules_text.strip() else None

    await db.commit()
    return {
        "id": server.id,
        "name": server.name,
        "visibility": server.visibility,
        "abbreviation": server.abbreviation,
        "media_uploads_enabled": server.media_uploads_enabled,
        "rules_text": server.rules_text,
    }


@router.get("/{server_id}/rules")
async def get_server_rules(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Return the server's rules text. Accessible by any authenticated member."""
    await require_server_member(server_id, user_id, db)
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    return {"rules_text": server.rules_text}


# --- Members ---

@router.get("/{server_id}/members", response_model=list[MemberOut])
async def list_members(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List all members of a server with roles and display names."""
    await require_server_member(server_id, user_id, db)
    result = await db.execute(
        select(ServerMember)
        .where(ServerMember.server_id == server_id)
        .order_by(ServerMember.joined_at)
    )
    members = result.scalars().all()
    return [
        MemberOut(
            user_id=m.user_id,
            role=m.role,
            display_name=m.display_name,
            joined_at=m.joined_at.isoformat(),
            can_kick=m.can_kick,
            can_ban=m.can_ban,
        )
        for m in members
    ]


@router.patch("/{server_id}/members/{member_user_id}/role")
async def update_member_role(
    server_id: str,
    member_user_id: str,
    body: RoleUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Change a member's role. Owner only."""
    await require_server_owner(server_id, user_id, db)

    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == member_user_id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Member not found")
    if member.role == "owner":
        raise HTTPException(400, "Cannot change the owner's role")

    member.role = body.role
    await db.commit()
    return {"status": "updated", "role": member.role}


@router.patch("/{server_id}/members/{member_user_id}/display-name")
async def update_display_name(
    server_id: str,
    member_user_id: str,
    body: DisplayNameUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Set display name for a member. Users can only change their own."""
    await require_server_member(server_id, user_id, db)
    if user_id != member_user_id:
        raise HTTPException(403, "You can only change your own display name")

    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == member_user_id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Member not found")

    member.display_name = body.display_name
    await db.commit()
    return {"status": "updated", "display_name": member.display_name}


@router.delete("/{server_id}/members/{member_user_id}")
async def kick_member(
    server_id: str,
    member_user_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Kick a member from the server. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == member_user_id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(404, "Member not found")
    if member.role == "owner":
        raise HTTPException(400, "Cannot kick the owner")

    await db.delete(member)
    await db.commit()
    return {"status": "kicked"}


# --- Bans ---

@router.get("/{server_id}/bans")
async def list_bans(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List banned users. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)
    result = await db.execute(
        select(ServerBan).where(ServerBan.server_id == server_id)
    )
    return [
        {
            "id": b.id,
            "user_id": b.user_id,
            "banned_by": b.banned_by,
            "created_at": b.created_at.isoformat(),
        }
        for b in result.scalars().all()
    ]


@router.post("/{server_id}/bans")
async def ban_user(
    server_id: str,
    body: BanCreate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Ban a user from the server. Admin or owner only. Also kicks them."""
    await require_server_admin(server_id, user_id, db)

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    if body.user_id == server.owner_id:
        raise HTTPException(400, "Cannot ban the server owner")

    # Check if already banned
    existing = await db.execute(
        select(ServerBan).where(
            ServerBan.server_id == server_id,
            ServerBan.user_id == body.user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "User is already banned")

    # Ban
    db.add(ServerBan(
        server_id=server_id,
        user_id=body.user_id,
        banned_by=user_id,
    ))

    # Also kick if they're a member
    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == body.user_id,
        )
    )
    member = result.scalar_one_or_none()
    if member:
        await db.delete(member)

    await db.commit()
    return {"status": "banned"}


@router.delete("/{server_id}/bans/{ban_user_id}")
async def unban_user(
    server_id: str,
    ban_user_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Unban a user. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(ServerBan).where(
            ServerBan.server_id == server_id,
            ServerBan.user_id == ban_user_id,
        )
    )
    ban = result.scalar_one_or_none()
    if not ban:
        raise HTTPException(404, "Ban not found")

    await db.delete(ban)
    await db.commit()
    return {"status": "unbanned"}


# --- Whitelist ---

@router.get("/{server_id}/whitelist")
async def list_whitelist(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List whitelisted users. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)
    result = await db.execute(
        select(ServerWhitelist).where(ServerWhitelist.server_id == server_id)
    )
    return [
        {
            "id": w.id,
            "user_id": w.user_id,
            "added_by": w.added_by,
            "created_at": w.created_at.isoformat(),
        }
        for w in result.scalars().all()
    ]


@router.post("/{server_id}/whitelist")
async def add_to_whitelist(
    server_id: str,
    body: WhitelistAdd,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Add a user to the whitelist. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)

    existing = await db.execute(
        select(ServerWhitelist).where(
            ServerWhitelist.server_id == server_id,
            ServerWhitelist.user_id == body.user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, "User is already whitelisted")

    db.add(ServerWhitelist(
        server_id=server_id,
        user_id=body.user_id,
        added_by=user_id,
    ))
    await db.commit()
    return {"status": "added"}


@router.delete("/{server_id}/whitelist/{wl_user_id}")
async def remove_from_whitelist(
    server_id: str,
    wl_user_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Remove a user from the whitelist. Admin or owner only."""
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(ServerWhitelist).where(
            ServerWhitelist.server_id == server_id,
            ServerWhitelist.user_id == wl_user_id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(404, "Whitelist entry not found")

    await db.delete(entry)
    await db.commit()
    return {"status": "removed"}


# ---------------------------------------------------------------------------
# Place ownership re-minting (TASK 28)
# ---------------------------------------------------------------------------
#
# "Re-minting" is the Concord term for transferring ownership of a place
# to a new owner. Instead of mutating the existing place record, we
# create a NEW place that links back to the previous one via
# ``previous_place_id`` and snapshot the previous ledger (channels +
# member roster + media filenames) into a ``PlaceLedgerHeader``.
#
# Two modes:
# - encrypted=True: the snapshot is base64'd and (in the long term)
#   sealed under a key only the new owner can decrypt. Today this is a
#   placeholder — see TODO below.
# - encrypted=False: plaintext base64. Suitable for "flexible,
#   committee-changeable" ownership where transparency matters more
#   than confidentiality.
#
# The actual media files are not in the snapshot — only filenames. The
# files live on disk under SOUNDBOARD_DIR and are kept around because
# the new place inherits the same Server.id pattern.

class RemintRequest(BaseModel):
    new_owner_user_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=_MATRIX_USER_ID_PATTERN,
        description="The Matrix user ID who will own the new place.",
    )
    encrypted: bool = Field(
        default=False,
        description=(
            "If True, snapshot the ledger encrypted (placeholder — base64 "
            "today, real encryption in a follow-up pillar). If False, "
            "transfer ownership in plaintext."
        ),
    )


class RemintResponse(BaseModel):
    new_place_id: str
    previous_place_id: str
    new_owner_id: str
    encrypted: bool
    media_filenames_preserved: int
    channel_id_mapping: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Mapping of old channel id -> new channel id, so the client "
            "can rewire cached references after a re-mint. Keys and "
            "values are stringified integer channel IDs."
        ),
    )
    member_count_preserved: int = Field(
        default=0,
        description=(
            "Number of ServerMember rows (including the new owner) "
            "inserted on the new place. The prior owner is demoted "
            "to 'admin'; the new owner becomes 'owner'."
        ),
    )


@router.post("/{server_id}/remint-ownership", response_model=RemintResponse)
async def remint_ownership(
    server_id: str,
    body: RemintRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Re-mint a place into a new owner.

    Creates a new Server record owned by ``new_owner_user_id`` and
    snapshots the ledger of the old place into a PlaceLedgerHeader
    linked from the new record. The old place is preserved (not
    deleted) so the audit chain stays intact and federated peers can
    still resolve the previous_place_id.

    Re-mint preserves the prior member roster. Prior members keep
    their roles with one exception: the prior owner is demoted to
    ``admin`` on the new place. The new owner is the caller of this
    endpoint and is the sole ``owner`` on the new place.

    Channels are rehydrated onto the new place with fresh
    ``matrix_room_id`` values — the old Matrix rooms belong to the
    old place and the new owner has no permission to send into them.
    The response includes a ``channel_id_mapping`` so the client can
    rewire any cached references from old channel IDs to new ones.

    Encryption: ``encrypted=True`` is not yet implemented and will
    return ``501 ENCRYPTION_NOT_AVAILABLE`` rather than silently
    writing a plaintext payload tagged as encrypted. Pass
    ``encrypted=False`` for an unencrypted ownership transfer.
    """
    import base64
    import json
    import secrets
    from models import PlaceLedgerHeader, SoundboardClip

    server = await db.get(Server, server_id)
    if not server:
        raise ConcordError(
            error_code="RESOURCE_NOT_FOUND",
            message="Place not found",
            status_code=404,
        )

    # Auth: only the current owner can re-mint.
    if server.owner_id != user_id:
        raise ConcordError(
            error_code="OWNER_REQUIRED",
            message="Only the current place owner can re-mint ownership.",
            status_code=403,
        )

    if body.new_owner_user_id == server.owner_id:
        raise ConcordError(
            error_code="OWNERSHIP_TRANSFER_FAILED",
            message="New owner must differ from current owner.",
            status_code=400,
        )

    # C-1: encrypted re-mint is not implemented. Reject loudly rather
    # than silently writing plaintext into a row tagged ``encrypted=True``.
    # Keeps the API contract honest and leaves room for a real encryption
    # backend to slot in later without a schema lie in the interim.
    if body.encrypted:
        raise ConcordError(
            "ENCRYPTION_NOT_AVAILABLE",
            "Encrypted re-mint is not yet implemented. Pass encrypted=false for an unencrypted ownership transfer.",
            status_code=501,
        )

    # Snapshot the ledger of the old place. Per the design, only
    # filenames + channel roster + member roster are preserved — the
    # actual media files stay on disk under their Server.id directory.
    channels_result = await db.execute(
        select(Channel).where(Channel.server_id == server_id)
    )
    old_channels = list(channels_result.scalars().all())

    members_result = await db.execute(
        select(ServerMember).where(ServerMember.server_id == server_id)
    )
    old_members = list(members_result.scalars().all())

    clips_result = await db.execute(
        select(SoundboardClip).where(SoundboardClip.server_id == server_id)
    )
    old_clips = list(clips_result.scalars().all())

    media_filenames = [c.filename for c in old_clips]

    snapshot = {
        "previous_place_id": server.id,
        "previous_owner_id": server.owner_id,
        "channels": [
            {
                "id": c.id,
                "name": c.name,
                "channel_type": c.channel_type,
                "matrix_room_id": c.matrix_room_id,
                "position": c.position,
            }
            for c in old_channels
        ],
        "members": [
            {
                "user_id": m.user_id,
                "role": m.role,
                "display_name": m.display_name,
                "can_kick": m.can_kick,
                "can_ban": m.can_ban,
            }
            for m in old_members
        ],
        "media_filenames": media_filenames,
    }

    snapshot_json = json.dumps(snapshot, sort_keys=True).encode("utf-8")
    # Plaintext path only — encrypted path is rejected above until an
    # encryption backend lands. The base64 wrapping keeps the column
    # shape stable so a future encrypted payload is a drop-in.
    payload = base64.b64encode(snapshot_json).decode("ascii")

    # Create the new place record. Carry over the human-facing fields
    # so the new owner doesn't have to re-name everything.
    new_server = Server(
        name=server.name,
        icon_url=server.icon_url,
        owner_id=body.new_owner_user_id,
        visibility=server.visibility,
        abbreviation=server.abbreviation,
        kick_limit=server.kick_limit,
        kick_window_minutes=server.kick_window_minutes,
        ban_mode=server.ban_mode,
        media_uploads_enabled=server.media_uploads_enabled,
        previous_place_id=server.id,
    )
    db.add(new_server)
    await db.flush()  # populate new_server.id

    # H-1: Rehydrate channels onto the new place. If the old place had
    # channels but the snapshot doesn't carry them, something is wrong
    # with the snapshot format — fail loudly rather than produce a
    # silently-broken shell place.
    channel_id_mapping: dict[str, str] = {}
    snapshot_channels = snapshot.get("channels")
    if old_channels and not snapshot_channels:
        raise ConcordError(
            "REMINT_SNAPSHOT_INCOMPLETE",
            "Re-mint snapshot is missing channel data required to reconstruct the place.",
            status_code=500,
        )

    for ch_entry in snapshot_channels or []:
        # Generate a fresh Matrix room ID. We cannot reuse the old
        # room because (a) the Channel.matrix_room_id column has a
        # UNIQUE constraint, and (b) the new owner has no permission
        # to post into the prior owner's Matrix rooms. A real Matrix
        # room should be minted via services.matrix_admin.create_matrix_room
        # in a follow-up — for now use a placeholder with a clearly
        # unique suffix so the row is distinguishable and the UNIQUE
        # constraint is satisfied. This leaves a TODO for the Matrix
        # room-creation integration.
        # TODO(remint-matrix-rooms): call create_matrix_room() here
        # once the re-mint flow is wired to the caller's access token.
        fresh_room_id = (
            f"!remint-{new_server.id}-{secrets.token_hex(6)}:placeholder.local"
        )
        old_id = ch_entry.get("id")
        new_channel = Channel(
            server_id=new_server.id,
            matrix_room_id=fresh_room_id,
            name=ch_entry["name"],
            channel_type=ch_entry.get("channel_type", "text"),
            position=ch_entry.get("position", 0),
        )
        db.add(new_channel)
        await db.flush()  # populate new_channel.id
        if old_id is not None:
            channel_id_mapping[str(old_id)] = str(new_channel.id)

    # H-2: Rehydrate the member roster. Same "loud fail" rule: if
    # the old place had members but the snapshot is missing the
    # array, refuse to produce a half-populated place.
    snapshot_members = snapshot.get("members")
    if old_members and not snapshot_members:
        raise ConcordError(
            "REMINT_SNAPSHOT_INCOMPLETE",
            "Re-mint snapshot is missing member roster required to reconstruct the place.",
            status_code=500,
        )

    # The new owner (the caller of this endpoint) is the sole owner
    # on the new place. Add them first so we can dedupe against them
    # when iterating the prior roster.
    db.add(ServerMember(
        server_id=new_server.id,
        user_id=body.new_owner_user_id,
        role="owner",
    ))
    seen_user_ids = {body.new_owner_user_id}

    for m_entry in snapshot_members or []:
        prior_user_id = m_entry["user_id"]
        if prior_user_id in seen_user_ids:
            # Don't insert a duplicate row for the new owner if they
            # happened to already be in the prior roster.
            continue
        prior_role = m_entry.get("role") or "member"
        # The prior owner is demoted to admin — the whole point of a
        # re-mint is that ownership transfers. Any other prior role
        # is carried over verbatim.
        if prior_role == "owner":
            new_role = "admin"
        else:
            new_role = prior_role
        db.add(ServerMember(
            server_id=new_server.id,
            user_id=prior_user_id,
            role=new_role,
            can_kick=bool(m_entry.get("can_kick", False)),
            can_ban=bool(m_entry.get("can_ban", False)),
            display_name=m_entry.get("display_name"),
        ))
        seen_user_ids.add(prior_user_id)

    # Persist the snapshot header
    header = PlaceLedgerHeader(
        new_place_id=new_server.id,
        previous_place_id=server.id,
        encrypted=body.encrypted,
        payload=payload,
    )
    db.add(header)

    await db.commit()
    await db.refresh(new_server)

    logger.info(
        "Place re-minted: %s -> %s (new_owner=%s, encrypted=%s, media=%d, channels=%d, members=%d)",
        server.id, new_server.id, body.new_owner_user_id,
        body.encrypted, len(media_filenames),
        len(channel_id_mapping), len(seen_user_ids),
    )

    return RemintResponse(
        new_place_id=new_server.id,
        previous_place_id=server.id,
        new_owner_id=body.new_owner_user_id,
        encrypted=body.encrypted,
        media_filenames_preserved=len(media_filenames),
        channel_id_mapping=channel_id_mapping,
        member_count_preserved=len(seen_user_ids),
    )
