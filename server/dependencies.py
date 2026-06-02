import asyncio
import logging
import time
from typing import Optional

import httpx
from fastapi import Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import MATRIX_HOMESERVER_URL
from models import ServerMember

logger = logging.getLogger(__name__)

# TTL cache for token -> user_id validation. Avoids per-request whoami round-trip.
_token_cache: dict[str, tuple[str, float]] = {}
_token_cache_lock = asyncio.Lock()
_CACHE_TTL = 300  # 5 minutes
_CACHE_MAX_SIZE = 1000


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

    token = authorization[7:]
    if not token:
        raise HTTPException(401, "Missing access token")

    now = time.time()
    cached = _token_cache.get(token)
    if cached:
        user_id, expires = cached
        if now < expires:
            return user_id

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

    async with _token_cache_lock:
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


async def require_server_member(
    server_id: str, user_id: str, db: AsyncSession
) -> ServerMember:
    """Raise 403 if the user is not a member of the server."""
    result = await db.execute(
        select(ServerMember).where(
            ServerMember.server_id == server_id,
            ServerMember.user_id == user_id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(403, "You are not a member of this server")
    return member


async def require_server_admin(
    server_id: str, user_id: str, db: AsyncSession
) -> ServerMember:
    """Raise 403 if the user is not an admin or owner of the server."""
    member = await require_server_member(server_id, user_id, db)
    if member.role not in ("owner", "admin"):
        raise HTTPException(403, "Only admins and the server owner can do this")
    return member


async def require_server_owner(
    server_id: str, user_id: str, db: AsyncSession
) -> ServerMember:
    """Raise 403 if the user is not the owner of the server."""
    member = await require_server_member(server_id, user_id, db)
    if member.role != "owner":
        raise HTTPException(403, "Only the server owner can do this")
    return member
