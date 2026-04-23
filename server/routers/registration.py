import logging
import os
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import get_db
from models import InviteToken, Channel, Server, ServerMember
from services.matrix_admin import register_matrix_user, join_room

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/register", tags=["registration"])

# Rate limit: 5 registrations per IP per 15 minutes
_reg_rate_limits: dict[str, deque[float]] = defaultdict(deque)
_REG_RATE_LIMIT = 5
_REG_RATE_WINDOW = 900  # 15 minutes

# Periodic sweep counters. Without the sweep, an attacker spraying
# many distinct IPs a single time each would leak one dict entry per
# IP forever (the per-call ``del`` below only fires when the same
# IP is hit again after the window expires). The sweep walks the
# whole dict every ``_REG_SWEEP_INTERVAL`` calls and drops any empty
# or fully-expired keys.
_reg_sweep_counter = 0
_REG_SWEEP_INTERVAL = 1000


def _sweep_reg_rate_limits(now: float) -> None:
    """Walk the rate-limit dict and delete empty / fully-expired entries.

    Bounded O(dict_size) and infrequent. Catches the case where an
    attacker hits many distinct IPs a single time each (so the
    per-call ``del`` never fires).
    """
    cutoff = now - _REG_RATE_WINDOW
    for key in list(_reg_rate_limits.keys()):
        window = _reg_rate_limits.get(key)
        if not window:
            _reg_rate_limits.pop(key, None)
            continue
        while window and window[0] < cutoff:
            window.popleft()
        if not window:
            _reg_rate_limits.pop(key, None)


def _check_registration_rate_limit(ip: str) -> bool:
    """Return True if within rate limit, False if exceeded.

    After popping expired entries, if the deque is empty, delete the
    IP key itself so the outer dict cannot grow unbounded. A periodic
    sweep catches one-shot attacker IPs that the per-call ``del``
    would never touch.
    """
    global _reg_sweep_counter
    now = time.time()

    _reg_sweep_counter += 1
    if _reg_sweep_counter >= _REG_SWEEP_INTERVAL:
        _reg_sweep_counter = 0
        _sweep_reg_rate_limits(now)

    window = _reg_rate_limits[ip]
    while window and window[0] < now - _REG_RATE_WINDOW:
        window.popleft()
    # If the sliding-window pop emptied the deque, drop the key too;
    # the ``append`` below recreates a fresh one via the defaultdict.
    if not window:
        del _reg_rate_limits[ip]
        window = _reg_rate_limits[ip]
    if len(window) >= _REG_RATE_LIMIT:
        return False
    window.append(now)
    return True


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    invite_token: str | None = None


class RegisterResponse(BaseModel):
    access_token: str
    user_id: str
    device_id: str
    server_id: str | None = None
    server_name: str | None = None


@router.post("", response_model=RegisterResponse)
async def register_user(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Register a new user account.

    If an invite_token is provided, also joins the user to that server.
    If no invite_token, just creates the Matrix account (only when
    OPEN_REGISTRATION=true — by default registration requires an invite).
    """
    # Closed-registration gate: unless OPEN_REGISTRATION is explicitly
    # enabled, every registration attempt must include a valid invite
    # token. Login for existing accounts is unaffected (different endpoint).
    # Exception: first boot (no first_boot_complete in instance.json) always
    # allows registration so the operator can create the initial admin account.
    import json
    from config import INSTANCE_SETTINGS_FILE
    _inst = json.loads(INSTANCE_SETTINGS_FILE.read_text()) if INSTANCE_SETTINGS_FILE.exists() else {}
    is_first_boot = not _inst.get("first_boot_complete", False)

    open_reg = os.getenv("OPEN_REGISTRATION", "").lower() in ("true", "1", "yes")
    if not is_first_boot and not open_reg and not body.invite_token:
        raise HTTPException(403, "Registration requires an invite token")

    # Rate limit by real client IP (prefer Cf-Connecting-Ip from Cloudflare)
    client_ip = (
        request.headers.get("Cf-Connecting-Ip")
        or request.headers.get("X-Real-Ip")
        or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    )
    if not client_ip and request.client:
        client_ip = request.client.host
    if client_ip and not _check_registration_rate_limit(client_ip):
        raise HTTPException(429, "Too many registration attempts. Please try again later.")

    invite = None

    if body.invite_token:
        # Validate invite exists and is not expired
        result = await db.execute(
            select(InviteToken)
            .options(selectinload(InviteToken.server))
            .where(InviteToken.token == body.invite_token)
        )
        invite = result.scalar_one_or_none()

        if not invite or not invite.is_valid:
            raise HTTPException(400, "Invalid or expired invite token")

        # Atomically reserve an invite slot (skip for permanent invites)
        if not invite.permanent:
            reserve_result = await db.execute(
                update(InviteToken)
                .where(
                    InviteToken.id == invite.id,
                    InviteToken.use_count < InviteToken.max_uses,
                )
                .values(use_count=InviteToken.use_count + 1)
            )
            if reserve_result.rowcount == 0:
                raise HTTPException(400, "Invite has reached its maximum uses")

    # Register on Matrix homeserver
    try:
        matrix_result = await register_matrix_user(body.username, body.password)
    except Exception as e:
        # Compensating transaction: release the reserved slot
        if invite and not invite.permanent:
            await db.execute(
                update(InviteToken)
                .where(InviteToken.id == invite.id)
                .values(use_count=InviteToken.use_count - 1)
            )
            await db.commit()
        error_msg = str(e)
        logger.error("Matrix registration failed for %s: %s", body.username, error_msg)
        # Pass through the Matrix homeserver error for meaningful feedback
        if "User ID already taken" in error_msg or "taken" in error_msg.lower():
            raise HTTPException(400, "Username is already taken")
        elif "exclusive" in error_msg.lower():
            raise HTTPException(400, "That username is reserved")
        elif "invalid" in error_msg.lower() or "not allowed" in error_msg.lower():
            raise HTTPException(400, f"Invalid username: {error_msg}")
        else:
            raise HTTPException(400, f"Registration failed: {error_msg}")

    access_token = matrix_result["access_token"]
    user_id = matrix_result["user_id"]
    device_id = matrix_result["device_id"]

    server_id = None
    server_name = None

    # Auto-join default public server (if one exists)
    try:
        import json
        from config import INSTANCE_SETTINGS_FILE
        from services.bot import BOT_USER_ID
        if INSTANCE_SETTINGS_FILE.exists():
            inst_settings = json.loads(INSTANCE_SETTINGS_FILE.read_text())
            default_id = inst_settings.get("default_server_id")
            if default_id:
                # Check not already joining via invite to same server
                if not invite or invite.server_id != default_id:
                    # On first boot, the operator takes ownership of the
                    # bot-seeded Lobby. The seed flow assigns the bot as
                    # placeholder owner so the server exists before any
                    # humans; the first human registrant inherits it so
                    # they can actually administer invites, channels, etc.
                    default_server = await db.get(Server, default_id)
                    promote_to_owner = (
                        is_first_boot
                        and default_server is not None
                        and default_server.owner_id == BOT_USER_ID
                    )

                    existing = await db.execute(
                        select(ServerMember).where(
                            ServerMember.server_id == default_id,
                            ServerMember.user_id == user_id,
                        )
                    )
                    existing_member = existing.scalar_one_or_none()
                    role = "owner" if promote_to_owner else "member"
                    if not existing_member:
                        db.add(ServerMember(
                            server_id=default_id,
                            user_id=user_id,
                            role=role,
                            can_kick=promote_to_owner,
                            can_ban=promote_to_owner,
                        ))
                    elif promote_to_owner:
                        existing_member.role = "owner"
                        existing_member.can_kick = True
                        existing_member.can_ban = True

                    if promote_to_owner:
                        default_server.owner_id = user_id
                        # Demote the bot from owner to admin so it still
                        # has rights to drive bot-side functionality but
                        # can no longer be mistaken for the human operator.
                        bot_member = await db.execute(
                            select(ServerMember).where(
                                ServerMember.server_id == default_id,
                                ServerMember.user_id == BOT_USER_ID,
                            )
                        )
                        bot_row = bot_member.scalar_one_or_none()
                        if bot_row and bot_row.role == "owner":
                            bot_row.role = "admin"
                        logger.info(
                            "First-boot Lobby ownership transferred from %s to %s",
                            BOT_USER_ID, user_id,
                        )

                    default_channels = await db.execute(
                        select(Channel).where(Channel.server_id == default_id)
                    )
                    for ch in default_channels.scalars().all():
                        try:
                            await join_room(access_token, ch.matrix_room_id)
                        except Exception as e:
                            logger.warning("Auto-join default room %s failed: %s", ch.matrix_room_id, e)
    except Exception as e:
        logger.warning("Default server auto-join failed: %s", e)

    # If invite provided, join the server
    if invite:
        db.add(ServerMember(
            server_id=invite.server_id,
            user_id=user_id,
            role="member",
        ))

        channels_result = await db.execute(
            select(Channel).where(Channel.server_id == invite.server_id)
        )
        for channel in channels_result.scalars().all():
            try:
                await join_room(access_token, channel.matrix_room_id)
            except Exception as e:
                logger.warning(
                    "Failed to auto-join %s to room %s: %s",
                    user_id, channel.matrix_room_id, e,
                )

        server_id = invite.server_id
        server_name = invite.server.name

    # First-boot completion: record admin user and mark setup done.
    if is_first_boot:
        _inst["first_boot_complete"] = True
        existing_admins = _inst.get("admin_user_ids", [])
        if user_id not in existing_admins:
            existing_admins.append(user_id)
        _inst["admin_user_ids"] = existing_admins
        INSTANCE_SETTINGS_FILE.write_text(json.dumps(_inst, indent=2))
        logger.info("First-boot admin created: %s", user_id)

    await db.commit()

    return RegisterResponse(
        access_token=access_token,
        user_id=user_id,
        device_id=device_id,
        server_id=server_id,
        server_name=server_name,
    )
