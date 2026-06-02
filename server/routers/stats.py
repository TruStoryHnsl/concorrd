import logging
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, update, text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import VoiceSession, MessageCount
from dependencies import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stats", tags=["stats"])


# --- Voice session tracking ---


class VoiceStartRequest(BaseModel):
    channel_id: str
    server_id: str


class VoiceStartResponse(BaseModel):
    session_id: int


@router.post("/voice/start", response_model=VoiceStartResponse)
async def voice_start(
    body: VoiceStartRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    # Close any stale open sessions for this user first
    now = datetime.now(timezone.utc)
    stale = await db.execute(
        select(VoiceSession).where(
            VoiceSession.user_id == user_id,
            VoiceSession.ended_at.is_(None),
        )
    )
    for session in stale.scalars().all():
        session.ended_at = now
        started = session.started_at.replace(tzinfo=timezone.utc) if session.started_at.tzinfo is None else session.started_at
        elapsed = (now - started).total_seconds()
        session.duration_seconds = int(elapsed)

    session = VoiceSession(
        user_id=user_id,
        channel_id=body.channel_id,
        server_id=body.server_id,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return {"session_id": session.id}


class VoiceEndRequest(BaseModel):
    session_id: int


@router.post("/voice/end")
async def voice_end(
    body: VoiceEndRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(VoiceSession).where(
            VoiceSession.id == body.session_id,
            VoiceSession.user_id == user_id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Session not found")

    if session.ended_at is not None:
        return {"status": "already_ended"}

    now = datetime.now(timezone.utc)
    started = session.started_at.replace(tzinfo=timezone.utc) if session.started_at.tzinfo is None else session.started_at
    session.ended_at = now
    session.duration_seconds = int((now - started).total_seconds())
    await db.commit()
    return {"status": "ok", "duration_seconds": session.duration_seconds}


# --- Message counting ---


class MessageIncrementRequest(BaseModel):
    channel_id: str
    server_id: str


@router.post("/messages/increment")
async def message_increment(
    body: MessageIncrementRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Try update first (most common path)
    result = await db.execute(
        update(MessageCount)
        .where(
            MessageCount.user_id == user_id,
            MessageCount.channel_id == body.channel_id,
            MessageCount.day == today,
        )
        .values(count=MessageCount.count + 1)
    )

    if result.rowcount == 0:
        # First message today for this user+channel — insert
        mc = MessageCount(
            user_id=user_id,
            channel_id=body.channel_id,
            server_id=body.server_id,
            day=today,
            count=1,
        )
        db.add(mc)

    await db.commit()
    return {"status": "ok"}


# --- Stats retrieval ---


@router.get("/me")
async def my_stats(
    days: int = Query(default=30, ge=1, le=365),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")

    # Voice: total time and daily breakdown
    voice_result = await db.execute(
        select(VoiceSession).where(
            VoiceSession.user_id == user_id,
            VoiceSession.duration_seconds.isnot(None),
            VoiceSession.started_at >= datetime.now(timezone.utc) - timedelta(days=days),
        )
    )
    voice_sessions = voice_result.scalars().all()

    total_voice_seconds = sum(s.duration_seconds or 0 for s in voice_sessions)

    # Aggregate voice by day
    voice_by_day: dict[str, int] = {}
    for s in voice_sessions:
        day = s.started_at.strftime("%Y-%m-%d")
        voice_by_day[day] = voice_by_day.get(day, 0) + (s.duration_seconds or 0)

    # Messages: daily breakdown
    msg_result = await db.execute(
        select(MessageCount.day, func.sum(MessageCount.count))
        .where(
            MessageCount.user_id == user_id,
            MessageCount.day >= cutoff,
        )
        .group_by(MessageCount.day)
    )
    messages_by_day = {row[0]: row[1] for row in msg_result.all()}

    total_messages = sum(messages_by_day.values())

    # Current active session duration (if connected)
    active_result = await db.execute(
        select(VoiceSession).where(
            VoiceSession.user_id == user_id,
            VoiceSession.ended_at.is_(None),
        )
    )
    active_session = active_result.scalar_one_or_none()
    active_since = None
    if active_session:
        active_since = active_session.started_at.isoformat()

    # Build daily series for the full range
    today = datetime.now(timezone.utc).date()
    daily = []
    for i in range(days):
        d = (today - timedelta(days=days - 1 - i)).isoformat()
        daily.append({
            "day": d,
            "voice_seconds": voice_by_day.get(d, 0),
            "messages": messages_by_day.get(d, 0),
        })

    return {
        "total_voice_seconds": total_voice_seconds,
        "total_messages": total_messages,
        "active_since": active_since,
        "daily": daily,
    }
