import time
from collections import defaultdict, deque
from html import escape as html_escape

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from dependencies import require_server_admin
from models import Webhook, Channel, Server
from dependencies import get_user_id
from services.bot import bot_send_message, BOT_ACCESS_TOKEN

router = APIRouter(tags=["webhooks"])

# Rate limit: 5 messages per webhook per minute (sliding window)
_rate_limits: dict[str, deque[float]] = defaultdict(deque)
_RATE_LIMIT = 5
_RATE_WINDOW = 60  # seconds


def _check_rate_limit(webhook_id: str) -> bool:
    """Return True if the request is within rate limit, False if exceeded."""
    now = time.time()
    window = _rate_limits[webhook_id]
    # Evict old entries
    while window and window[0] < now - _RATE_WINDOW:
        window.popleft()
    if len(window) >= _RATE_LIMIT:
        return False
    window.append(now)
    return True


# --- Management endpoints (auth required, admin+) ---


class WebhookCreate(BaseModel):
    channel_id: int
    name: str = Field(min_length=1, max_length=100)


class WebhookResponse(BaseModel):
    id: str
    server_id: str
    channel_id: int
    channel_name: str
    name: str
    created_by: str
    enabled: bool
    created_at: str


def _webhook_response(wh: Webhook, channel_name: str) -> dict:
    return {
        "id": wh.id,
        "server_id": wh.server_id,
        "channel_id": wh.channel_id,
        "channel_name": channel_name,
        "name": wh.name,
        "created_by": wh.created_by,
        "enabled": wh.enabled,
        "created_at": wh.created_at.isoformat() if wh.created_at else "",
    }


@router.post("/api/servers/{server_id}/webhooks")
async def create_webhook(
    server_id: str,
    body: WebhookCreate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    await require_server_admin(server_id, user_id, db)

    # Verify channel belongs to this server
    result = await db.execute(
        select(Channel).where(Channel.id == body.channel_id, Channel.server_id == server_id)
    )
    channel = result.scalar_one_or_none()
    if not channel:
        raise HTTPException(404, "Channel not found in this server")

    webhook = Webhook(
        server_id=server_id,
        channel_id=body.channel_id,
        name=body.name,
        created_by=user_id,
    )
    db.add(webhook)
    await db.commit()
    await db.refresh(webhook)

    return _webhook_response(webhook, channel.name)


@router.get("/api/servers/{server_id}/webhooks")
async def list_webhooks(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(Webhook).where(Webhook.server_id == server_id)
    )
    webhooks = result.scalars().all()

    # Fetch channel names
    channel_ids = [wh.channel_id for wh in webhooks]
    if channel_ids:
        ch_result = await db.execute(
            select(Channel).where(Channel.id.in_(channel_ids))
        )
        channels = {ch.id: ch.name for ch in ch_result.scalars().all()}
    else:
        channels = {}

    return [_webhook_response(wh, channels.get(wh.channel_id, "unknown")) for wh in webhooks]


@router.delete("/api/servers/{server_id}/webhooks/{webhook_id}")
async def delete_webhook(
    server_id: str,
    webhook_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(Webhook).where(Webhook.id == webhook_id, Webhook.server_id == server_id)
    )
    webhook = result.scalar_one_or_none()
    if not webhook:
        raise HTTPException(404, "Webhook not found")

    await db.delete(webhook)
    await db.commit()
    return {"ok": True}


@router.patch("/api/servers/{server_id}/webhooks/{webhook_id}")
async def toggle_webhook(
    server_id: str,
    webhook_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    await require_server_admin(server_id, user_id, db)

    result = await db.execute(
        select(Webhook).where(Webhook.id == webhook_id, Webhook.server_id == server_id)
    )
    webhook = result.scalar_one_or_none()
    if not webhook:
        raise HTTPException(404, "Webhook not found")

    webhook.enabled = not webhook.enabled
    await db.commit()
    return {"id": webhook.id, "enabled": webhook.enabled}


# --- Public endpoints (no auth) ---


@router.get("/api/hooks/{webhook_id}")
async def get_webhook_info(
    webhook_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint: get webhook metadata for the submit form."""
    result = await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )
    webhook = result.scalar_one_or_none()
    if not webhook:
        raise HTTPException(404, "Webhook not found")

    # Get channel and server names
    ch_result = await db.execute(select(Channel).where(Channel.id == webhook.channel_id))
    channel = ch_result.scalar_one_or_none()

    srv_result = await db.execute(select(Server).where(Server.id == webhook.server_id))
    server = srv_result.scalar_one_or_none()

    return {
        "id": webhook.id,
        "name": webhook.name,
        "channel_name": channel.name if channel else "unknown",
        "server_name": server.name if server else "unknown",
        "enabled": webhook.enabled,
    }


class WebhookSubmit(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    username: str = Field(default="Anonymous", max_length=100)


@router.post("/api/hooks/{webhook_id}")
async def submit_webhook_message(
    webhook_id: str,
    body: WebhookSubmit,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint: submit a message via webhook."""
    result = await db.execute(
        select(Webhook).where(Webhook.id == webhook_id)
    )
    webhook = result.scalar_one_or_none()
    if not webhook:
        raise HTTPException(404, "Webhook not found")

    if not webhook.enabled:
        raise HTTPException(403, "This webhook is currently disabled")

    if not BOT_ACCESS_TOKEN:
        raise HTTPException(503, "Webhook delivery is not available")

    # Rate limit
    if not _check_rate_limit(webhook_id):
        raise HTTPException(429, "Rate limit exceeded. Please wait before sending another message.")

    # Get channel's Matrix room ID
    ch_result = await db.execute(select(Channel).where(Channel.id == webhook.channel_id))
    channel = ch_result.scalar_one_or_none()
    if not channel:
        raise HTTPException(500, "Webhook channel not found")

    # Format and send message (HTML-escape user-supplied content to prevent XSS)
    username = body.username.strip() or "Anonymous"
    safe_name = html_escape(webhook.name)
    safe_username = html_escape(username)
    safe_content = html_escape(body.content)
    formatted_body = f"**[{webhook.name}]** {username}\n\n{body.content}"
    html_body = (
        f"<strong>[{safe_name}]</strong> {safe_username}<br><br>{safe_content}"
    )

    await bot_send_message(channel.matrix_room_id, {
        "msgtype": "m.text",
        "body": formatted_body,
        "format": "org.matrix.custom.html",
        "formatted_body": html_body,
    })

    return {"ok": True}
