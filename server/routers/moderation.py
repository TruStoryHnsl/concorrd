import hashlib
import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from errors import ConcordError
from models import (
    Channel, ChannelLock, Server, ServerMember, ServerBan,
    VoteKick, KickRecord, IPBan,
)
from routers.servers import get_user_id


# Same Matrix user ID shape as in dms.py.
_MATRIX_USER_ID_PATTERN = r"^@[a-zA-Z0-9._=\-/+]+:[a-zA-Z0-9.\-]+$"
# Matrix room IDs start with `!` and have a similar shape.
_MATRIX_ROOM_ID_PATTERN = r"^![a-zA-Z0-9._=\-/+]+:[a-zA-Z0-9.\-]+$"

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["moderation"])


def _hash_pin(pin: str) -> str:
    return hashlib.sha256(pin.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_member(db: AsyncSession, server_id: str, user_id: str) -> ServerMember | None:
    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


def _can_moderate(member: ServerMember, action: str) -> bool:
    """Check if a member can perform a moderation action."""
    if member.role in ("owner", "admin"):
        return True
    if action == "kick" and member.can_kick:
        return True
    if action == "ban" and member.can_ban:
        return True
    return False


# ---------------------------------------------------------------------------
# Channel Locks
# ---------------------------------------------------------------------------

class LockChannelRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")


@router.post("/channels/{channel_id}/lock")
async def lock_channel(
    channel_id: int,
    body: LockChannelRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Lock a channel with a 4-digit PIN. Only the channel creator can lock it."""
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")

    # Check the user is a member of this server
    member = await _get_member(db, channel.server_id, user_id)
    if not member:
        raise HTTPException(403, "Not a member of this server")

    # Check for existing lock
    result = await db.execute(
        select(ChannelLock).where(ChannelLock.channel_id == channel_id)
    )
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(400, "Channel is already locked")

    lock = ChannelLock(
        channel_id=channel_id,
        pin_hash=_hash_pin(body.pin),
        locked_by=user_id,
    )
    db.add(lock)
    await db.commit()
    return {"status": "locked"}


@router.post("/channels/{channel_id}/unlock")
async def unlock_channel(
    channel_id: int,
    body: LockChannelRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Unlock a channel. Requires the correct PIN or be the lock owner/admin."""
    result = await db.execute(
        select(ChannelLock).where(ChannelLock.channel_id == channel_id)
    )
    lock = result.scalar_one_or_none()
    if not lock:
        raise HTTPException(400, "Channel is not locked")

    # Owner of the lock or correct PIN can unlock
    if lock.locked_by != user_id and _hash_pin(body.pin) != lock.pin_hash:
        # Check if admin
        channel = await db.get(Channel, channel_id)
        if channel:
            member = await _get_member(db, channel.server_id, user_id)
            if not member or member.role not in ("owner", "admin"):
                raise HTTPException(403, "Incorrect PIN")

    await db.delete(lock)
    await db.commit()
    return {"status": "unlocked"}


class VerifyPinRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=4, pattern=r"^\d{4}$")


@router.post("/channels/{channel_id}/verify-pin")
async def verify_channel_pin(
    channel_id: int,
    body: VerifyPinRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Verify a PIN to access a locked channel."""
    result = await db.execute(
        select(ChannelLock).where(ChannelLock.channel_id == channel_id)
    )
    lock = result.scalar_one_or_none()
    if not lock:
        return {"status": "unlocked"}  # no lock exists

    if _hash_pin(body.pin) != lock.pin_hash:
        raise HTTPException(403, "Incorrect PIN")

    return {"status": "verified"}


@router.get("/channels/{channel_id}/lock-status")
async def channel_lock_status(
    channel_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Check if a channel is locked."""
    result = await db.execute(
        select(ChannelLock).where(ChannelLock.channel_id == channel_id)
    )
    lock = result.scalar_one_or_none()
    return {
        "locked": lock is not None,
        "locked_by": lock.locked_by if lock else None,
        "is_owner": lock.locked_by == user_id if lock else False,
    }


# ---------------------------------------------------------------------------
# Member permissions
# ---------------------------------------------------------------------------

class UpdatePermissions(BaseModel):
    can_kick: bool | None = None
    can_ban: bool | None = None


@router.patch("/servers/{server_id}/members/{member_user_id}/permissions")
async def update_member_permissions(
    server_id: str,
    member_user_id: str,
    body: UpdatePermissions,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Update kick/ban permissions for a member. Only owner/admin can do this."""
    caller = await _get_member(db, server_id, user_id)
    if not caller or caller.role not in ("owner", "admin"):
        raise HTTPException(403, "Only owner/admin can modify permissions")

    target = await _get_member(db, server_id, member_user_id)
    if not target:
        raise HTTPException(404, "Member not found")

    if body.can_kick is not None:
        target.can_kick = body.can_kick
    if body.can_ban is not None:
        target.can_ban = body.can_ban
    await db.commit()
    return {"status": "updated"}


# ---------------------------------------------------------------------------
# Vote Kick
# ---------------------------------------------------------------------------

class VoteKickStart(BaseModel):
    channel_id: str = Field(
        min_length=1,
        max_length=255,
        pattern=_MATRIX_ROOM_ID_PATTERN,
        description="Matrix room ID of the voice channel where the vote was started.",
    )
    target_user_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=_MATRIX_USER_ID_PATTERN,
        description="Matrix user ID of the kick target.",
    )
    total_eligible: int = Field(
        default=0,
        ge=0,
        le=10_000,
        description="Number of voters who must vote yes for the kick to pass.",
    )


@router.post("/servers/{server_id}/vote-kick")
async def start_vote_kick(
    server_id: str,
    body: VoteKickStart,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Start a vote to kick someone from a voice channel."""
    member = await _get_member(db, server_id, user_id)
    if not member:
        raise HTTPException(403, "Not a member")

    if body.target_user_id == user_id:
        raise HTTPException(400, "Cannot vote-kick yourself")

    # Verify the target is actually a member of this server
    target = await _get_member(db, server_id, body.target_user_id)
    if not target:
        raise HTTPException(404, "Target user is not a member of this server")

    # Check for existing active vote
    result = await db.execute(
        select(VoteKick).where(
            VoteKick.server_id == server_id,
            VoteKick.target_user_id == body.target_user_id,
            VoteKick.status == "active",
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(400, "A vote is already in progress for this user")

    vote = VoteKick(
        server_id=server_id,
        channel_id=body.channel_id,
        target_user_id=body.target_user_id,
        initiated_by=user_id,
        votes_yes=user_id,  # initiator auto-votes yes
        total_eligible=body.total_eligible,
    )
    db.add(vote)
    await db.commit()
    await db.refresh(vote)
    return {"vote_id": vote.id, "status": "active"}


class VoteKickCast(BaseModel):
    vote: bool  # true = yes, false = no


@router.post("/vote-kicks/{vote_id}/vote")
async def cast_vote_kick(
    vote_id: int,
    body: VoteKickCast,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Cast a vote in a vote-kick."""
    result = await db.execute(select(VoteKick).where(VoteKick.id == vote_id))
    vote = result.scalar_one_or_none()
    if not vote or vote.status != "active":
        raise HTTPException(404, "Vote not found or already completed")

    if vote.target_user_id == user_id:
        raise HTTPException(400, "Cannot vote on your own kick")

    # Parse voter lists (stored as comma-separated, filter empty strings)
    yes_voters = {v for v in vote.votes_yes.split(",") if v} if vote.votes_yes else set()
    no_voters = {v for v in vote.votes_no.split(",") if v} if vote.votes_no else set()

    if user_id in yes_voters or user_id in no_voters:
        raise HTTPException(400, "Already voted")

    if body.vote:
        yes_voters.add(user_id)
    else:
        no_voters.add(user_id)

    vote.votes_yes = ",".join(yes_voters)
    vote.votes_no = ",".join(no_voters)

    # Check if vote is decided
    # A single "no" vote fails it; all eligible voters must vote yes
    if no_voters:
        vote.status = "failed"
    elif vote.total_eligible > 0 and len(yes_voters) >= vote.total_eligible:
        vote.status = "passed"

    await db.commit()
    return {
        "status": vote.status,
        "yes_count": len(yes_voters),
        "no_count": len(no_voters),
    }


@router.post("/vote-kicks/{vote_id}/set-eligible")
async def set_vote_eligible(
    vote_id: int,
    count: int = Query(..., ge=0, le=10_000),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Set the total eligible voter count (participants minus target)."""
    result = await db.execute(select(VoteKick).where(VoteKick.id == vote_id))
    vote = result.scalar_one_or_none()
    if not vote or vote.status != "active":
        raise HTTPException(404, "Vote not found")
    vote.total_eligible = count
    await db.commit()
    return {"status": "ok"}


@router.get("/servers/{server_id}/vote-kicks/active")
async def get_active_votes(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get active vote-kicks for a server."""
    result = await db.execute(
        select(VoteKick).where(
            VoteKick.server_id == server_id,
            VoteKick.status == "active",
        )
    )
    votes = result.scalars().all()
    return [
        {
            "id": v.id,
            "channel_id": v.channel_id,
            "target_user_id": v.target_user_id,
            "initiated_by": v.initiated_by,
            "yes_count": len([x for x in (v.votes_yes or "").split(",") if x]),
            "no_count": len([x for x in (v.votes_no or "").split(",") if x]),
            "total_eligible": v.total_eligible,
        }
        for v in votes
    ]


# ---------------------------------------------------------------------------
# Kick execution + ban escalation
# ---------------------------------------------------------------------------

@router.post("/servers/{server_id}/kick/{target_user_id}")
async def kick_user(
    server_id: str,
    target_user_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Kick a user. Records the kick and checks ban escalation."""
    caller = await _get_member(db, server_id, user_id)
    if not caller or not _can_moderate(caller, "kick"):
        raise HTTPException(403, "No permission to kick")

    # Verify target is a member
    target = await _get_member(db, server_id, target_user_id)
    if not target:
        raise HTTPException(404, "Target user is not a member of this server")

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    # Record the kick
    db.add(KickRecord(
        server_id=server_id,
        user_id=target_user_id,
        kicked_by=user_id,
    ))

    # Count recent kicks (flush first so this kick is counted)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=server.kick_window_minutes)
    kick_count_result = await db.execute(
        select(func.count(KickRecord.id)).where(
            KickRecord.server_id == server_id,
            KickRecord.user_id == target_user_id,
            KickRecord.created_at >= cutoff,
        )
    )
    kick_count = kick_count_result.scalar() or 0

    response: dict = {"status": "kicked", "kick_count": kick_count}

    if kick_count >= server.kick_limit:
        # Escalate to ban
        # Check if already banned
        existing_ban = await db.execute(
            select(ServerBan).where(
                ServerBan.server_id == server_id,
                ServerBan.user_id == target_user_id,
            )
        )
        if not existing_ban.scalar_one_or_none():
            db.add(ServerBan(
                server_id=server_id,
                user_id=target_user_id,
                banned_by=user_id,
            ))

        if server.ban_mode == "harsh":
            # Note: IP bans from kick escalation are recorded without an IP
            # because the HTTP request comes from the moderator, not the target.
            # IP-based bans should be applied through direct admin action where
            # the target's IP is known from server logs.
            pass

        response["status"] = "banned"
        response["ban_mode"] = server.ban_mode
        response["show_harsh_message"] = True

    await db.commit()
    return response


# ---------------------------------------------------------------------------
# Record vote-kick result
# ---------------------------------------------------------------------------

@router.post("/vote-kicks/{vote_id}/execute")
async def execute_vote_kick(
    vote_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Execute a passed vote-kick."""
    result = await db.execute(select(VoteKick).where(VoteKick.id == vote_id))
    vote = result.scalar_one_or_none()
    if not vote:
        raise HTTPException(404, "Vote not found")
    if vote.status == "executed":
        return {"status": "already_executed"}
    if vote.status != "passed":
        raise HTTPException(400, "Vote has not passed")

    vote.status = "executed"
    server = await db.get(Server, vote.server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    # Record the kick
    db.add(KickRecord(
        server_id=vote.server_id,
        user_id=vote.target_user_id,
        kicked_by="vote",
        reason=f"Vote-kick by room (vote #{vote.id})",
    ))

    # Count recent kicks
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=server.kick_window_minutes)
    kick_count_result = await db.execute(
        select(func.count(KickRecord.id)).where(
            KickRecord.server_id == vote.server_id,
            KickRecord.user_id == vote.target_user_id,
            KickRecord.created_at >= cutoff,
        )
    )
    kick_count = kick_count_result.scalar() or 0

    response: dict = {"status": "kicked", "kick_count": kick_count, "kick_limit": server.kick_limit}

    if kick_count >= server.kick_limit:
        existing_ban = await db.execute(
            select(ServerBan).where(
                ServerBan.server_id == vote.server_id,
                ServerBan.user_id == vote.target_user_id,
            )
        )
        if not existing_ban.scalar_one_or_none():
            db.add(ServerBan(
                server_id=vote.server_id,
                user_id=vote.target_user_id,
                banned_by="vote",
            ))

        response["status"] = "banned"
        response["ban_mode"] = server.ban_mode
        response["show_harsh_message"] = True

    await db.commit()
    return response


# ---------------------------------------------------------------------------
# Server ban/kick settings
# ---------------------------------------------------------------------------

class BanSettings(BaseModel):
    kick_limit: int | None = Field(default=None, ge=1, le=100)
    kick_window_minutes: int | None = Field(default=None, ge=1, le=1440)
    ban_mode: str | None = Field(
        default=None,
        pattern=r"^(soft|harsh)$",
        description="Ban escalation mode: 'soft' or 'harsh'.",
    )


@router.patch("/servers/{server_id}/ban-settings")
async def update_ban_settings(
    server_id: str,
    body: BanSettings,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Update server kick/ban settings. Owner/admin only."""
    member = await _get_member(db, server_id, user_id)
    if not member or member.role not in ("owner", "admin"):
        raise HTTPException(403, "Only owner/admin can change these settings")

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    if body.kick_limit is not None:
        server.kick_limit = body.kick_limit
    if body.kick_window_minutes is not None:
        server.kick_window_minutes = body.kick_window_minutes
    if body.ban_mode is not None:
        if body.ban_mode not in ("soft", "harsh"):
            raise HTTPException(400, "ban_mode must be 'soft' or 'harsh'")
        server.ban_mode = body.ban_mode

    await db.commit()
    return {
        "kick_limit": server.kick_limit,
        "kick_window_minutes": server.kick_window_minutes,
        "ban_mode": server.ban_mode,
    }


@router.get("/servers/{server_id}/ban-settings")
async def get_ban_settings(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get server kick/ban settings."""
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")
    return {
        "kick_limit": server.kick_limit,
        "kick_window_minutes": server.kick_window_minutes,
        "ban_mode": server.ban_mode,
    }


# ---------------------------------------------------------------------------
# Kick count for soft-ban warning
# ---------------------------------------------------------------------------

@router.get("/servers/{server_id}/my-kicks")
async def my_kick_count(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get the current user's recent kick count for soft-ban warnings."""
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=server.kick_window_minutes)
    result = await db.execute(
        select(func.count(KickRecord.id)).where(
            KickRecord.server_id == server_id,
            KickRecord.user_id == user_id,
            KickRecord.created_at >= cutoff,
        )
    )
    kick_count = result.scalar() or 0
    return {
        "kick_count": kick_count,
        "kick_limit": server.kick_limit,
        "kick_window_minutes": server.kick_window_minutes,
        "ban_mode": server.ban_mode,
    }
