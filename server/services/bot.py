import hashlib
import hmac
import logging

import httpx

from config import MATRIX_HOMESERVER_URL, MATRIX_SERVER_NAME, MATRIX_REGISTRATION_TOKEN

logger = logging.getLogger(__name__)

BOT_USERNAME = "concorrd-bot"
BOT_USER_ID = f"@{BOT_USERNAME}:{MATRIX_SERVER_NAME}"
BOT_ACCESS_TOKEN: str | None = None

# Track which rooms the bot has joined this session
_joined_rooms: set[str] = set()


def _derive_bot_password() -> str:
    """Derive a deterministic password for the bot from the registration token."""
    return hmac.new(
        MATRIX_REGISTRATION_TOKEN.encode(),
        BOT_USERNAME.encode(),
        hashlib.sha256,
    ).hexdigest()


async def init_bot() -> None:
    """Register or login the bot user. Called during app startup."""
    global BOT_ACCESS_TOKEN

    password = _derive_bot_password()

    # Try to register first
    from services.matrix_admin import register_matrix_user

    try:
        result = await register_matrix_user(BOT_USERNAME, password)
        BOT_ACCESS_TOKEN = result["access_token"]
        logger.info("Bot user registered: %s", BOT_USER_ID)
        return
    except Exception as e:
        if "User ID already taken" not in str(e) and "user_in_use" not in str(e).lower():
            logger.warning("Bot registration failed: %s — trying login", e)

    # Registration failed (user exists), login instead
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": BOT_USERNAME},
                "password": password,
                "initial_device_display_name": "Concord Bot",
            },
        )
        if resp.status_code != 200:
            error = resp.json().get("error", resp.text)
            raise RuntimeError(f"Bot login failed: {error}")

        data = resp.json()
        BOT_ACCESS_TOKEN = data["access_token"]
        logger.info("Bot user logged in: %s", BOT_USER_ID)


async def bot_join_room(room_id: str) -> None:
    """Join a Matrix room as the bot user (skips if already joined this session)."""
    if room_id in _joined_rooms:
        return

    if not BOT_ACCESS_TOKEN:
        raise RuntimeError("Bot not initialized")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/join/{room_id}",
            headers={"Authorization": f"Bearer {BOT_ACCESS_TOKEN}"},
            json={},
        )
        # 200 = joined, or already in room
        if resp.status_code in (200, 403):
            # 403 might mean already joined or actually forbidden
            if resp.status_code == 403:
                error_msg = resp.json().get("error", "")
                if "already" not in error_msg.lower():
                    raise RuntimeError(f"Bot cannot join room {room_id}: {error_msg}")

    _joined_rooms.add(room_id)


async def bot_send_message(room_id: str, content: dict) -> None:
    """Send a message to a Matrix room as the bot user."""
    if not BOT_ACCESS_TOKEN:
        raise RuntimeError("Bot not initialized")

    await bot_join_room(room_id)

    async with httpx.AsyncClient() as client:
        resp = await client.put(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{_txn_id()}",
            headers={"Authorization": f"Bearer {BOT_ACCESS_TOKEN}"},
            json=content,
        )
        resp.raise_for_status()


def _txn_id() -> str:
    """Generate a unique transaction ID for Matrix message sends."""
    import time
    import secrets
    return f"bot-{int(time.time() * 1000)}-{secrets.token_hex(4)}"
