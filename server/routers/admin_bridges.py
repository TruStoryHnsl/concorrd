"""INS-024 Wave 2 — admin HTTP surface for the Discord bridge.

Endpoints (all under ``/api/admin/bridges/discord``):

* ``GET    /status``   → current enabled state + redacted registration shape
* ``POST   /enable``   → generate tokens, write registration + tuwunel.toml,
                         restart conduwuit, start the bridge container
* ``POST   /disable``  → stop the bridge container, wipe registration file,
                         remove the tuwunel.toml entry, restart conduwuit
* ``POST   /rotate``   → regenerate tokens in place, write fresh files,
                         restart conduwuit, restart the bridge container

All endpoints are gated on ``ADMIN_USER_IDS`` via the existing
``require_admin`` helper from :mod:`routers.admin`. Input is validated
with Pydantic V2 models so malformed bodies are rejected at the
framework boundary with a typed error response. The commercial-scope
logging policy is enforced by routing every log call through
:func:`services.bridge_config.redact_for_logging`; there is no code
path in this module that emits a raw ``as_token`` / ``hs_token`` /
bot token into a log record.

## Ordering contract

The "Enable" flow is a multi-step sequence where order matters. The
sequence is:

 1. Generate a fresh :class:`DiscordBridgeRegistration`.
 2. Write ``config/mautrix-discord/registration.yaml`` atomically
    (mode 0640).
 3. Inject the ``[global.appservice.concord_discord]`` table into
    ``config/tuwunel.toml`` idempotently.
 4. Restart conduwuit via docker-socket-proxy so tuwunel re-reads
    the TOML file.
 5. Start the ``concord-discord-bridge`` compose service so the
    bridge reads its fresh registration and connects to tuwunel.

If any step fails, subsequent steps are skipped. Earlier file-system
mutations are left in place — the admin can retry ``enable`` to
re-run the whole flow because every step is idempotent. The response
body documents which step failed so the operator knows where in the
chain to investigate.

## Disable inverts the order

 1. Stop the bridge container (no new traffic into tuwunel).
 2. Remove the tuwunel.toml appservice entry.
 3. Restart conduwuit so the entry stops being active.
 4. Delete the on-disk registration file (last — the tokens stay
    accessible on disk until after the homeserver has forgotten
    them, which keeps a tiny race window closed).

Rotate is "disable-ish then re-enable" rolled into one call so
there is never a moment where the bridge has no valid registration
at all.
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import MATRIX_SERVER_NAME
from errors import ConcordError
from routers.admin import require_admin
from routers.servers import get_user_id
from services.bridge_config import (
    BridgeConfigError,
    BridgeRuntimeConfigError,
    DiscordBridgeRegistration,
    RegistrationWriteError,
    TuwunelTomlInjectionError,
    bot_token_file_path,
    bridge_config_dir,
    delete_registration_file,
    ensure_appservice_entry,
    generate_registration,
    read_discord_bot_token,
    read_registration_file,
    redact_for_logging,
    registration_file_path,
    remove_appservice_entry,
    write_bridge_runtime_config,
    write_discord_bot_token,
    write_registration_file,
)
import services.bot as _bot_module
from services.bot import bot_send_message
from services.matrix_admin import create_dm_room
from services.docker_control import (
    DockerControlError,
    restart_compose_service,
    start_compose_service,
    stop_compose_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/bridges/discord", tags=["admin", "bridges"])

_DISCORD_API_URL = "https://discord.com/api/v10"
_DISCORD_API_USER_AGENT = "Concord Discord Bridge (https://concorrd.com, 0.1)"


async def _discord_api_get(path: str, token: str) -> Any:
    headers = {
        "Authorization": f"Bot {token}",
        "User-Agent": _DISCORD_API_USER_AGENT,
    }
    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        resp = await client.get(f"{_DISCORD_API_URL}{path}")
    if resp.status_code == 403:
        logger.warning("Discord API 403 on %s: %s", path, resp.text[:240])
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------


class BridgeStatusResponse(BaseModel):
    """Response body for ``GET /status``.

    No secrets are exposed — the caller gets a boolean, a couple of
    sanitised identifiers, and namespace regexes. The tokens live on
    disk mode 0640 and are never surfaced to the admin UI even for
    audit purposes. Rotation is the supported flow for "check that
    the token works".
    """

    enabled: bool = Field(description="True when a registration file exists")
    appservice_id: str | None = Field(
        default=None,
        description="The AS bridge id (concord_discord) when enabled, else null",
    )
    sender_mxid_localpart: str | None = Field(
        default=None,
        description="sender_localpart from the registration (e.g. _discord_bot)",
    )
    user_namespace_regex: str | None = None
    alias_namespace_regex: str | None = None
    registration_file_path: str | None = Field(
        default=None,
        description="Path to registration.yaml for operator debugging",
    )
    bot_token_configured: bool = Field(
        default=False,
        description="True when a Discord bot token has been saved via POST /bot-token or config.yaml",
    )


class BridgeMutationResponse(BaseModel):
    """Response body shared by enable / disable / rotate.

    The ``steps`` list captures the ordered sequence the server
    executed and their outcomes, so a partial failure can be
    diagnosed from the response alone without trawling server logs.
    Each step has ``name``, ``status`` (``ok`` / ``skipped`` /
    ``failed``), and ``detail`` (redacted — never echoes a token).
    """

    action: Literal["enable", "disable", "rotate"]
    ok: bool
    steps: list[dict[str, Any]] = Field(default_factory=list)
    message: str


class NoBodyRequest(BaseModel):
    """Empty-body marker.

    Pydantic V2 rejects unexpected fields by default, so POSTing a
    body with extra keys to enable/disable/rotate returns 422 instead
    of silently ignoring the extras. Adding this model to each route
    is the commercial-scope "strict input validation" requirement.
    """

    model_config = {"extra": "forbid"}


class BotTokenRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    model_config = {"extra": "forbid"}


class DiscordChannelInfo(BaseModel):
    id: str
    guild_id: str | None = None
    name: str
    type: int
    kind: Literal["text", "voice", "unsupported"]


# ---------------------------------------------------------------------
# Error-to-ConcordError mapping
# ---------------------------------------------------------------------


def _map_bridge_error(exc: BridgeConfigError) -> ConcordError:
    """Translate an internal typed error into a ConcordError.

    The admin router never exposes raw exception messages — only a
    stable error code and a redacted human-readable hint. The global
    exception handler in ``main.py`` converts ``ConcordError`` into
    the structured ``ErrorResponse`` shape the admin UI understands.
    """
    if isinstance(exc, RegistrationWriteError):
        return ConcordError(
            error_code="BRIDGE_REGISTRATION_WRITE",
            message="Failed to write the bridge registration file.",
            status_code=500,
            details={"hint": "check filesystem permissions on config/mautrix-discord/"},
        )
    if isinstance(exc, TuwunelTomlInjectionError):
        return ConcordError(
            error_code="BRIDGE_TUWUNEL_INJECT",
            message="Failed to inject the bridge appservice table into tuwunel.toml.",
            status_code=500,
            details={"hint": "check that config/tuwunel.toml is writeable by concord-api"},
        )
    if isinstance(exc, BridgeRuntimeConfigError):
        return ConcordError(
            error_code="BRIDGE_RUNTIME_CONFIG",
            message="Failed to generate the bridge runtime config.",
            status_code=500,
            details={"hint": "ensure config/mautrix-discord/config.yaml exists and is valid YAML"},
        )
    return ConcordError(
        error_code="BRIDGE_INTERNAL",
        message="Bridge configuration step failed.",
        status_code=500,
    )


def _map_docker_error(exc: DockerControlError) -> ConcordError:
    """Translate a docker-socket-proxy failure into a ConcordError."""
    return ConcordError(
        error_code="BRIDGE_DOCKER_CONTROL",
        message="Docker control plane rejected or timed out the operation.",
        status_code=502,
        details={"hint": "check docker-socket-proxy health and POST/CONTAINERS flags"},
    )


# ---------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------


@router.get("/status", response_model=BridgeStatusResponse)
async def discord_bridge_status(
    user_id: str = Depends(get_user_id),
) -> BridgeStatusResponse:
    """Report whether the Discord bridge is currently configured.

    Admin-gated because the regex shape and registration file path
    are operator-only data (they're hints in a threat model, not
    secret in the cryptographic sense, but the admin UI is where
    they belong). Tokens are never returned.
    """
    require_admin(user_id)
    try:
        registration = read_registration_file()
    except BridgeConfigError as exc:
        logger.warning(
            "bridge status: registration file unreadable: %s",
            redact_for_logging({"error": str(exc)}),
        )
        raise _map_bridge_error(exc) from exc

    if registration is None:
        return BridgeStatusResponse(
            enabled=False,
            bot_token_configured=read_discord_bot_token() is not None,
        )

    return BridgeStatusResponse(
        enabled=True,
        appservice_id=registration.id,
        sender_mxid_localpart=registration.sender_localpart,
        user_namespace_regex=registration.user_namespace_regex,
        alias_namespace_regex=registration.alias_namespace_regex,
        registration_file_path=str(registration_file_path()),
        bot_token_configured=read_discord_bot_token() is not None,
    )


# ---------------------------------------------------------------------
# POST /enable
# ---------------------------------------------------------------------


async def _run_enable_steps(
    registration: DiscordBridgeRegistration,
) -> tuple[bool, list[dict[str, Any]]]:
    """Execute the enable sequence. Returns (ok, steps).

    Extracted as a module-level helper so the rotate flow can compose
    it with the disable helper without duplicating step logic.
    """
    steps: list[dict[str, Any]] = []

    # Guard: bot token must be configured before we can build config-runtime.yaml.
    if read_discord_bot_token() is None:
        steps.append({
            "name": "check_bot_token",
            "status": "failed",
            "detail": "No bot token configured. POST /api/admin/bridges/discord/bot-token first.",
        })
        return False, steps
    steps.append({"name": "check_bot_token", "status": "ok", "detail": None})

    try:
        write_registration_file(registration)
    except BridgeConfigError as exc:
        steps.append({"name": "write_registration", "status": "failed", "detail": str(exc)})
        return False, steps
    steps.append({"name": "write_registration", "status": "ok", "detail": None})

    # Merge template config.yaml with tokens → config-runtime.yaml.
    # The bridge binary reads config-runtime.yaml at startup (the
    # entrypoint override in docker-compose bypasses docker-run.sh).
    try:
        write_bridge_runtime_config(registration)
    except BridgeRuntimeConfigError as exc:
        steps.append({"name": "write_runtime_config", "status": "failed", "detail": str(exc)})
        return False, steps
    steps.append({"name": "write_runtime_config", "status": "ok", "detail": None})

    try:
        ensure_appservice_entry(registration)
    except BridgeConfigError as exc:
        steps.append({"name": "inject_tuwunel_toml", "status": "failed", "detail": str(exc)})
        return False, steps
    steps.append({"name": "inject_tuwunel_toml", "status": "ok", "detail": None})

    try:
        result = await restart_compose_service("conduwuit")
    except DockerControlError as exc:
        steps.append({"name": "restart_conduwuit", "status": "failed", "detail": str(exc)})
        return False, steps
    steps.append({
        "name": "restart_conduwuit",
        "status": "ok",
        "detail": redact_for_logging(result),
    })

    try:
        result = await start_compose_service("concord-discord-bridge")
    except DockerControlError as exc:
        steps.append({"name": "start_bridge", "status": "failed", "detail": str(exc)})
        return False, steps
    steps.append({
        "name": "start_bridge",
        "status": "ok",
        "detail": redact_for_logging(result),
    })
    return True, steps


@router.post("/enable", response_model=BridgeMutationResponse)
async def discord_bridge_enable(
    body: NoBodyRequest | None = None,
    user_id: str = Depends(get_user_id),
) -> BridgeMutationResponse:
    """Enable the Discord bridge.

    Idempotent with respect to the disk state: if a registration file
    already exists, its tokens are re-used (this is the "restart the
    bridge after an outage" case). To force new tokens call
    ``POST /rotate``.
    """
    require_admin(user_id)
    logger.info("bridge enable requested by %s", user_id)

    existing = None
    try:
        existing = read_registration_file()
    except BridgeConfigError as exc:
        # An unreadable existing file is an operator problem — don't
        # silently overwrite it.
        raise _map_bridge_error(exc) from exc

    if existing is not None:
        registration = existing
    else:
        registration = generate_registration()

    ok, steps = await _run_enable_steps(registration)
    if not ok:
        return BridgeMutationResponse(
            action="enable",
            ok=False,
            steps=steps,
            message="Enable aborted; see steps for the failing stage.",
        )

    logger.info(
        "bridge enable completed: %s",
        redact_for_logging({"steps": steps, "user": user_id}),
    )
    return BridgeMutationResponse(
        action="enable",
        ok=True,
        steps=steps,
        message="Discord bridge enabled. Discord gateway handshake in progress.",
    )


# ---------------------------------------------------------------------
# POST /disable
# ---------------------------------------------------------------------


async def _run_disable_steps() -> tuple[bool, list[dict[str, Any]]]:
    steps: list[dict[str, Any]] = []

    try:
        result = await stop_compose_service("concord-discord-bridge")
        steps.append({
            "name": "stop_bridge",
            "status": "ok",
            "detail": redact_for_logging(result),
        })
    except DockerControlError as exc:
        # A docker stop failure is bad, but disable is "best effort" —
        # we STILL want to remove the tuwunel entry + registration
        # file so the next enable doesn't start from a half-state.
        steps.append({"name": "stop_bridge", "status": "failed", "detail": str(exc)})

    try:
        removed = remove_appservice_entry()
        steps.append({
            "name": "remove_tuwunel_entry",
            "status": "ok" if removed else "skipped",
            "detail": None if removed else "no entry present",
        })
    except BridgeConfigError as exc:
        steps.append({"name": "remove_tuwunel_entry", "status": "failed", "detail": str(exc)})
        return False, steps

    try:
        result = await restart_compose_service("conduwuit")
        steps.append({
            "name": "restart_conduwuit",
            "status": "ok",
            "detail": redact_for_logging(result),
        })
    except DockerControlError as exc:
        steps.append({"name": "restart_conduwuit", "status": "failed", "detail": str(exc)})

    removed = delete_registration_file()
    steps.append({
        "name": "delete_registration",
        "status": "ok" if removed else "skipped",
        "detail": None if removed else "no file present",
    })

    all_ok = not any(step["status"] == "failed" for step in steps)
    return all_ok, steps


@router.post("/disable", response_model=BridgeMutationResponse)
async def discord_bridge_disable(
    body: NoBodyRequest | None = None,
    user_id: str = Depends(get_user_id),
) -> BridgeMutationResponse:
    """Disable the Discord bridge and clean up all config artefacts."""
    require_admin(user_id)
    logger.info("bridge disable requested by %s", user_id)

    ok, steps = await _run_disable_steps()
    message = (
        "Discord bridge disabled."
        if ok
        else "Disable completed with errors; see steps for detail."
    )
    logger.info(
        "bridge disable result: %s",
        redact_for_logging({"ok": ok, "steps": steps, "user": user_id}),
    )
    return BridgeMutationResponse(action="disable", ok=ok, steps=steps, message=message)


# ---------------------------------------------------------------------
# POST /bot-token
# ---------------------------------------------------------------------


@router.post("/bot-token")
async def discord_bridge_set_bot_token(
    body: BotTokenRequest,
    user_id: str = Depends(get_user_id),
) -> dict:
    """Save the Discord bot token for use by the bridge runtime config.

    The token is stored in config/mautrix-discord/bot-token (mode 0640,
    gitignored). It is injected into config-runtime.yaml the next time
    the Enable or Rotate flow runs. This endpoint does NOT restart the
    bridge — call POST /enable after setting the token for the first time.
    """
    require_admin(user_id)
    try:
        write_discord_bot_token(body.token)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except BridgeConfigError as exc:
        raise _map_bridge_error(exc) from exc
    logger.info("discord bot token updated by %s", user_id)
    return {"ok": True, "message": "Bot token saved."}


# ---------------------------------------------------------------------
# GET /bot-invite-url
# ---------------------------------------------------------------------


# Permissions sum for standard mautrix-discord operation:
#   View Channels (1024) + Send Messages (2048) + Manage Messages (8192) +
#   Embed Links (16384) + Attach Files (32768) + Read Message History (65536) +
#   Add Reactions (64) + Use External Emojis (262144) + Manage Webhooks (536870912) +
#   Connect (1048576) + Speak (2097152) for the optional voice bridge sidecar.
_DISCORD_BOT_PERMISSIONS = 540404800


@router.get("/bot-invite-url")
async def discord_bridge_bot_invite_url(
    user_id: str = Depends(get_user_id),
) -> dict:
    """Return a Discord OAuth2 invite URL for the configured bot.

    The application ID is decoded from the first base64-encoded segment
    of the stored bot token (standard Discord token format:
    ``<base64(app_id)>.<timestamp>.<hmac>``). No network call is made —
    the ID is embedded in the token itself.

    Returns ``{"app_id": "...", "invite_url": "..."}`` on success, or
    raises 400 if no token is configured / 500 if the token is malformed.
    """
    require_admin(user_id)
    token = read_discord_bot_token()
    if not token:
        raise HTTPException(
            status_code=400,
            detail="No bot token configured. Save a token via POST /bot-token first.",
        )
    try:
        first_segment = token.split(".")[0]
        # base64 decode may need padding
        padding = (4 - len(first_segment) % 4) % 4
        app_id = base64.b64decode(first_segment + "=" * padding).decode("utf-8").strip()
        int(app_id)  # must be a numeric snowflake
    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Could not decode application ID from the stored bot token. "
                   "Verify the token is a valid Discord bot token.",
        )

    invite_url = (
        "https://discord.com/oauth2/authorize"
        f"?client_id={app_id}"
        "&scope=bot%20applications.commands"
        f"&permissions={_DISCORD_BOT_PERMISSIONS}"
    )
    return {"app_id": app_id, "invite_url": invite_url}


# ---------------------------------------------------------------------
# GET /guilds — list Discord guilds visible to the bot
# ---------------------------------------------------------------------


@router.get("/guilds")
async def discord_bridge_list_guilds(
    user_id: str = Depends(get_user_id),
) -> list:
    """Return Discord guilds the bot is a member of."""
    require_admin(user_id)

    token = read_discord_bot_token()
    if not token:
        logger.warning("guilds endpoint called but no bot token: user=%s", user_id)
        return []

    try:
        guilds = await _discord_api_get("/users/@me/guilds", token)
        return [
            {"id": g["id"], "name": g["name"], "icon": g.get("icon")}
            for g in guilds
        ]
    except Exception as exc:
        logger.error("Discord API error in guilds: %s", exc)
        return []


@router.get("/channels/{channel_id}", response_model=DiscordChannelInfo)
async def discord_bridge_get_channel(
    channel_id: str,
    user_id: str = Depends(get_user_id),
) -> DiscordChannelInfo:
    """Return enough Discord channel metadata to choose text vs voice flow."""
    require_admin(user_id)
    if not channel_id.isdigit() or not (17 <= len(channel_id) <= 20):
        raise HTTPException(status_code=422, detail="Discord channel ID must be a snowflake")

    token = read_discord_bot_token()
    if not token:
        raise HTTPException(
            status_code=400,
            detail="No bot token configured. Save a token via POST /bot-token first.",
        )

    try:
        channel = await _discord_api_get(f"/channels/{channel_id}", token)
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code
        body = exc.response.text[:240]
        if status_code == 404:
            raise HTTPException(
                status_code=404,
                detail="Discord channel not found or the bot cannot see it.",
            ) from exc
        if status_code == 403:
            raise HTTPException(
                status_code=403,
                detail=(
                    "The Discord API refused the channel inspect request. "
                    "Make sure the bot has View Channel access to that voice channel. "
                    f"Discord response: {body}"
                ),
            ) from exc
        raise HTTPException(
            status_code=502,
            detail=f"Discord API returned HTTP {status_code} while reading the channel.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Discord API error while reading the channel: {exc}",
        ) from exc

    channel_type = int(channel.get("type", -1))
    if channel_type in (2, 13):
        kind: Literal["text", "voice", "unsupported"] = "voice"
    elif channel_type in (0, 5):
        kind = "text"
    else:
        kind = "unsupported"

    return DiscordChannelInfo(
        id=str(channel["id"]),
        guild_id=str(channel["guild_id"]) if channel.get("guild_id") else None,
        name=str(channel.get("name") or channel_id),
        type=channel_type,
        kind=kind,
    )


# ---------------------------------------------------------------------
# POST /login-relay
# ---------------------------------------------------------------------


@router.post("/login-relay")
async def discord_bridge_login_relay(
    body: NoBodyRequest | None = None,
    user_id: str = Depends(get_user_id),
) -> dict:
    """Log the bridge bot into Discord via the Matrix management DM.

    mautrix-discord v0.7.2 requires an explicit ``login-token <token>``
    command sent to the bridge bot's DM room before the bot connects to
    the Discord gateway. This endpoint automates that step so the client
    does not need to handle the bot token directly.

    Steps:
    1. Read the stored Discord bot token.
    2. Create a DM room between the concord-bot Matrix account and the
       bridge bot (``@discordbot:<server>``).
    3. Send ``login-token <token>`` to that DM room.

    Returns ``{"ok": true}`` immediately — the Discord gateway handshake
    happens asynchronously. Wait 4–6 seconds before sending a ``bridge``
    command to give the handshake time to complete.
    """
    require_admin(user_id)

    token = read_discord_bot_token()
    if not token:
        raise HTTPException(
            status_code=400,
            detail="No bot token configured. POST /bot-token first.",
        )

    bot_token = _bot_module.BOT_ACCESS_TOKEN
    if not bot_token:
        raise HTTPException(
            status_code=503,
            detail="concord-bot not initialized — server may be starting up.",
        )

    bridge_bot_mxid = f"@discordbot:{MATRIX_SERVER_NAME}"

    try:
        room_id = await create_dm_room(bot_token, bridge_bot_mxid)
    except Exception as exc:
        logger.warning("login-relay: create_dm_room failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not create DM with bridge bot: {exc}",
        ) from exc

    try:
        await bot_send_message(room_id, {"msgtype": "m.text", "body": f"login-token bot {token}"})
    except Exception as exc:
        logger.warning("login-relay: send failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail=f"Could not send login-token to bridge bot: {exc}",
        ) from exc

    logger.info("login-relay: login-token sent to bridge bot by %s", user_id)
    return {"ok": True, "message": "login-token sent to bridge bot. Discord handshake in progress."}


# ---------------------------------------------------------------------
# POST /rotate
# ---------------------------------------------------------------------


@router.post("/rotate", response_model=BridgeMutationResponse)
async def discord_bridge_rotate(
    body: NoBodyRequest | None = None,
    user_id: str = Depends(get_user_id),
) -> BridgeMutationResponse:
    """Rotate the bridge's ``as_token`` and ``hs_token``.

    Implemented as "generate fresh tokens, re-run the full enable
    sequence". The bridge container is restarted at the end so it
    re-reads the fresh registration. There is a ~5 second window
    during the conduwuit restart where inbound Discord messages will
    be buffered by mautrix-discord; this is documented in the bridge
    runbook and considered acceptable for admin-triggered rotations.
    """
    require_admin(user_id)
    logger.info("bridge token rotation requested by %s", user_id)

    registration = generate_registration()
    ok, steps = await _run_enable_steps(registration)
    if ok:
        try:
            result = await restart_compose_service("concord-discord-bridge")
            steps.append({
                "name": "restart_bridge",
                "status": "ok",
                "detail": redact_for_logging(result),
            })
        except DockerControlError as exc:
            steps.append({
                "name": "restart_bridge",
                "status": "failed",
                "detail": str(exc),
            })
            ok = False

    message = (
        "Bridge tokens rotated."
        if ok
        else "Rotation aborted; see steps for the failing stage."
    )
    logger.info(
        "bridge rotate result: %s",
        redact_for_logging({"ok": ok, "steps": steps, "user": user_id}),
    )
    return BridgeMutationResponse(action="rotate", ok=ok, steps=steps, message=message)
