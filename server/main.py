import logging
import os
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Configure root logging once at import time so all module-level
# `logger = logging.getLogger(__name__)` calls actually emit. Without this,
# Python's root logger defaults to WARNING and silently drops all info-level
# diagnostics (e.g. the create_channel auto-invite trace).
logging.basicConfig(
    level=os.getenv("CONCORD_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)

from database import async_session, init_db
from errors import ConcordError, ErrorResponse
from routers import servers, invites, registration, voice, soundboard, webhooks, admin, admin_bridges, admin_discord_voice, direct_invites, stats, totp, moderation, preview, media, dms, nodes, explore, wellknown, extensions, rooms, service_node
from services.discord_voice_config import write_voice_bridge_rooms


def _bootstrap_tuwunel_config() -> None:
    """Ensure /etc/concord-config/tuwunel.toml exists at runtime.

    The committed repo ships ``tuwunel.toml.template`` (federation defaults
    only — never tokens). The live ``tuwunel.toml`` is gitignored and
    rewritten by the admin UI whenever bridges are enabled/disabled or
    federation settings change. On fresh installs or when the live file
    has been manually removed, we seed it from the template so conduwuit
    has something to read at startup.

    Historic bug reference: commit fd221f3 committed a live tuwunel.toml
    with real appservice tokens into the repo. Splitting the committed
    baseline from the runtime file prevents that from happening again —
    the committed .template has no [appservice] section, and the admin
    flow only writes to the (gitignored) runtime file.
    """
    import shutil
    from pathlib import Path

    live = Path("/etc/concord-config/tuwunel.toml")
    template = Path("/etc/concord-config/tuwunel.toml.template")

    if live.exists():
        return
    if not template.exists():
        # Neither exists. Don't guess — let conduwuit fail loudly so the
        # operator knows the config mount is wrong.
        return
    shutil.copy(template, live)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _bootstrap_tuwunel_config()
    await init_db()

    # Migrate existing tables: add new columns if missing
    from database import engine
    from sqlalchemy import text, inspect as sa_inspect

    async with engine.begin() as conn:
        def _migrate(connection):
            insp = sa_inspect(connection)

            # Server: add visibility, abbreviation
            server_cols = {c["name"] for c in insp.get_columns("servers")}
            if "visibility" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN visibility VARCHAR DEFAULT 'private'"
                ))
            if "abbreviation" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN abbreviation VARCHAR(3)"
                ))

            # ServerMember: add display_name
            member_cols = {c["name"] for c in insp.get_columns("server_members")}
            if "display_name" not in member_cols:
                connection.execute(text(
                    "ALTER TABLE server_members ADD COLUMN display_name VARCHAR"
                ))

            # InviteToken: add permanent flag
            invite_cols = {c["name"] for c in insp.get_columns("invite_tokens")}
            if "permanent" not in invite_cols:
                connection.execute(text(
                    "ALTER TABLE invite_tokens ADD COLUMN permanent BOOLEAN DEFAULT 0"
                ))

            # Webhooks table
            if not insp.has_table("webhooks"):
                connection.execute(text("""
                    CREATE TABLE webhooks (
                        id VARCHAR PRIMARY KEY,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        channel_id INTEGER NOT NULL REFERENCES channels(id),
                        name VARCHAR NOT NULL,
                        created_by VARCHAR NOT NULL,
                        enabled BOOLEAN DEFAULT 1,
                        created_at DATETIME
                    )
                """))

            # Direct invites table
            if not insp.has_table("direct_invites"):
                connection.execute(text("""
                    CREATE TABLE direct_invites (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        inviter_id VARCHAR NOT NULL,
                        invitee_id VARCHAR NOT NULL,
                        status VARCHAR DEFAULT 'pending',
                        created_at DATETIME
                    )
                """))

            # Voice sessions table
            if not insp.has_table("voice_sessions"):
                connection.execute(text("""
                    CREATE TABLE voice_sessions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id VARCHAR NOT NULL,
                        channel_id VARCHAR NOT NULL,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        started_at DATETIME NOT NULL,
                        ended_at DATETIME,
                        duration_seconds INTEGER
                    )
                """))

            # Discord voice bridge mappings table
            if not insp.has_table("discord_voice_bridges"):
                connection.execute(text("""
                    CREATE TABLE discord_voice_bridges (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        channel_id INTEGER NOT NULL REFERENCES channels(id),
                        matrix_room_id VARCHAR NOT NULL UNIQUE,
                        discord_guild_id VARCHAR NOT NULL,
                        discord_channel_id VARCHAR NOT NULL,
                        enabled BOOLEAN DEFAULT 1,
                        created_by VARCHAR NOT NULL,
                        created_at DATETIME
                    )
                """))

            # Discord voice bridge: W4 video columns
            voice_bridge_cols = {c["name"] for c in insp.get_columns("discord_voice_bridges")} if insp.has_table("discord_voice_bridges") else set()
            if "video_enabled" not in voice_bridge_cols:
                connection.execute(text(
                    "ALTER TABLE discord_voice_bridges ADD COLUMN video_enabled BOOLEAN DEFAULT 0"
                ))
            if "projection_policy" not in voice_bridge_cols:
                connection.execute(text(
                    "ALTER TABLE discord_voice_bridges ADD COLUMN projection_policy VARCHAR DEFAULT 'screen_share_first'"
                ))
            if "quality_cap" not in voice_bridge_cols:
                connection.execute(text(
                    "ALTER TABLE discord_voice_bridges ADD COLUMN quality_cap VARCHAR DEFAULT 'auto'"
                ))
            if "audio_only_fallback" not in voice_bridge_cols:
                connection.execute(text(
                    "ALTER TABLE discord_voice_bridges ADD COLUMN audio_only_fallback BOOLEAN DEFAULT 1"
                ))

            # Message counts table
            if not insp.has_table("message_counts"):
                connection.execute(text("""
                    CREATE TABLE message_counts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id VARCHAR NOT NULL,
                        channel_id VARCHAR NOT NULL,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        day VARCHAR NOT NULL,
                        count INTEGER DEFAULT 0,
                        UNIQUE(user_id, channel_id, day)
                    )
                """))

            # Server: add kick/ban settings
            if "kick_limit" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN kick_limit INTEGER DEFAULT 3"
                ))
            if "kick_window_minutes" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN kick_window_minutes INTEGER DEFAULT 30"
                ))
            if "ban_mode" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN ban_mode VARCHAR DEFAULT 'soft'"
                ))
            if "media_uploads_enabled" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN media_uploads_enabled BOOLEAN DEFAULT 1"
                ))

            # ServerMember: add can_kick, can_ban permissions
            if "can_kick" not in member_cols:
                connection.execute(text(
                    "ALTER TABLE server_members ADD COLUMN can_kick BOOLEAN DEFAULT 0"
                ))
            if "can_ban" not in member_cols:
                connection.execute(text(
                    "ALTER TABLE server_members ADD COLUMN can_ban BOOLEAN DEFAULT 0"
                ))

            # Channel locks table
            if not insp.has_table("channel_locks"):
                connection.execute(text("""
                    CREATE TABLE channel_locks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        channel_id INTEGER NOT NULL UNIQUE REFERENCES channels(id),
                        pin_hash VARCHAR NOT NULL,
                        locked_by VARCHAR NOT NULL,
                        created_at DATETIME
                    )
                """))

            # Vote kicks table
            if not insp.has_table("vote_kicks"):
                connection.execute(text("""
                    CREATE TABLE vote_kicks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        channel_id VARCHAR NOT NULL,
                        target_user_id VARCHAR NOT NULL,
                        initiated_by VARCHAR NOT NULL,
                        votes_yes VARCHAR DEFAULT '',
                        votes_no VARCHAR DEFAULT '',
                        total_eligible INTEGER DEFAULT 0,
                        status VARCHAR DEFAULT 'active',
                        created_at DATETIME
                    )
                """))

            # Kick records table
            if not insp.has_table("kick_records"):
                connection.execute(text("""
                    CREATE TABLE kick_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        user_id VARCHAR NOT NULL,
                        kicked_by VARCHAR NOT NULL,
                        reason VARCHAR,
                        created_at DATETIME
                    )
                """))

            # IP bans table
            if not insp.has_table("ip_bans"):
                connection.execute(text("""
                    CREATE TABLE ip_bans (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ip_address VARCHAR NOT NULL,
                        user_id VARCHAR NOT NULL,
                        server_id VARCHAR NOT NULL REFERENCES servers(id),
                        banned_by VARCHAR NOT NULL,
                        reason VARCHAR,
                        created_at DATETIME
                    )
                """))

            # User TOTP table
            if not insp.has_table("user_totp"):
                connection.execute(text("""
                    CREATE TABLE user_totp (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id VARCHAR NOT NULL UNIQUE,
                        secret VARCHAR NOT NULL,
                        enabled BOOLEAN DEFAULT 0,
                        created_at DATETIME
                    )
                """))

            # Bug reports table
            if not insp.has_table("bug_reports"):
                connection.execute(text("""
                    CREATE TABLE bug_reports (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        reported_by VARCHAR NOT NULL,
                        title VARCHAR NOT NULL,
                        description VARCHAR NOT NULL,
                        system_info VARCHAR,
                        status VARCHAR DEFAULT 'open',
                        admin_notes VARCHAR,
                        created_at DATETIME,
                        updated_at DATETIME
                    )
                """))

            # SoundboardClip: add keybind
            clip_cols = {c["name"] for c in insp.get_columns("soundboard_clips")}
            if "keybind" not in clip_cols:
                connection.execute(text(
                    "ALTER TABLE soundboard_clips ADD COLUMN keybind VARCHAR"
                ))

            # DM conversations table
            if not insp.has_table("dm_conversations"):
                connection.execute(text("""
                    CREATE TABLE dm_conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_a VARCHAR NOT NULL,
                        user_b VARCHAR NOT NULL,
                        matrix_room_id VARCHAR NOT NULL UNIQUE,
                        created_at DATETIME,
                        UNIQUE(user_a, user_b)
                    )
                """))

            # Server: previous_place_id (re-mint chain) and bans_disposables
            if "previous_place_id" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN previous_place_id VARCHAR REFERENCES servers(id)"
                ))
            if "bans_disposables" not in server_cols:
                connection.execute(text(
                    "ALTER TABLE servers ADD COLUMN bans_disposables BOOLEAN DEFAULT 0"
                ))

            # Disposable anonymous nodes table
            if not insp.has_table("disposable_nodes"):
                connection.execute(text("""
                    CREATE TABLE disposable_nodes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_token VARCHAR NOT NULL UNIQUE,
                        temp_identifier VARCHAR NOT NULL,
                        is_disposable BOOLEAN DEFAULT 1,
                        must_contribute_compute BOOLEAN DEFAULT 1,
                        created_at DATETIME,
                        expires_at DATETIME,
                        revoked BOOLEAN DEFAULT 0
                    )
                """))

            # Place ledger headers table (re-mint snapshots)
            if not insp.has_table("place_ledger_headers"):
                connection.execute(text("""
                    CREATE TABLE place_ledger_headers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        new_place_id VARCHAR NOT NULL REFERENCES servers(id),
                        previous_place_id VARCHAR NOT NULL,
                        encrypted BOOLEAN DEFAULT 0,
                        payload VARCHAR NOT NULL,
                        created_at DATETIME
                    )
                """))

        await conn.run_sync(_migrate)

    # Rebuild the Discord voice sidecar config from the DB on every API
    # startup so the runtime file cannot stay stale after a crash,
    # manual DB edit, or a prior failed admin flow.
    async with async_session() as db:
        await write_voice_bridge_rooms(db)

    # Initialize bot user for webhook message delivery
    from services.bot import init_bot
    try:
        await init_bot()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Bot init failed (webhooks will not work): %s", e)

    # Seed default public server on first run
    try:
        await _seed_default_server()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Default server seed failed: %s", e)

    # One-time: add #welcome channel and post guide to existing lobbies
    try:
        await _ensure_lobby_welcome()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Lobby welcome setup failed: %s", e)

    extensions.init_catalog()

    yield


LOBBY_WELCOME_POST_VERSION = 2


def build_lobby_welcome_message(instance_name: str) -> str:
    return (
        f"# Welcome to {instance_name}\n"
        "\n"
        "> The Lobby is the shared front door. Everyone starts here. Everything else is opt-in.\n"
        "\n"
        "## Start here\n"
        "\n"
        "1. Say hello in **#general** or introduce yourself in **#introductions**.\n"
        "2. Open **Explore** to browse public Concord servers and available sources.\n"
        "3. Join **Hangout** if you want a live voice room right away.\n"
        "\n"
        "## Build your own space\n"
        "\n"
        "- Use the `+` tile in the server rail to create a server.\n"
        "- Add **text** and **voice** channels from the channel list.\n"
        "- Make a server public only if you want it discoverable in Explore.\n"
        "\n"
        "## Invite flow\n"
        "\n"
        "- Generate invite links from the server header.\n"
        "- Choose an expiration, max uses, or make the invite permanent.\n"
        "- People can open that link and join directly after signup or login.\n"
        "\n"
        "## Settings map\n"
        "\n"
        "| Area | What it controls |\n"
        "| --- | --- |\n"
        "| User settings | Profile, audio, appearance, notifications, security |\n"
        "| Server settings | Roles, moderation, visibility, invites |\n"
        "| Voice bar | Mute, deafen, reconnect, device status |\n"
        "\n"
        "## Markdown quick demo\n"
        "\n"
        "- **Bold** for emphasis\n"
        "- `inline code` for names and commands\n"
        "- block quotes for callouts\n"
        "- tables for compact reference\n"
        "\n"
        "## Need help?\n"
        "\n"
        "Post in **#general** with what device, browser, and room you were using when something broke.\n"
    )


async def _seed_default_server():
    """Create a default public lobby server on first startup."""
    import json
    import logging
    from datetime import datetime, timezone
    from config import INSTANCE_SETTINGS_FILE, INSTANCE_NAME_DEFAULT
    from services.bot import BOT_ACCESS_TOKEN, BOT_USER_ID
    from services.matrix_admin import create_matrix_room
    from database import async_session
    from models import Server, Channel, ServerMember

    logger = logging.getLogger(__name__)

    # Check if already seeded
    settings: dict = {}
    if INSTANCE_SETTINGS_FILE.exists():
        settings = json.loads(INSTANCE_SETTINGS_FILE.read_text())
    if settings.get("default_server_seeded"):
        return

    if not BOT_ACCESS_TOKEN:
        logger.warning("Cannot seed default server: bot not initialized")
        return

    instance_name = settings.get("name", INSTANCE_NAME_DEFAULT)
    server_name = f"{instance_name} Lobby"

    # Define the pre-created channels
    channel_defs = [
        ("welcome", "text"),
        ("general", "text"),
        ("off-topic", "text"),
        ("introductions", "text"),
        ("media-sharing", "text"),
        ("hangout", "voice"),
        ("music-lounge", "voice"),
    ]

    general_room_id = None

    async with async_session() as db:
        # Create server record
        server = Server(
            name=server_name,
            owner_id=BOT_USER_ID,
            visibility="public",
            abbreviation="LOB",
        )
        db.add(server)
        await db.flush()

        # Bot is owner
        db.add(ServerMember(server_id=server.id, user_id=BOT_USER_ID, role="owner"))

        # Create Matrix rooms and channel records
        for position, (ch_name, ch_type) in enumerate(channel_defs):
            room_id = await create_matrix_room(
                BOT_ACCESS_TOKEN, f"{server_name} - {ch_name}"
            )
            db.add(Channel(
                server_id=server.id,
                matrix_room_id=room_id,
                name=ch_name,
                channel_type=ch_type,
                position=position,
            ))
            if ch_name == "welcome":
                general_room_id = room_id

        await db.commit()

        # Save the default server ID and mark as seeded
        settings["default_server_id"] = server.id
        settings["default_server_seeded"] = True
        INSTANCE_SETTINGS_FILE.write_text(json.dumps(settings, indent=2))

        logger.info("Default server '%s' created with ID %s", server_name, server.id)

    # Post welcome guide in the welcome channel
    if general_room_id:
        try:
            from services.bot import bot_send_message
            await bot_send_message(general_room_id, {
                "msgtype": "m.text",
                "body": build_lobby_welcome_message(instance_name),
            })
            settings["welcome_posted"] = True
            settings["welcome_post_version"] = LOBBY_WELCOME_POST_VERSION
            INSTANCE_SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
            logger.info("Welcome message posted to lobby #welcome")
        except Exception as e:
            logger.warning("Failed to post welcome message: %s", e)


async def _ensure_lobby_welcome():
    """For already-seeded instances: add a #welcome channel if missing and post the guide."""
    import json
    import logging
    from config import INSTANCE_SETTINGS_FILE, INSTANCE_NAME_DEFAULT
    from sqlalchemy import select
    from services.bot import BOT_ACCESS_TOKEN
    from services.matrix_admin import create_matrix_room
    from services.bot import bot_send_message
    from database import async_session
    from models import Server, Channel

    logger = logging.getLogger(__name__)

    if not INSTANCE_SETTINGS_FILE.exists():
        return
    settings = json.loads(INSTANCE_SETTINGS_FILE.read_text())
    if settings.get("welcome_post_version", 0) >= LOBBY_WELCOME_POST_VERSION:
        return
    default_id = settings.get("default_server_id")
    if not default_id or not BOT_ACCESS_TOKEN:
        return

    instance_name = settings.get("name", INSTANCE_NAME_DEFAULT)

    async with async_session() as db:
        server = await db.get(Server, default_id)
        if not server:
            return

        # Check if #welcome channel already exists
        result = await db.execute(
            select(Channel).where(
                Channel.server_id == default_id,
                Channel.name == "welcome",
            )
        )
        welcome_ch = result.scalar_one_or_none()

        if not welcome_ch:
            # Create #welcome as position 0, shift others
            existing_channels = await db.execute(
                select(Channel).where(Channel.server_id == default_id).order_by(Channel.position)
            )
            for ch in existing_channels.scalars().all():
                ch.position += 1

            room_id = await create_matrix_room(
                BOT_ACCESS_TOKEN, f"{server.name} - welcome"
            )
            welcome_ch = Channel(
                server_id=default_id,
                matrix_room_id=room_id,
                name="welcome",
                channel_type="text",
                position=0,
            )
            db.add(welcome_ch)
            await db.commit()
            logger.info("Created #welcome channel in lobby")

        # Post the welcome message
        await bot_send_message(welcome_ch.matrix_room_id, {
            "msgtype": "m.text",
            "body": build_lobby_welcome_message(instance_name),
        })

        settings["welcome_posted"] = True
        settings["welcome_post_version"] = LOBBY_WELCOME_POST_VERSION
        INSTANCE_SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
        logger.info("Welcome message posted to lobby #welcome")


app = FastAPI(title="Concord API", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Structured exception handler (commercial-profile error contract)
# ---------------------------------------------------------------------------
#
# Every endpoint that raises ConcordError gets converted into a stable
# ErrorResponse JSON body. This is the machine-readable contract clients
# branch on. The full traceback is logged server-side via the standard
# logging module — never returned to the client.

_error_logger = logging.getLogger("concord.errors")


@app.exception_handler(ConcordError)
async def _concord_error_handler(request: Request, exc: ConcordError) -> JSONResponse:
    # Log the structured error with the path so operators can correlate
    # client-reported error_codes to server-side context. We do NOT log a
    # traceback here because ConcordError is an expected, classified
    # condition — not an unhandled crash.
    _error_logger.info(
        "ConcordError %s on %s %s: %s",
        exc.error_code, request.method, request.url.path, exc.message,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_response().model_dump(),
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Anything that wasn't explicitly classified bubbles to here. Log the
    # FULL traceback server-side, return only a generic safe message to
    # the client. This is the stack-trace-leakage guard required by the
    # commercial profile.
    #
    # FastAPI's built-in HTTPException handler is more specific in the
    # Starlette exception-handler MRO lookup, so HTTPException never
    # reaches this branch — only truly unhandled exceptions do.
    _error_logger.error(
        "Unhandled %s on %s %s\n%s",
        type(exc).__name__,
        request.method,
        request.url.path,
        traceback.format_exc(),
    )
    safe_response = ErrorResponse(
        error_code="INTERNAL_ERROR",
        message="An internal error occurred. The server logs have details.",
        details=None,
    )
    return JSONResponse(status_code=500, content=safe_response.model_dump())

# Default CORS origins for local development only. Operators deploying
# this as a generic application MUST set `CORS_ORIGINS` in the .env file
# to add their public domain(s). Hardcoding an instance-specific host
# here would leak that host into every distributed copy of the source.
_default_origins = (
    "http://localhost:5173,"
    "http://localhost:8080,"
    # Native Tauri v2 mobile clients load from these custom schemes.
    "tauri://localhost,"         # Tauri v2 iOS WKWebView origin
    "http://tauri.localhost,"    # Tauri v2 Android WebView origin
    "https://tauri.localhost"    # Tauri v2 desktop WebView origin
)
allowed_origins = os.getenv("CORS_ORIGINS", _default_origins).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(servers.router)
app.include_router(invites.router)
app.include_router(registration.router)
app.include_router(voice.router)
app.include_router(soundboard.router)
app.include_router(webhooks.router)
app.include_router(admin.router)
app.include_router(admin_bridges.router)
app.include_router(admin_discord_voice.router)
app.include_router(direct_invites.router)
app.include_router(stats.router)
app.include_router(totp.router)
app.include_router(moderation.router)
app.include_router(preview.router)
app.include_router(media.router)
app.include_router(dms.router)
app.include_router(nodes.router)
app.include_router(explore.router)
app.include_router(wellknown.router)
app.include_router(extensions.router)
app.include_router(rooms.router)
app.include_router(service_node.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
