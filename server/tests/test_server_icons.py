"""Tests for the custom server-tile icon upload endpoint (ISSUE D, 2026-04-18).

The server model already had ``icon_url: str | None`` but no upload path —
the sidebar fell back to the abbreviation glyph forever. These tests lock
in the POST /api/servers/{id}/icon endpoint's contract:

1. Admin can upload a valid PNG; Server.icon_url is populated; the GET
   serve endpoint returns the same bytes.
2. Non-admin gets 403.
3. Bad extensions are rejected with 400.
4. Oversize uploads are rejected with 413.
5. File-content sniff catches mismatched magic bytes.
6. PATCH /settings with icon_url="" clears the stored icon.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from models import Server, ServerMember
from tests.conftest import login_as


MINIMAL_PNG = (
    # 1x1 transparent PNG — smallest valid file that passes magic-byte sniff.
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\x00\x18\xdd\x8d\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


@pytest.fixture
async def seeded_server(db_session):
    srv = Server(id="srv_icon_1", name="Icon Test", owner_id="@alice:test.local")
    db_session.add(srv)
    db_session.add(ServerMember(
        server_id="srv_icon_1", user_id="@alice:test.local", role="owner"
    ))
    db_session.add(ServerMember(
        server_id="srv_icon_1", user_id="@bob:test.local", role="member"
    ))
    await db_session.commit()
    return srv


@pytest.mark.anyio
async def test_admin_uploads_valid_png_and_serve_returns_same_bytes(client, seeded_server):
    login_as("@alice:test.local")

    resp = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", MINIMAL_PNG, "image/png")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["icon_url"].startswith(f"/api/servers/{seeded_server.id}/icon")

    # GET serve endpoint returns the bytes we uploaded.
    get_resp = await client.get(f"/api/servers/{seeded_server.id}/icon")
    assert get_resp.status_code == 200
    assert get_resp.content == MINIMAL_PNG


@pytest.mark.anyio
async def test_non_admin_cannot_upload_icon(client, seeded_server):
    login_as("@bob:test.local")  # member, not admin/owner
    resp = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", MINIMAL_PNG, "image/png")},
    )
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_rejects_disallowed_extension(client, seeded_server):
    login_as("@alice:test.local")
    # SVG is deliberately NOT in the allowlist — it's a vector for script
    # injection via <script> / xlink:href credentials-leak tricks.
    resp = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.svg", b"<svg/>", "image/svg+xml")},
    )
    assert resp.status_code == 400
    assert "extension" in resp.json()["detail"].lower()


@pytest.mark.anyio
async def test_rejects_content_magic_mismatch(client, seeded_server):
    login_as("@alice:test.local")
    resp = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", b"this is not a png", "image/png")},
    )
    assert resp.status_code == 400
    assert "content" in resp.json()["detail"].lower()


@pytest.mark.anyio
async def test_rejects_oversize_upload(client, seeded_server):
    login_as("@alice:test.local")
    # 2 MiB + 1 byte — just over the cap.
    payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * (2 * 1024 * 1024 + 10)
    resp = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", payload, "image/png")},
    )
    assert resp.status_code == 413


@pytest.mark.anyio
async def test_patch_settings_can_clear_icon_url(client, seeded_server):
    login_as("@alice:test.local")

    # Upload first.
    up = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", MINIMAL_PNG, "image/png")},
    )
    assert up.status_code == 200

    # Clear via PATCH settings with icon_url="".
    patch = await client.patch(
        f"/api/servers/{seeded_server.id}/settings",
        json={"icon_url": ""},
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["icon_url"] is None

    # Non-empty icon_url in PATCH is rejected — upload endpoint is the only
    # way to SET a custom icon.
    bad = await client.patch(
        f"/api/servers/{seeded_server.id}/settings",
        json={"icon_url": "https://evil.example/tracking.gif"},
    )
    assert bad.status_code == 400


@pytest.mark.anyio
async def test_delete_icon_endpoint_clears_it(client, seeded_server):
    login_as("@alice:test.local")
    up = await client.post(
        f"/api/servers/{seeded_server.id}/icon",
        files={"file": ("tile.png", MINIMAL_PNG, "image/png")},
    )
    assert up.status_code == 200

    delete = await client.delete(f"/api/servers/{seeded_server.id}/icon")
    assert delete.status_code == 200
    assert delete.json()["icon_url"] is None

    # Serve endpoint should now 404.
    get_resp = await client.get(f"/api/servers/{seeded_server.id}/icon")
    assert get_resp.status_code == 404
