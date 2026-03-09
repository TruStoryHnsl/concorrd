import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import init_db
from routers import servers, invites, registration, voice, soundboard, webhooks, admin, direct_invites


@asynccontextmanager
async def lifespan(app: FastAPI):
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

        await conn.run_sync(_migrate)

    # Initialize bot user for webhook message delivery
    from services.bot import init_bot
    try:
        await init_bot()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Bot init failed (webhooks will not work): %s", e)

    yield


app = FastAPI(title="Concord API", lifespan=lifespan)

_default_origins = "http://localhost:5173,http://localhost:8080"
allowed_origins = os.getenv("CORS_ORIGINS", _default_origins).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins],
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
app.include_router(direct_invites.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
