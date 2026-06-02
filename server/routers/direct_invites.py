import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import get_db
from dependencies import require_server_admin
from models import DirectInvite, ServerMember, Channel, ServerBan
from dependencies import get_user_id, get_access_token
from services.matrix_admin import join_room

logger = logging.getLogger(__name__)

router = APIRouter(tags=["direct_invites"])


# --- User search ---


@router.get("/api/users/search")
async def search_users(
    q: str = Query(default="", max_length=200),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Search for users across servers the requester belongs to (max 50 results)."""
    # Get all server IDs the requester is a member of
    requester_servers = (
        await db.execute(
            select(ServerMember.server_id).where(ServerMember.user_id == user_id)
        )
    ).scalars().all()

    if not requester_servers:
        return []

    # Get all unique users in those servers, excluding self and bot
    stmt = (
        select(
            ServerMember.user_id,
            func.max(ServerMember.display_name).label("display_name"),
        )
        .where(
            ServerMember.server_id.in_(requester_servers),
            ServerMember.user_id != user_id,
            ~ServerMember.user_id.startswith("@concord-bot:"),
        )
        .group_by(ServerMember.user_id)
    )

    if q:
        stmt = stmt.having(
            or_(
                ServerMember.user_id.ilike(f"%{q}%"),
                func.max(ServerMember.display_name).ilike(f"%{q}%"),
            )
        )

    stmt = stmt.limit(50)
    result = await db.execute(stmt)
    return [
        {"user_id": row.user_id, "display_name": row.display_name}
        for row in result.all()
    ]


# --- Direct invites ---


class DirectInviteCreate(BaseModel):
    server_id: str
    invitee_id: str


class DirectInviteRespond(BaseModel):
    action: Literal["accept", "decline"]


@router.post("/api/direct-invites")
async def send_direct_invite(
    body: DirectInviteCreate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Send a direct server invite to a user. Requires admin/owner role."""
    await require_server_admin(body.server_id, user_id, db)

    # Check invitee is not already a member
    existing_member = (
        await db.execute(
            select(ServerMember).where(
                ServerMember.server_id == body.server_id,
                ServerMember.user_id == body.invitee_id,
            )
        )
    ).scalar_one_or_none()
    if existing_member:
        raise HTTPException(400, "User is already a member of this server")

    # Check invitee is not banned
    ban = (
        await db.execute(
            select(ServerBan).where(
                ServerBan.server_id == body.server_id,
                ServerBan.user_id == body.invitee_id,
            )
        )
    ).scalar_one_or_none()
    if ban:
        raise HTTPException(400, "User is banned from this server")

    # Check no pending invite already exists
    existing_invite = (
        await db.execute(
            select(DirectInvite).where(
                DirectInvite.server_id == body.server_id,
                DirectInvite.invitee_id == body.invitee_id,
                DirectInvite.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if existing_invite:
        raise HTTPException(400, "Invite already pending for this user")

    invite = DirectInvite(
        server_id=body.server_id,
        inviter_id=user_id,
        invitee_id=body.invitee_id,
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)

    logger.info(
        "Direct invite sent: %s invited %s to server %s",
        user_id, body.invitee_id, body.server_id,
    )

    return {"status": "sent", "id": invite.id}


@router.get("/api/direct-invites/pending")
async def get_pending_invites(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get all pending direct invites for the current user."""
    result = await db.execute(
        select(DirectInvite)
        .options(selectinload(DirectInvite.server))
        .where(
            DirectInvite.invitee_id == user_id,
            DirectInvite.status == "pending",
        )
        .order_by(DirectInvite.created_at.desc())
    )
    invites = result.scalars().all()

    return [
        {
            "id": inv.id,
            "server_id": inv.server_id,
            "server_name": inv.server.name,
            "inviter_id": inv.inviter_id,
            "created_at": inv.created_at.isoformat() if inv.created_at else None,
        }
        for inv in invites
    ]


@router.post("/api/direct-invites/{invite_id}/respond")
async def respond_to_invite(
    invite_id: int,
    body: DirectInviteRespond,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Accept or decline a direct invite."""
    result = await db.execute(
        select(DirectInvite)
        .options(selectinload(DirectInvite.server))
        .where(DirectInvite.id == invite_id)
    )
    invite = result.scalar_one_or_none()

    if not invite:
        raise HTTPException(404, "Invite not found")
    if invite.invitee_id != user_id:
        raise HTTPException(403, "This invite is not for you")
    if invite.status != "pending":
        raise HTTPException(400, f"Invite already {invite.status}")

    if body.action == "decline":
        invite.status = "declined"
        await db.commit()
        return {"status": "declined"}

    # Accept: add as member and join Matrix rooms
    invite.status = "accepted"

    db.add(ServerMember(
        server_id=invite.server_id,
        user_id=user_id,
        role="member",
    ))

    # Join all channels in the server
    channels = (
        await db.execute(
            select(Channel).where(Channel.server_id == invite.server_id)
        )
    ).scalars().all()

    for channel in channels:
        try:
            await join_room(access_token, channel.matrix_room_id)
        except Exception as e:
            logger.warning(
                "Failed to auto-join %s to room %s: %s",
                user_id, channel.matrix_room_id, e,
            )

    await db.commit()

    return {
        "status": "accepted",
        "server_id": invite.server_id,
        "server_name": invite.server.name,
    }
