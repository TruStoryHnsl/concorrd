"""Discord OAuth2 user-login flow.

The admin-managed mautrix-discord bridge under ``routers/admin_bridges.py``
is a separate, operator-scoped integration — this router is the
per-user path: each Concord user clicks "Sign in with Discord", Discord
redirects back with an authorization code, we exchange it for an
access + refresh token, and store the pair so the rest of concord-api
can hit the Discord REST API on the user's behalf.

Flow:

  1. Client POSTs ``/oauth/start``. Server generates a CSRF state row
     (``DiscordOAuthState``) and returns the Discord authorize URL.
  2. Client navigates the browser to that URL. Discord asks the user to
     approve, then redirects to our ``/oauth/callback`` with ``code``
     and ``state``.
  3. Callback verifies state, POSTs to Discord's ``/api/oauth2/token``
     for an access token, fetches ``/users/@me`` for profile info, and
     upserts a ``UserDiscordOAuth`` row for the caller. State row is
     deleted so a code can't be replayed.
  4. Callback 302s the user back to ``return_to`` (defaults to ``/``).

Security notes:

- The CSRF ``state`` is a 32-byte URL-safe random value, single-use,
  10-minute TTL.
- ``return_to`` is restricted to same-origin paths starting with ``/``
  (no schemes, no protocol-relative URIs) so a hostile authorize link
  can't open-redirect the user after login.
- Tokens are stored unencrypted in the DB — documented trade-off; see
  ``models.UserDiscordOAuth`` docstring.
- Nothing here touches the mautrix-discord bridge. The two flows are
  independent state machines.

Scope notes:

- Discord's OAuth2 public scopes do NOT include message read/send for
  third-party web apps. That is a hard Discord policy, not an omission
  — so this router can do login, profile, guild listing, and
  guild-joining, but NOT in-app Discord chat. For full chat, Concord
  needs a bot invited to the guild (admin-level) or a captured-token
  hybrid (see the Phase-3 router).
"""
from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import UserDiscordOAuth, DiscordOAuthState
from routers.servers import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/users/me/discord", tags=["user-discord-oauth"])


# ---------------------------------------------------------------------------
# Config — read at call time so tests can monkeypatch env without reload.
# ---------------------------------------------------------------------------

_STATE_TTL_SECONDS = 10 * 60
_DISCORD_AUTHORIZE = "https://discord.com/api/oauth2/authorize"
_DISCORD_TOKEN = "https://discord.com/api/oauth2/token"
_DISCORD_TOKEN_REVOKE = "https://discord.com/api/oauth2/token/revoke"
_DISCORD_USERS_ME = "https://discord.com/api/users/@me"
# Default OAuth scopes. ``identify`` gives us username + avatar, ``guilds``
# lists the user's servers. Additional scopes (``email``, ``guilds.join``,
# ``guilds.members.read``) are available if product needs them but we
# keep the default minimal so the Discord consent screen is as quiet as
# possible.
DEFAULT_SCOPES = ["identify", "guilds"]


def _client_id() -> str | None:
    """Resolve the Discord OAuth client id.

    Precedence: runtime-managed value in instance.json (set via the
    admin UI) wins over the ``DISCORD_OAUTH_CLIENT_ID`` env var. The
    env var remains a useful bootstrap default so fresh installs can
    ship with the creds pre-wired, but the UI is authoritative so
    operators never need to edit .env to flip them.
    """
    # Imported lazily to avoid a module-level cycle — admin.py depends
    # on other things that import from routers/.
    from routers.admin import _read_instance_settings
    settings = _read_instance_settings()
    persisted = settings.get("discord_oauth_client_id")
    if isinstance(persisted, str) and persisted.strip():
        return persisted.strip()
    return os.getenv("DISCORD_OAUTH_CLIENT_ID") or None


def _client_secret() -> str | None:
    """Companion to ``_client_id``. Secret-grade, never returned to the
    client directly; only used when POSTing to Discord's token endpoint.
    """
    from routers.admin import _read_instance_settings
    settings = _read_instance_settings()
    persisted = settings.get("discord_oauth_client_secret")
    if isinstance(persisted, str) and persisted.strip():
        return persisted.strip()
    return os.getenv("DISCORD_OAUTH_CLIENT_SECRET") or None


def _public_base_url() -> str:
    """Base URL the browser uses to reach this instance. Falls back to
    ``CONCORD_DOMAIN`` + https if ``PUBLIC_BASE_URL`` isn't set, since
    every prod deployment sets at least one of them. Trailing slash
    stripped so callers can concat paths verbatim.
    """
    raw = os.getenv("PUBLIC_BASE_URL")
    if raw:
        return raw.rstrip("/")
    domain = os.getenv("CONCORD_DOMAIN") or os.getenv("CONDUWUIT_SERVER_NAME")
    if domain:
        return f"https://{domain}".rstrip("/")
    return ""


def _redirect_uri() -> str:
    base = _public_base_url()
    return f"{base}/api/users/me/discord/oauth/callback"


def _is_enabled() -> bool:
    return bool(_client_id() and _client_secret() and _public_base_url())


def _safe_return_to(value: str | None) -> str:
    """Clamp ``return_to`` to a same-origin absolute path.

    Accepts: ``/settings``, ``/channel/abc``, etc. Rejects anything
    with a scheme or double-slash (``//evil.com`` is a valid URL the
    browser would load cross-origin). Empty / invalid → ``/``.
    """
    if not value:
        return "/"
    if not value.startswith("/"):
        return "/"
    if value.startswith("//"):
        return "/"
    # Belt-and-braces: urlsplit on a relative path should have no scheme
    # or netloc. If a crafted input somehow sneaks one past the startswith
    # checks, fall back.
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return "/"
    return value


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class OAuthConfig(BaseModel):
    enabled: bool = Field(
        description="True when DISCORD_OAUTH_CLIENT_ID + _SECRET + a public base URL are all set on this instance."
    )
    client_id: str | None = None
    redirect_uri: str | None = None
    scopes: list[str] = Field(default_factory=list)


class OAuthStartRequest(BaseModel):
    return_to: str | None = Field(
        default=None,
        description="Absolute path (no scheme) to redirect the user back to after a successful login. Defaults to '/'.",
    )


class OAuthStartResponse(BaseModel):
    authorize_url: str


class DiscordUserProfile(BaseModel):
    id: str
    username: str
    global_name: str | None = None
    avatar: str | None = None


class DiscordConnectionStatus(BaseModel):
    connected: bool
    mxid: str
    user: DiscordUserProfile | None = None


# ---------------------------------------------------------------------------
# Token + profile helpers
# ---------------------------------------------------------------------------


async def _exchange_code_for_token(code: str) -> dict[str, Any]:
    """POST Discord's OAuth2 token endpoint with an authorization ``code``.

    Returns the raw JSON response (contains ``access_token``,
    ``refresh_token``, ``expires_in``, ``scope``). Raises
    ``HTTPException`` on any failure so the callback can surface it to
    the user.
    """
    client_id = _client_id()
    client_secret = _client_secret()
    if not client_id or not client_secret:
        raise HTTPException(500, "Discord OAuth not configured on this instance")
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _redirect_uri(),
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            _DISCORD_TOKEN,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        logger.warning("Discord token exchange failed: %s %s", resp.status_code, resp.text)
        raise HTTPException(502, f"Discord rejected the authorization code: {resp.text}")
    return resp.json()


async def _refresh_access_token(row: UserDiscordOAuth) -> None:
    """Refresh ``row.access_token`` in place using the stored refresh token.

    Caller is responsible for db.commit(). Raises HTTPException on
    failure so the UI can react (e.g. prompt the user to sign in again).
    """
    if not row.refresh_token:
        raise HTTPException(401, "No refresh token stored; please sign in again")
    client_id = _client_id()
    client_secret = _client_secret()
    if not client_id or not client_secret:
        raise HTTPException(500, "Discord OAuth not configured on this instance")
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": row.refresh_token,
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            _DISCORD_TOKEN,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        logger.warning(
            "Discord token refresh failed for %s: %s %s",
            row.user_id, resp.status_code, resp.text,
        )
        raise HTTPException(401, "Discord session expired; please sign in again")
    payload = resp.json()
    _apply_token_payload(row, payload)


def _apply_token_payload(row: UserDiscordOAuth, payload: dict[str, Any]) -> None:
    """Update a row's token fields from a Discord token-endpoint response.

    Discord returns both access_token + refresh_token on the initial
    code exchange and refresh_token on the refresh response (rotating).
    """
    row.access_token = payload["access_token"]
    row.refresh_token = payload.get("refresh_token") or row.refresh_token
    expires_in = int(payload.get("expires_in") or 604800)
    row.expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    row.scope = payload.get("scope") or row.scope
    row.updated_at = datetime.now(timezone.utc)


async def _fetch_profile(access_token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            _DISCORD_USERS_ME,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"Discord /users/@me failed: {resp.status_code} {resp.text}")
    return resp.json()


async def get_oauth_row_or_none(
    user_id: str, db: AsyncSession
) -> UserDiscordOAuth | None:
    return await db.get(UserDiscordOAuth, user_id)


async def ensure_fresh_token(
    row: UserDiscordOAuth, db: AsyncSession
) -> UserDiscordOAuth:
    """Refresh the access token if it's within 60s of expiring. Caller
    must ``await db.commit()`` after any mutation this triggers.
    """
    now = datetime.now(timezone.utc)
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires - now > timedelta(seconds=60):
        return row
    await _refresh_access_token(row)
    return row


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/oauth/config", response_model=OAuthConfig)
async def oauth_config(_user_id: str = Depends(get_user_id)) -> OAuthConfig:
    """Tell the client whether OAuth is usable on this instance and what
    parameters to expect. Auth-gated because the ``client_id`` is sensitive
    to enumerate but not a secret — still, no reason to publish it at an
    anonymous endpoint.
    """
    return OAuthConfig(
        enabled=_is_enabled(),
        client_id=_client_id(),
        redirect_uri=_redirect_uri() if _is_enabled() else None,
        scopes=DEFAULT_SCOPES if _is_enabled() else [],
    )


@router.post("/oauth/start", response_model=OAuthStartResponse)
async def oauth_start(
    body: OAuthStartRequest | None = None,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> OAuthStartResponse:
    if not _is_enabled():
        raise HTTPException(503, "Discord OAuth not configured on this instance")
    client_id = _client_id()
    # New CSRF state. Single-use, 10 min TTL (enforced on callback).
    state_value = secrets.token_urlsafe(32)
    return_to = _safe_return_to(body.return_to if body else None)

    # Evict any prior pending state for this user so we don't accumulate
    # rows if the user starts + abandons the flow multiple times. The
    # /callback still matches strictly on state, so dropping stale
    # entries is purely housekeeping.
    await db.execute(
        delete(DiscordOAuthState).where(DiscordOAuthState.user_id == user_id)
    )
    db.add(
        DiscordOAuthState(
            state=state_value,
            user_id=user_id,
            return_to=return_to,
        )
    )
    await db.commit()

    params = {
        "response_type": "code",
        "client_id": client_id,
        "scope": " ".join(DEFAULT_SCOPES),
        "state": state_value,
        "redirect_uri": _redirect_uri(),
        "prompt": "none",  # re-auth silently if Discord remembers consent
    }
    return OAuthStartResponse(authorize_url=f"{_DISCORD_AUTHORIZE}?{urlencode(params)}")


@router.get("/oauth/callback")
async def oauth_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Discord redirects here after the user approves (or denies). This
    endpoint is NOT auth-gated — the state row is what ties the anonymous
    redirect back to a specific Concord user.
    """
    base = _public_base_url() or "/"
    if error:
        # User denied or Discord rejected. Redirect back to the app with
        # an error flag so the UI can surface it.
        qs = urlencode({"discord_oauth_error": error, "message": error_description or ""})
        return RedirectResponse(url=f"{base}/?{qs}", status_code=status.HTTP_302_FOUND)

    if not code or not state:
        raise HTTPException(400, "Missing code or state parameter")

    row_state = await db.get(DiscordOAuthState, state)
    if row_state is None:
        raise HTTPException(400, "Invalid or expired state")
    created = row_state.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - created > timedelta(seconds=_STATE_TTL_SECONDS):
        await db.execute(
            delete(DiscordOAuthState).where(DiscordOAuthState.state == state)
        )
        await db.commit()
        raise HTTPException(400, "OAuth state expired — try signing in again")

    user_id = row_state.user_id
    return_to = _safe_return_to(row_state.return_to)

    token_payload = await _exchange_code_for_token(code)
    profile = await _fetch_profile(token_payload["access_token"])

    row = await db.get(UserDiscordOAuth, user_id)
    if row is None:
        row = UserDiscordOAuth(
            user_id=user_id,
            discord_user_id=str(profile.get("id", "")),
            discord_username=str(profile.get("username", "")),
            discord_global_name=profile.get("global_name"),
            discord_avatar=profile.get("avatar"),
            access_token="",
            refresh_token=None,
            expires_at=datetime.now(timezone.utc),
            scope=token_payload.get("scope") or " ".join(DEFAULT_SCOPES),
        )
        db.add(row)
    else:
        row.discord_user_id = str(profile.get("id", ""))
        row.discord_username = str(profile.get("username", ""))
        row.discord_global_name = profile.get("global_name")
        row.discord_avatar = profile.get("avatar")
    _apply_token_payload(row, token_payload)

    # Consume the state row so the code can't be replayed.
    await db.execute(
        delete(DiscordOAuthState).where(DiscordOAuthState.state == state)
    )
    await db.commit()

    logger.info("user_discord_oauth: linked %s → discord %s", user_id, row.discord_user_id)
    return RedirectResponse(url=f"{base}{return_to}", status_code=status.HTTP_302_FOUND)


@router.delete("/oauth", status_code=204)
async def oauth_revoke(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(UserDiscordOAuth, user_id)
    if row is None:
        return

    client_id = _client_id()
    client_secret = _client_secret()
    if client_id and client_secret:
        # Best-effort revoke on Discord's side — failures are non-fatal
        # because the local row is the source of truth for whether the
        # user is "connected" in Concord's UI.
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    _DISCORD_TOKEN_REVOKE,
                    data={
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "token": row.access_token,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
        except httpx.HTTPError as exc:
            logger.info(
                "user_discord_oauth: token revoke network error for %s: %s",
                user_id, exc,
            )

    await db.delete(row)
    await db.commit()
    logger.info("user_discord_oauth: disconnected %s", user_id)


@router.get("", response_model=DiscordConnectionStatus)
async def user_discord_status(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordConnectionStatus:
    """OAuth-backed status. Replaces the v0.4.4 bridge-timeline heuristic
    since the bridge is no longer the user login surface.
    """
    row = await get_oauth_row_or_none(user_id, db)
    if row is None:
        return DiscordConnectionStatus(connected=False, mxid=user_id)
    return DiscordConnectionStatus(
        connected=True,
        mxid=user_id,
        user=DiscordUserProfile(
            id=row.discord_user_id,
            username=row.discord_username,
            global_name=row.discord_global_name,
            avatar=row.discord_avatar,
        ),
    )


# ---------------------------------------------------------------------------
# Phase 2: guilds as Discord-scoped source tiles.
#
# Uses the user's OAuth token (``guilds`` scope) to hit Discord's
# ``/users/@me/guilds`` endpoint and proxy the list back. Transparently
# refreshes the access token if it's within 60s of expiring. Returns 401
# if the user isn't connected so the client can prompt a re-sign-in.
# ---------------------------------------------------------------------------


class DiscordGuild(BaseModel):
    id: str
    name: str
    icon: str | None = None
    owner: bool = False
    # Permission integer Discord returns is a bitfield; passed through
    # as a string to avoid the 32-bit JSON number issue on older
    # clients. The UI can parse as needed.
    permissions: str | None = None
    # Icon URL the UI can render directly. Built server-side so we can
    # centralise the CDN URL format if Discord ever changes it.
    icon_url: str | None = None


class DiscordGuildsResponse(BaseModel):
    guilds: list[DiscordGuild]


async def _discord_api_get(row: UserDiscordOAuth, path: str, db: AsyncSession) -> httpx.Response:
    """GET a Discord REST endpoint using the user's OAuth token.

    Refreshes the token on 401 once and retries. Caller is responsible
    for committing db state changes (we handle token-row mutations).
    """
    url = f"https://discord.com/api{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            url, headers={"Authorization": f"Bearer {row.access_token}"}
        )
        if resp.status_code != 401:
            return resp
        # Token rejected — try a refresh-and-retry once.
        try:
            await _refresh_access_token(row)
        except HTTPException:
            return resp
        await db.commit()
        resp = await client.get(
            url, headers={"Authorization": f"Bearer {row.access_token}"}
        )
        return resp


def _guild_icon_url(guild_id: str, icon: str | None) -> str | None:
    if not icon:
        return None
    # Animated icons are prefixed with a_ and must be served as GIF; all
    # others default to PNG. size=128 is a reasonable default for the
    # source tile size we're rendering.
    ext = "gif" if icon.startswith("a_") else "png"
    return f"https://cdn.discordapp.com/icons/{guild_id}/{icon}.{ext}?size=128"


@router.get("/guilds", response_model=DiscordGuildsResponse)
async def user_discord_guilds(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordGuildsResponse:
    """Return the caller's Discord guilds as source-tile-ready records."""
    row = await get_oauth_row_or_none(user_id, db)
    if row is None:
        raise HTTPException(401, "Not signed in to Discord")
    await ensure_fresh_token(row, db)
    await db.commit()

    resp = await _discord_api_get(row, "/users/@me/guilds", db)
    if resp.status_code == 401:
        raise HTTPException(401, "Discord session expired; please sign in again")
    if resp.status_code == 429:
        retry = resp.headers.get("retry-after", "?")
        raise HTTPException(429, f"Discord rate-limited; retry in {retry}s")
    if resp.status_code != 200:
        raise HTTPException(502, f"Discord /users/@me/guilds: {resp.status_code} {resp.text[:200]}")

    entries: list[DiscordGuild] = []
    for g in resp.json() or []:
        gid = str(g.get("id") or "")
        if not gid:
            continue
        icon = g.get("icon")
        entries.append(
            DiscordGuild(
                id=gid,
                name=str(g.get("name") or ""),
                icon=icon,
                owner=bool(g.get("owner")),
                permissions=(
                    str(g.get("permissions"))
                    if g.get("permissions") is not None
                    else None
                ),
                icon_url=_guild_icon_url(gid, icon),
            )
        )
    return DiscordGuildsResponse(guilds=entries)


# ---------------------------------------------------------------------------
# Phase 3: per-guild channels + messages.
#
# Discord's OAuth2 public scopes do NOT grant access to ``/guilds/:id/channels``
# or ``/channels/:id/messages`` — those require a bot token where the bot
# is a member of the guild. This endpoint therefore falls back to the
# mautrix-discord bridge's captured user token when one is available
# (stored in the bridge's SQLite DB after a QR login).
#
# Contract: best-effort. Returns structured data when the captured token
# works; returns a clear ``limited_by_discord`` flag when no captured
# session exists so the UI can render a "connect the bridge too" hint
# without pretending messages are available.
# ---------------------------------------------------------------------------


class DiscordChannelEntry(BaseModel):
    id: str
    name: str | None = None
    # Discord channel type codes: 0=text, 2=voice, 4=category, 5=news,
    # 10=news-thread, 11=public-thread, 12=private-thread, 13=stage-voice,
    # 15=forum. Passed through verbatim; UI filters/decorates.
    type: int
    parent_id: str | None = None
    position: int | None = None
    topic: str | None = None
    nsfw: bool = False


class DiscordChannelsResponse(BaseModel):
    channels: list[DiscordChannelEntry]
    limited_by_discord: bool = Field(
        default=False,
        description="True when only the OAuth scopes are available. Messages and channel content are not readable without a captured-session token.",
    )


class DiscordMessageAuthor(BaseModel):
    id: str
    username: str
    global_name: str | None = None
    avatar: str | None = None


class DiscordMessageEntry(BaseModel):
    id: str
    channel_id: str
    content: str
    timestamp: str
    edited_timestamp: str | None = None
    author: DiscordMessageAuthor


class DiscordMessagesResponse(BaseModel):
    messages: list[DiscordMessageEntry]
    limited_by_discord: bool = False


async def _captured_session_token(user_id: str) -> str | None:
    """Return the mautrix-discord-captured user token for this Concord
    account if one exists, else None.

    Reads directly from the bridge's SQLite database via the docker
    volume — there's no public provisioning API that exposes user
    tokens, and enabling the provisioning endpoint just to shuttle the
    same value back through HTTP would be equivalent security-wise and
    more moving parts.

    The bridge's DB path is configurable; we look for it at the
    default location inside the bridge container's volume mounted at
    ``/mautrix-discord-data`` (operator adds this bind mount when they
    want Phase-3 messages to work; absent by default to keep the token
    blast radius contained).
    """
    import sqlite3
    from pathlib import Path

    # Allow override for test / non-default deploys.
    db_path = os.getenv(
        "MAUTRIX_DISCORD_DB_PATH",
        "/mautrix-discord-data/mautrix-discord.db",
    )
    if not Path(db_path).exists():
        return None
    try:
        # Read-only connection — no write risk even if a field has
        # unexpected SQL content.
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3.0)
        try:
            cur = conn.execute(
                "SELECT discord_token FROM \"user\" WHERE mxid = ?",
                (user_id,),
            )
            row = cur.fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.info(
            "captured-session lookup failed for %s: %s", user_id, exc,
        )
        return None
    if not row:
        return None
    token = row[0]
    if isinstance(token, bytes):
        try:
            token = token.decode()
        except UnicodeDecodeError:
            return None
    return token or None


async def _discord_raw_get(
    token: str, path: str, *, is_bot: bool = False
) -> httpx.Response:
    """GET a Discord REST endpoint with a raw user-scoped OR bot token.

    Distinct from ``_discord_api_get`` because that one auto-refreshes
    via our OAuth row, which doesn't apply to captured-session tokens.
    """
    url = f"https://discord.com/api{path}"
    # Discord distinguishes ``Authorization: Bearer`` (OAuth) from
    # ``Authorization: Bot`` (bot) from bare ``Authorization: <token>``
    # (user / self-bot). Captured-session tokens are the user form.
    if is_bot:
        auth = f"Bot {token}"
    else:
        auth = token
    async with httpx.AsyncClient(timeout=15.0) as client:
        return await client.get(url, headers={"Authorization": auth})


@router.get("/guilds/{guild_id}/channels", response_model=DiscordChannelsResponse)
async def user_discord_guild_channels(
    guild_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordChannelsResponse:
    """Return a guild's channel list. Requires the captured-session
    token; without it, returns an empty list with ``limited_by_discord``
    flipped so the UI can explain the gap.
    """
    # Gate behind an OAuth connection so the status is consistent —
    # calling /channels before /guilds shouldn't silently succeed.
    oauth_row = await get_oauth_row_or_none(user_id, db)
    if oauth_row is None:
        raise HTTPException(401, "Not signed in to Discord")

    token = await _captured_session_token(user_id)
    if not token:
        return DiscordChannelsResponse(channels=[], limited_by_discord=True)

    resp = await _discord_raw_get(token, f"/guilds/{guild_id}/channels")
    if resp.status_code == 401:
        # Captured token is stale — surface as limited rather than
        # pretending the channel list is legitimately empty.
        return DiscordChannelsResponse(channels=[], limited_by_discord=True)
    if resp.status_code == 429:
        retry = resp.headers.get("retry-after", "?")
        raise HTTPException(429, f"Discord rate-limited; retry in {retry}s")
    if resp.status_code != 200:
        raise HTTPException(
            502,
            f"Discord /guilds/{guild_id}/channels: {resp.status_code} {resp.text[:200]}",
        )

    out: list[DiscordChannelEntry] = []
    for ch in resp.json() or []:
        cid = str(ch.get("id") or "")
        if not cid:
            continue
        out.append(
            DiscordChannelEntry(
                id=cid,
                name=ch.get("name"),
                type=int(ch.get("type", 0)),
                parent_id=(str(ch["parent_id"]) if ch.get("parent_id") else None),
                position=ch.get("position"),
                topic=ch.get("topic"),
                nsfw=bool(ch.get("nsfw", False)),
            )
        )
    # Stable order: by position if present, else by id.
    out.sort(key=lambda c: (c.position if c.position is not None else 1 << 30, c.id))
    return DiscordChannelsResponse(channels=out, limited_by_discord=False)


@router.get("/channels/{channel_id}/messages", response_model=DiscordMessagesResponse)
async def user_discord_channel_messages(
    channel_id: str,
    limit: int = Query(default=50, ge=1, le=100),
    before: str | None = Query(default=None),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> DiscordMessagesResponse:
    """Return recent messages in a channel using the captured session
    token. ``limited_by_discord`` is returned on token unavailability.
    """
    oauth_row = await get_oauth_row_or_none(user_id, db)
    if oauth_row is None:
        raise HTTPException(401, "Not signed in to Discord")

    token = await _captured_session_token(user_id)
    if not token:
        return DiscordMessagesResponse(messages=[], limited_by_discord=True)

    params = f"?limit={limit}"
    if before:
        params += f"&before={before}"
    resp = await _discord_raw_get(token, f"/channels/{channel_id}/messages{params}")
    if resp.status_code == 401:
        return DiscordMessagesResponse(messages=[], limited_by_discord=True)
    if resp.status_code == 429:
        retry = resp.headers.get("retry-after", "?")
        raise HTTPException(429, f"Discord rate-limited; retry in {retry}s")
    if resp.status_code != 200:
        raise HTTPException(
            502,
            f"Discord /channels/{channel_id}/messages: {resp.status_code} {resp.text[:200]}",
        )

    out: list[DiscordMessageEntry] = []
    for m in resp.json() or []:
        author = m.get("author") or {}
        out.append(
            DiscordMessageEntry(
                id=str(m.get("id") or ""),
                channel_id=str(m.get("channel_id") or channel_id),
                content=str(m.get("content") or ""),
                timestamp=str(m.get("timestamp") or ""),
                edited_timestamp=(
                    str(m["edited_timestamp"])
                    if m.get("edited_timestamp")
                    else None
                ),
                author=DiscordMessageAuthor(
                    id=str(author.get("id") or ""),
                    username=str(author.get("username") or ""),
                    global_name=author.get("global_name"),
                    avatar=author.get("avatar"),
                ),
            )
        )
    # Discord returns newest-first; flip so the UI renders oldest→newest
    # without re-sorting, matching the chat view's natural timeline.
    out.reverse()
    return DiscordMessagesResponse(messages=out, limited_by_discord=False)


class SendMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


@router.post("/channels/{channel_id}/messages", status_code=201)
async def user_discord_channel_send(
    channel_id: str,
    body: SendMessageRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """POST a message. Same captured-session-token requirement as reads;
    without it returns 503 with a user-friendly message rather than 500.
    """
    oauth_row = await get_oauth_row_or_none(user_id, db)
    if oauth_row is None:
        raise HTTPException(401, "Not signed in to Discord")

    token = await _captured_session_token(user_id)
    if not token:
        raise HTTPException(
            503,
            "Sending to Discord requires the captured-session bridge to be "
            "configured. See docs/bridges for setup.",
        )

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://discord.com/api/channels/{channel_id}/messages",
            headers={
                "Authorization": token,
                "Content-Type": "application/json",
            },
            json={"content": body.content},
        )
    if resp.status_code == 401:
        raise HTTPException(
            401,
            "Captured Discord session is invalid; reconnect via the bridge.",
        )
    if resp.status_code == 429:
        retry = resp.headers.get("retry-after", "?")
        raise HTTPException(429, f"Discord rate-limited; retry in {retry}s")
    if resp.status_code not in (200, 201):
        raise HTTPException(
            502,
            f"Discord /channels/{channel_id}/messages: {resp.status_code} {resp.text[:200]}",
        )
    return resp.json()
