"""Tests for the static-catalog → DB migration (INS-066-FUP-C).

The legacy static catalog (server/extensions.json or
<DATA_DIR>/installed_extensions.json) registered extensions without
inserting DB rows. As a result the W7 fetch:external gate in
ext_proxy short-circuited (manifest is None → bypass) and
``GET /api/extensions`` surfaced an empty permissions array.

The fix is a one-shot, idempotent on-boot migration that creates a
synthetic Extension row for every static entry that lacks one, with
``permissions=[]``. Re-installing via the runtime pipeline is the
only way to grant any permission — preserving the W7 invariant that
permission inflation is never silent.

Coverage:
  * migrate_static_catalog inserts rows for every legacy entry.
  * Idempotent on second invocation — no duplicate rows.
  * Pre-existing DB rows are NEVER overwritten (their permissions
    survive intact).
  * GET /api/extensions returns the migrated entry with permissions=[].
  * The ext_proxy fetch:external gate refuses 403 for a migrated row
    (because permissions=[] does not contain fetch:external).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from .conftest import login_as

ADMIN_USER = "@test_admin:test.local"


def _seed_static_catalog(monkeypatch, entries):
    """Replace the in-memory static catalog (`_catalog`) with ``entries``.

    ``entries`` is a list of dicts shaped like the legacy
    installed_extensions.json: ``{id, name, url, icon, description}``.
    Returns a list of ExtensionDef parsed from the dicts.
    """
    import routers.extensions as ext_mod

    parsed = [ext_mod.ExtensionDef(**e) for e in entries]
    monkeypatch.setattr(ext_mod, "_catalog", parsed)
    return parsed


# ---------------------------------------------------------------------
# Migration unit tests
# ---------------------------------------------------------------------


async def test_migration_inserts_rows_for_legacy_entries(db_session, monkeypatch):
    """Every static-catalog entry without a DB row must be inserted with
    permissions=[]. The synthetic manifest preserves name/icon/description."""
    import routers.extensions as ext_mod
    from models import Extension

    _seed_static_catalog(
        monkeypatch,
        [
            {
                "id": "com.example.legacy-a",
                "name": "Legacy A",
                "url": "/ext/com.example.legacy-a/index.html",
                "icon": "extension",
                "description": "Pre-INS-066 entry A",
            },
            {
                "id": "com.example.legacy-b",
                "name": "Legacy B",
                "url": "/ext/com.example.legacy-b/",
                "icon": "extension",
                "description": "Pre-INS-066 entry B",
            },
        ],
    )

    inserted = await ext_mod.migrate_static_catalog(db_session)
    assert inserted == 2

    rows = (await db_session.execute(select(Extension))).scalars().all()
    by_id = {r.id: r for r in rows}
    assert "com.example.legacy-a" in by_id
    assert "com.example.legacy-b" in by_id

    a = by_id["com.example.legacy-a"]
    manifest_a = json.loads(a.manifest)
    assert manifest_a["id"] == "com.example.legacy-a"
    assert manifest_a["permissions"] == []
    assert manifest_a["name"] == "Legacy A"
    assert manifest_a["entry"] == "index.html"
    # Synthetic version sentinel for legacy entries.
    assert a.version == "0.0.0"
    assert a.remote_url is None

    # The "/ext/{id}/" form (no entry suffix) defaults to index.html.
    b = by_id["com.example.legacy-b"]
    manifest_b = json.loads(b.manifest)
    assert manifest_b["entry"] == "index.html"


async def test_migration_is_idempotent(db_session, monkeypatch):
    """Running the migration twice in a row must not duplicate rows."""
    import routers.extensions as ext_mod
    from models import Extension

    _seed_static_catalog(
        monkeypatch,
        [
            {
                "id": "com.example.legacy-once",
                "name": "Legacy Once",
                "url": "/ext/com.example.legacy-once/index.html",
                "icon": "extension",
                "description": "",
            },
        ],
    )

    first = await ext_mod.migrate_static_catalog(db_session)
    second = await ext_mod.migrate_static_catalog(db_session)
    assert first == 1
    assert second == 0

    rows = (await db_session.execute(
        select(Extension).where(Extension.id == "com.example.legacy-once")
    )).scalars().all()
    assert len(rows) == 1


async def test_migration_does_not_overwrite_existing_db_row(db_session, monkeypatch):
    """A pre-existing DB row (with real permissions) must NOT be
    overwritten by the migration. This is the W7 invariant: no silent
    permission inflation OR deflation by the migration path."""
    import routers.extensions as ext_mod
    from models import Extension

    # Insert a "real" runtime-installed row with fetch:external granted.
    real_manifest = {
        "id": "com.example.real",
        "version": "1.2.3",
        "entry": "index.html",
        "permissions": ["fetch:external", "state_events"],
        "name": "Real",
    }
    real_row = Extension(
        id="com.example.real",
        version="1.2.3",
        pricing="free",
        enabled=True,
        cached_at=datetime.now(timezone.utc),
        remote_url="https://example.com/bundle.zip",
        manifest=json.dumps(real_manifest),
    )
    db_session.add(real_row)
    await db_session.commit()

    # Static catalog also lists this id (legacy + new co-existing).
    _seed_static_catalog(
        monkeypatch,
        [
            {
                "id": "com.example.real",
                "name": "Real (legacy view)",
                "url": "/ext/com.example.real/",
                "icon": "extension",
                "description": "",
            },
        ],
    )

    inserted = await ext_mod.migrate_static_catalog(db_session)
    assert inserted == 0

    refreshed = await db_session.get(Extension, "com.example.real")
    assert refreshed is not None
    persisted_manifest = json.loads(refreshed.manifest)
    # Permissions preserved verbatim — migration did NOT clobber them.
    assert "fetch:external" in persisted_manifest["permissions"]
    assert "state_events" in persisted_manifest["permissions"]
    assert refreshed.version == "1.2.3"
    assert refreshed.remote_url == "https://example.com/bundle.zip"


async def test_empty_catalog_is_a_no_op(db_session, monkeypatch):
    """An empty static catalog is the production default; migration
    must short-circuit cleanly with zero inserts."""
    import routers.extensions as ext_mod
    from models import Extension

    monkeypatch.setattr(ext_mod, "_catalog", [])
    inserted = await ext_mod.migrate_static_catalog(db_session)
    assert inserted == 0

    rows = (await db_session.execute(select(Extension))).scalars().all()
    assert rows == []


# ---------------------------------------------------------------------
# Listing endpoint exposes permissions=[] for migrated rows
# ---------------------------------------------------------------------


async def test_list_extensions_surfaces_empty_permissions_for_migrated(
    client, db_session, monkeypatch
):
    """After migration, ``GET /api/extensions`` must return the migrated
    entry with permissions=[] — not absent, not implicitly granted."""
    import routers.extensions as ext_mod

    _seed_static_catalog(
        monkeypatch,
        [
            {
                "id": "com.example.list-me",
                "name": "List Me",
                "url": "/ext/com.example.list-me/index.html",
                "icon": "extension",
                "description": "",
            },
        ],
    )
    await ext_mod.migrate_static_catalog(db_session)

    login_as(ADMIN_USER)
    resp = await client.get("/api/extensions")
    assert resp.status_code == 200, resp.text
    items = resp.json()
    matching = next(it for it in items if it["id"] == "com.example.list-me")
    assert "permissions" in matching
    assert matching["permissions"] == []


# ---------------------------------------------------------------------
# Ext-proxy fetch:external gate enforced for migrated rows
# ---------------------------------------------------------------------


async def test_ext_proxy_rejects_fetch_external_for_migrated_row(
    client, db_session, monkeypatch
):
    """Once migrated, an ext_proxy fetch:external request from a
    legacy extension must be rejected with 403 — the gate now applies
    uniformly because the DB row exists with permissions=[]."""
    import routers.extensions as ext_mod

    _seed_static_catalog(
        monkeypatch,
        [
            {
                "id": "com.example.gated",
                "name": "Gated",
                "url": "/ext/com.example.gated/",
                "icon": "extension",
                "description": "",
            },
        ],
    )
    await ext_mod.migrate_static_catalog(db_session)

    login_as(ADMIN_USER)
    # ext_proxy expects a registered provider — pick one that exists in
    # PROVIDERS at import time. Any failure path BEFORE the permission
    # check would mask the test, so check the wired-up shape:
    from routers.ext_proxy import PROVIDERS
    provider = next(iter(PROVIDERS.keys()))

    resp = await client.get(
        f"/api/ext-proxy/com.example.gated/{provider}/some/path"
    )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    detail = body["detail"]
    assert detail["error"] == "permission_denied"
    assert detail["permission"] == "fetch:external"
    assert detail["extension_id"] == "com.example.gated"
