import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from errors import ConcordError
from models import DMConversation
from routers.servers import get_user_id, get_access_token
from services.matrix_admin import create_dm_room

logger = logging.getLogger(__name__)

router = APIRouter(tags=["dms"])


# A Matrix user ID looks like "@localpart:server.tld". The total length
# is bounded by the Matrix spec at 255 characters and must start with
# `@`. Tighter input validation here prevents an attacker from spamming
# the DM creation endpoint with megabyte-sized payloads.
_MATRIX_USER_ID_PATTERN = r"^@[a-zA-Z0-9._=\-/+]+:[a-zA-Z0-9.\-]+$"


class DMCreate(BaseModel):
    target_user_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=_MATRIX_USER_ID_PATTERN,
        description="The Matrix user ID of the DM target (e.g. @bob:example.com).",
    )


@router.post("/api/dms")
async def create_or_get_dm(
    body: DMCreate,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
    db: AsyncSession = Depends(get_db),
):
    """Create a DM conversation or return the existing one (idempotent)."""
    if body.target_user_id == user_id:
        raise ConcordError(
            error_code="INPUT_INVALID",
            message="Cannot start a DM with yourself",
            status_code=400,
        )

    # Normalize the pair so user_a < user_b lexicographically
    user_a, user_b = sorted([user_id, body.target_user_id])

    # Check for existing conversation
    result = await db.execute(
        select(DMConversation).where(
            DMConversation.user_a == user_a,
            DMConversation.user_b == user_b,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        return {
            "id": existing.id,
            "target_user_id": body.target_user_id,
            "matrix_room_id": existing.matrix_room_id,
            "created": False,
        }

    # Create a new DM Matrix room
    room_id = await create_dm_room(access_token, body.target_user_id)

    dm = DMConversation(
        user_a=user_a,
        user_b=user_b,
        matrix_room_id=room_id,
    )
    db.add(dm)
    await db.commit()
    await db.refresh(dm)

    logger.info("DM created: %s <-> %s (room %s)", user_id, body.target_user_id, room_id)

    return {
        "id": dm.id,
        "target_user_id": body.target_user_id,
        "matrix_room_id": room_id,
        "created": True,
    }


@router.get("/api/dms")
async def list_dms(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List all DM conversations for the current user."""
    result = await db.execute(
        select(DMConversation)
        .where(or_(
            DMConversation.user_a == user_id,
            DMConversation.user_b == user_id,
        ))
        .order_by(DMConversation.created_at.desc())
    )
    conversations = result.scalars().all()

    return [
        {
            "id": dm.id,
            "other_user_id": dm.user_b if dm.user_a == user_id else dm.user_a,
            "matrix_room_id": dm.matrix_room_id,
            "created_at": dm.created_at.isoformat() if dm.created_at else None,
        }
        for dm in conversations
    ]
