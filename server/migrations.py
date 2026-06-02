"""Alembic integration glue for the server lifespan.

The application has historically applied schema changes via an inline
``_migrate()`` block in ``main.py``'s lifespan. That code is now frozen
— do NOT add new ``ALTER TABLE`` calls there. New schema work goes
through Alembic:

    cd server
    alembic revision --autogenerate -m "describe-change"
    # review the generated file under alembic/versions/
    # commit it
    # the lifespan's apply_migrations() picks it up on next deploy

This module provides ``apply_migrations()``, which:

* If the DB is empty (no tables at all) → ``alembic upgrade head``,
  creating the full schema from migration history.
* If the DB has tables but no ``alembic_version`` row → assume an
  existing deployment whose schema was assembled by the inline
  ``_migrate()`` block. ``alembic stamp head`` records that the
  current schema matches the latest revision without re-running it.
* Otherwise → ``alembic upgrade head`` applies whatever revisions are
  pending between the recorded version and ``head``.

Run from the same process as the app — the helper opens its own sync
connection so it doesn't fight aiosqlite's event loop.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from config import DATABASE_URL

logger = logging.getLogger(__name__)

_ALEMBIC_INI = Path(__file__).resolve().parent / "alembic.ini"


def _sync_url() -> str:
    # Honor CONCORD_ALEMBIC_DB_URL so the lifespan path and the
    # ``alembic`` CLI (which goes through env.py) agree on the target DB.
    # Used by the test suite to point at a tmp file without setting
    # CONCORD_DATA_DIR. Falls through to DATABASE_URL otherwise.
    url = os.getenv("CONCORD_ALEMBIC_DB_URL", DATABASE_URL)
    return url.replace("+aiosqlite", "")


def _alembic_config() -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("script_location", str(_ALEMBIC_INI.parent / "alembic"))
    cfg.set_main_option("sqlalchemy.url", _sync_url())
    return cfg


def apply_migrations() -> None:
    """Bring the live DB to the latest schema revision.

    Safe to call on every startup — Alembic is idempotent once a DB has
    been stamped at a revision.
    """
    engine = create_engine(_sync_url())
    try:
        with engine.connect() as conn:
            insp = inspect(conn)
            tables = set(insp.get_table_names())
            has_alembic_version = "alembic_version" in tables
            has_app_tables = any(
                t in tables for t in ("servers", "users", "channels")
            )

        cfg = _alembic_config()

        if not has_alembic_version and has_app_tables:
            # Existing deploy from the pre-Alembic era. The inline
            # migrations in lifespan() built the schema; record that
            # we're at head without running any of the migrations.
            logger.info(
                "alembic: existing DB without version table → stamping head"
            )
            command.stamp(cfg, "head")
        else:
            # Either a clean DB (alembic creates everything from scratch)
            # or an already-tracked DB (alembic applies pending revisions).
            command.upgrade(cfg, "head")
    finally:
        engine.dispose()
