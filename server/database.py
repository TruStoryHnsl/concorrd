from sqlalchemy import inspect as sa_inspect, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

from config import DATABASE_URL

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _column_exists(sync_conn, table_name: str, column_name: str) -> bool:
    """Return True iff `table_name.column_name` exists on the live DB.

    Uses SQLAlchemy's database-agnostic inspector so this works on the
    current SQLite deployment AND on Postgres if the project ever
    migrates. `run_sync` gives us a plain `Connection`, which is what
    the inspector needs.
    """
    inspector = sa_inspect(sync_conn)
    if table_name not in inspector.get_table_names():
        # Table doesn't exist yet — create_all will produce it with
        # the column built in, no migration needed.
        return True
    return any(
        col["name"] == column_name
        for col in inspector.get_columns(table_name)
    )


async def _lightweight_migrations():
    """Apply the small set of in-place column additions that don't
    warrant dragging Alembic into the project.

    The project uses `Base.metadata.create_all()` for its schema, which
    creates missing tables but does NOT alter existing ones. When we
    add a new column to an existing model, pre-existing deployments
    need the column added manually — that's what this helper does.

    Every migration here must be idempotent and backward-compatible:
    re-running the startup sequence against an already-migrated DB
    must be a no-op, and rolling back to the prior version of the
    code must not corrupt the DB (new columns are NULLable so old
    code that doesn't know about them keeps working).

    Add new migrations by extending the list below — each entry is a
    (table, column, ALTER fragment) tuple, applied only if the column
    is missing.
    """
    migrations = [
        # INS-028: GitHub issue number on bug reports (introduced 2026-04-09).
        ("bug_reports", "github_issue_number", "INTEGER"),
        # Server rules text field (introduced 2026-04-15).
        ("servers", "rules_text", "TEXT"),
        # INS-053: Per-server user channel creation flag (introduced 2026-04-17).
        ("servers", "allow_user_channel_creation", "BOOLEAN DEFAULT FALSE"),
        # v0.7.0: app channels — extension-mounted channels under the
        # "Applications" group in the channels list (introduced 2026-04-25).
        ("channels", "extension_id", "TEXT"),
        ("channels", "app_access", "TEXT"),
        # INS-073: instance-wide soundboard + Freesound license/attribution
        # metadata. Existing per-server clips become instance-wide on next
        # boot (the routers stop filtering by server_id); these columns
        # capture the CC license + original uploader for clips imported
        # from freesound.org so attribution survives across the platform.
        ("soundboard_clips", "source", "TEXT"),
        ("soundboard_clips", "source_id", "TEXT"),
        ("soundboard_clips", "license", "TEXT"),
        ("soundboard_clips", "license_url", "TEXT"),
        ("soundboard_clips", "attribution", "TEXT"),
    ]
    async with engine.begin() as conn:
        for table, column, sql_type in migrations:
            exists = await conn.run_sync(
                lambda c, t=table, col=column: _column_exists(c, t, col)
            )
            if not exists:
                await conn.execute(
                    text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")
                )


async def init_db():
    # Create any new tables first — this brings fresh DBs fully up to
    # date. Then apply lightweight migrations to patch older DBs that
    # already had the tables when new columns were added.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _lightweight_migrations()


async def get_db():
    async with async_session() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
