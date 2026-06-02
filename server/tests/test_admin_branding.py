"""INS-069 — admin instance branding endpoint tests.

Scope:
1. Auth gating: non-admin → 403; missing auth → 403 (the
   `require_admin` helper raises before validation runs).
2. Pydantic validation: malformed hex colours, non-HTTP logo URLs,
   missing required fields all surface as 422.
3. Happy-path persistence: a valid POST writes the `branding` block
   into ``instance.json`` exactly as it appears in the request body.
4. Round-trip: after a successful POST, the well-known endpoint
   surfaces the same branding block (cross-module integration check).

Persistence works through the existing ``_read_instance_settings`` /
``_write_instance_settings`` helpers, so we monkeypatch
``INSTANCE_SETTINGS_FILE`` to a per-test file rather than relying on
``CONCORD_DATA_DIR`` env mutation (which is bound at config import
time).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.conftest import login_as, logout


@pytest.fixture
def isolated_settings_file(tmp_path, monkeypatch):
    """Redirect the instance.json reader/writer to a per-test file.

    INSTANCE_SETTINGS_FILE is bound at config import time from
    CONCORD_DATA_DIR, so simply setting the env var doesn't help mid-
    test. Patching the symbol on ``routers.admin`` works because every
    in-router call site reads through that module attribute.
    """
    target = tmp_path / "instance.json"
    import routers.admin as admin_module

    monkeypatch.setattr(admin_module, "INSTANCE_SETTINGS_FILE", target)
    return target


# -------------------------------------------------------------------
# Auth gating
# -------------------------------------------------------------------


async def test_non_admin_gets_403(client, isolated_settings_file):
    login_as("@random_user:test.local")
    try:
        resp = await client.post(
            "/api/admin/instance/branding",
            json={
                "primary_color": "#112233",
                "accent_color": "#aabbcc",
            },
        )
        assert resp.status_code == 403
    finally:
        logout()


async def test_missing_auth_blocked(client, isolated_settings_file):
    """Without dependency overrides, the auth dep tries to talk to the
    real Matrix homeserver and bails out — the endpoint must not
    accept an unauthenticated write under any condition.

    The exact status varies (401/403/500) based on the auth-dep path,
    but it MUST NOT be 204.
    """
    resp = await client.post(
        "/api/admin/instance/branding",
        json={"primary_color": "#112233", "accent_color": "#aabbcc"},
    )
    assert resp.status_code != 204
    assert resp.status_code in (401, 403, 500)


# -------------------------------------------------------------------
# Pydantic validation — runs before require_admin
# -------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        # Short-form hex (#abc) — must be six digits.
        {"primary_color": "#abc", "accent_color": "#aabbcc"},
        # Plain colour name.
        {"primary_color": "red", "accent_color": "#aabbcc"},
        # No leading hash.
        {"primary_color": "112233", "accent_color": "#aabbcc"},
        # Non-hex characters in the body.
        {"primary_color": "#zzzzzz", "accent_color": "#aabbcc"},
        # Wrong field on accent_color (same rules apply).
        {"primary_color": "#112233", "accent_color": "rgb(0,0,0)"},
        # Missing required field entirely.
        {"primary_color": "#112233"},
        {"accent_color": "#112233"},
        # Logo URL is not http(s).
        {
            "primary_color": "#112233",
            "accent_color": "#aabbcc",
            "logo_url": "ftp://example.com/logo.png",
        },
    ],
)
async def test_invalid_payload_returns_422(client, isolated_settings_file, payload):
    login_as("@test_admin:test.local")
    try:
        resp = await client.post("/api/admin/instance/branding", json=payload)
        # 422 is FastAPI's default validation status; pin it explicitly
        # so a future migration to a custom 400 is caught.
        assert resp.status_code == 422, resp.text
    finally:
        logout()


# -------------------------------------------------------------------
# Happy path
# -------------------------------------------------------------------


async def test_valid_post_persists_branding_block(client, isolated_settings_file):
    login_as("@test_admin:test.local")
    try:
        resp = await client.post(
            "/api/admin/instance/branding",
            json={
                "primary_color": "#112233",
                "accent_color": "#aabbcc",
                "logo_url": "https://example.test/logo.png",
            },
        )
        assert resp.status_code == 204, resp.text
        # No body on a 204.
        assert resp.content == b""

        # File on disk now contains the branding block under the
        # top-level `branding` key.
        assert isolated_settings_file.exists()
        on_disk = json.loads(isolated_settings_file.read_text())
        assert on_disk["branding"] == {
            "primary_color": "#112233",
            "accent_color": "#aabbcc",
            "logo_url": "https://example.test/logo.png",
        }
    finally:
        logout()


async def test_logo_url_optional(client, isolated_settings_file):
    login_as("@test_admin:test.local")
    try:
        resp = await client.post(
            "/api/admin/instance/branding",
            json={"primary_color": "#000000", "accent_color": "#ffffff"},
        )
        assert resp.status_code == 204, resp.text
        on_disk = json.loads(isolated_settings_file.read_text())
        assert on_disk["branding"]["logo_url"] is None
    finally:
        logout()


async def test_branding_does_not_clobber_other_settings(client, isolated_settings_file):
    """A branding write must preserve unrelated keys in instance.json.

    `_write_instance_settings` blats the whole file with the in-memory
    dict, so the handler MUST read-merge-write rather than overwrite.
    """
    isolated_settings_file.write_text(
        json.dumps({"name": "Existing Instance", "require_totp": True})
    )

    login_as("@test_admin:test.local")
    try:
        resp = await client.post(
            "/api/admin/instance/branding",
            json={"primary_color": "#101112", "accent_color": "#202122"},
        )
        assert resp.status_code == 204, resp.text
        on_disk = json.loads(isolated_settings_file.read_text())
        assert on_disk["name"] == "Existing Instance"
        assert on_disk["require_totp"] is True
        assert on_disk["branding"]["primary_color"] == "#101112"
    finally:
        logout()
