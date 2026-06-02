"""Smoke tests for the Alembic startup integration (Fix 5 of the
architecture-cleanup sprint).

These tests verify both branches of ``migrations.apply_migrations``:
running against a clean DB and stamping an existing pre-Alembic DB
without re-running its history. Both paths must end with the
``alembic_version`` table populated and the rest of the schema intact.

These tests intentionally do NOT use importlib.reload on the
``config``/``migrations`` modules — reloading them mutates global
state shared with the rest of the test suite. Instead we set
``CONCORD_ALEMBIC_DB_URL``, which both ``alembic/env.py`` and
``migrations._sync_url`` honor as an override.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text


@pytest.fixture
def isolated_db(tmp_path: Path, monkeypatch):
    """Tmp SQLite file routed through CONCORD_ALEMBIC_DB_URL."""
    db_path = tmp_path / "alembic_test.db"
    monkeypatch.setenv("CONCORD_ALEMBIC_DB_URL", f"sqlite:///{db_path}")
    yield db_path
    # monkeypatch undoes the env var on teardown.


def test_apply_migrations_creates_full_schema_on_fresh_db(isolated_db):
    """Fresh DB path: alembic upgrade head builds every model table
    plus the version-tracking table."""
    from migrations import apply_migrations

    apply_migrations()

    engine = create_engine(f"sqlite:///{isolated_db}")
    try:
        with engine.connect() as conn:
            tables = set(inspect(conn).get_table_names())
    finally:
        engine.dispose()

    assert "alembic_version" in tables
    # Spot-check a representative slice of model tables.
    for required in ("servers", "channels", "server_members", "users", "voice_sessions"):
        assert required in tables, f"missing table {required!r} after baseline upgrade"


def test_apply_migrations_stamps_legacy_db_without_rerunning_history(isolated_db):
    """Legacy path: a DB that already has model tables but no
    ``alembic_version`` row must be stamped at head, NOT have its
    history re-applied (which would fail with 'table already exists')."""
    # Pre-populate the DB with a minimal application schema. Crucially:
    # do NOT create alembic_version.
    engine = create_engine(f"sqlite:///{isolated_db}")
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE servers (id VARCHAR PRIMARY KEY, name VARCHAR)"
            )
            conn.exec_driver_sql(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, matrix_user_id VARCHAR)"
            )
            conn.exec_driver_sql(
                "CREATE TABLE channels (id INTEGER PRIMARY KEY, name VARCHAR)"
            )
    finally:
        engine.dispose()

    from migrations import apply_migrations

    apply_migrations()

    engine = create_engine(f"sqlite:///{isolated_db}")
    try:
        with engine.connect() as conn:
            insp = inspect(conn)
            tables = set(insp.get_table_names())
            assert "alembic_version" in tables
            version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    finally:
        engine.dispose()

    # Must be stamped at the baseline revision (and not None / empty).
    assert version, "alembic_version row is missing after stamping legacy DB"
    # Pre-existing tables should still be there; stamping must not drop them.
    for required in ("servers", "users", "channels"):
        assert required in tables, f"legacy table {required!r} was dropped during stamp"
