"""Alembic environment for the Concord backend.

We use a SYNC engine here (not the application's async one) because
Alembic's offline/online modes are built around sync connections.
DATABASE_URL is rewritten from ``sqlite+aiosqlite://...`` to plain
``sqlite://...`` so the sync driver can open the same file.

Routine workflow:
    cd server
    alembic revision --autogenerate -m "describe-change"
    alembic upgrade head

The lifespan hook in main.py also calls ``upgrade head`` on startup so
deployments stay in sync without manual intervention.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# Make the ``server/`` package importable when alembic is invoked from
# anywhere — autogenerate needs to import models to compare metadata.
_SERVER_DIR = Path(__file__).resolve().parent.parent
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

from config import DATABASE_URL  # noqa: E402
from database import Base  # noqa: E402
import models  # noqa: E402,F401 — ensure all mappers are registered


config = context.config

# NOTE: alembic.ini ships [loggers]/[handlers]/[formatters] sections,
# but we deliberately do NOT call logging.config.fileConfig() here.
# Doing so REPLACES the application's root logging config (set up in
# main.py via basicConfig), which silently breaks pytest's caplog and
# the in-app diagnostic loggers. Alembic's own messages still emit
# under the root logger's level, which is enough for a startup-time
# upgrade. Standalone `alembic` CLI invocations are also fine without
# fileConfig — they just inherit the shell's logging defaults.

target_metadata = Base.metadata


def _sync_url() -> str:
    """Strip the +aiosqlite driver so the sync engine can open the file."""
    url = os.getenv("CONCORD_ALEMBIC_DB_URL", DATABASE_URL)
    return url.replace("+aiosqlite", "")


def run_migrations_offline() -> None:
    context.configure(
        url=_sync_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # SQLite needs batch mode for ALTER TABLE; Postgres doesn't care.
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {}) or {}
    section["sqlalchemy.url"] = _sync_url()
    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
