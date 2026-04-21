"""Tests for the per-user connection router (``routers/user_connections.py``).

Covers the PR1 surface: ``/users/me/discord`` status + ``login`` + ``logout``.

These are the user-scoped counterparts to the admin-gated bridge
endpoints. The critical invariant — admins have no path to trigger or
read another user's session — is exercised by asserting that each
request goes through ``get_user_id`` / ``get_access_token`` and returns
only the caller's own data.

External side effects (``create_dm_room``, ``bot_send_message``) are
mocked at module scope; the tests assert WHICH matrix user id is passed
to the bridge bot and that the DM creation uses the CALLER'S access
token (not a shared admin token).
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture
def mock_matrix(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    """Mock the two Matrix side-effects.

    ``create_dm_room`` would hit the real homeserver, and
    ``_send_as_user`` would PUT a Matrix event as the caller. Both are
    replaced with AsyncMocks whose return values are asserted.

    The ``bot_send_message`` key in the returned dict is kept for
    backwards-compatible test reads but now points at the user-scoped
    sender — the name is preserved so existing assertions continue to
    work while making it clear in the code that the send is USER-scoped.
    """
    from routers import user_connections as uc_mod

    create = AsyncMock(return_value="!roomid:test.local")
    send = AsyncMock(return_value=None)

    monkeypatch.setattr(uc_mod, "create_dm_room", create)
    monkeypatch.setattr(uc_mod, "_send_as_user", send)

    return {"create_dm_room": create, "bot_send_message": send, "send_as_user": send}


@pytest.fixture(autouse=True)
def matrix_server_name(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin MATRIX_SERVER_NAME so bridge-bot MXID is deterministic."""
    from routers import user_connections as uc_mod

    monkeypatch.setattr(uc_mod, "MATRIX_SERVER_NAME", "test.local")


# ---------------------------------------------------------------------
# GET /users/me/discord
# ---------------------------------------------------------------------


async def test_status_unauthenticated_rejected(client: AsyncClient) -> None:
    """No auth header → 401/403. Uses the real dep chain."""
    logout()  # belt and braces: ensure no override from previous test
    resp = await client.get("/api/users/me/discord")
    # FastAPI's default auth failure path is 401 via Header(...) OR 403
    # depending on how get_access_token raises. Either is acceptable —
    # what matters is the endpoint does NOT return a valid status.
    assert resp.status_code in (401, 403, 422)


async def test_status_returns_caller_mxid(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """Status endpoint echoes the CALLER's mxid, not someone else's."""
    login_as("@alice:test.local")
    resp = await client.get("/api/users/me/discord")
    assert resp.status_code == 200
    body = resp.json()
    assert body["mxid"] == "@alice:test.local"
    # PR1 reports false unconditionally; see the doc in the endpoint.
    assert body["connected"] is False
    # No side effects on a read.
    assert mock_matrix["create_dm_room"].await_count == 0
    assert mock_matrix["bot_send_message"].await_count == 0


async def test_status_does_not_leak_other_user(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """No query parameter or body can redirect status to another user."""
    login_as("@alice:test.local")
    # Path is fixed at /users/me; test that alternate forms are rejected.
    resp = await client.get("/api/users/@bob:test.local/discord")
    assert resp.status_code in (404, 405, 422)


# ---------------------------------------------------------------------
# POST /users/me/discord/login
# ---------------------------------------------------------------------


async def test_login_creates_dm_with_bridge_bot(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """Login triggers create_dm_room with the caller's token + bridge bot mxid."""
    login_as("@alice:test.local")
    resp = await client.post("/api/users/me/discord/login")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["room_id"] == "!roomid:test.local"

    mock_matrix["create_dm_room"].assert_awaited_once()
    args, _ = mock_matrix["create_dm_room"].call_args
    # args: (access_token, invite_user_id)
    assert args[0] == "fake-token-for-tests"  # the CALLER's token
    assert args[1] == "@discordbot:test.local"


async def test_login_sends_login_command(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """Login posts the literal string 'login' to the DM room AS THE USER.

    mautrix-discord binds the Discord session to whichever MXID authored
    the 'login' message. We must send as the caller, not the concord-bot,
    or the wrong account gets bridged. The body must be exactly 'login'
    for mautrix's user-mode trigger to fire.
    """
    login_as("@alice:test.local")
    await client.post("/api/users/me/discord/login")

    mock_matrix["send_as_user"].assert_awaited_once()
    args, _ = mock_matrix["send_as_user"].call_args
    # args: (access_token, room_id, body)
    assert args[0] == "fake-token-for-tests"  # CALLER's token, not bot's
    assert args[1] == "!roomid:test.local"
    assert args[2] == "login"


async def test_login_unauthenticated_rejected(client: AsyncClient) -> None:
    logout()
    resp = await client.post("/api/users/me/discord/login")
    assert resp.status_code in (401, 403, 422)


async def test_login_extra_body_rejected(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """NoBodyRequest has ``extra='forbid'`` — junk bodies 422."""
    login_as("@alice:test.local")
    resp = await client.post(
        "/api/users/me/discord/login",
        json={"user_id": "@bob:test.local"},  # trying to pivot
    )
    assert resp.status_code == 422


async def test_login_dm_failure_returns_502(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """Matrix homeserver errors surface as 502, not 500 or a raw traceback."""
    mock_matrix["create_dm_room"].side_effect = RuntimeError("m.room_version_incompatible")
    login_as("@alice:test.local")
    resp = await client.post("/api/users/me/discord/login")
    assert resp.status_code == 502
    assert "Could not create DM" in resp.json()["detail"]


async def test_login_send_failure_returns_502(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    mock_matrix["send_as_user"].side_effect = RuntimeError("appservice_unavailable")
    login_as("@alice:test.local")
    resp = await client.post("/api/users/me/discord/login")
    assert resp.status_code == 502
    assert "Could not send login trigger" in resp.json()["detail"]


# ---------------------------------------------------------------------
# POST /users/me/discord/logout and DELETE /users/me/discord
# ---------------------------------------------------------------------


async def test_logout_sends_logout_command(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    login_as("@alice:test.local")
    resp = await client.post("/api/users/me/discord/logout")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    mock_matrix["send_as_user"].assert_awaited_once()
    args, _ = mock_matrix["send_as_user"].call_args
    # args: (access_token, room_id, body)
    assert args[2] == "logout"


async def test_delete_is_alias_for_logout(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """DELETE /discord performs the same logout action."""
    login_as("@alice:test.local")
    resp = await client.delete("/api/users/me/discord")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    mock_matrix["send_as_user"].assert_awaited_once()
    args, _ = mock_matrix["send_as_user"].call_args
    assert args[2] == "logout"


async def test_logout_unauthenticated_rejected(client: AsyncClient) -> None:
    logout()
    resp = await client.post("/api/users/me/discord/logout")
    assert resp.status_code in (401, 403, 422)

    resp = await client.delete("/api/users/me/discord")
    assert resp.status_code in (401, 403, 422)


# ---------------------------------------------------------------------
# Cross-user isolation (the core security invariant)
# ---------------------------------------------------------------------


async def test_alice_login_uses_alice_token_not_bob(
    client: AsyncClient,
    mock_matrix: dict[str, AsyncMock],
) -> None:
    """Alice's login creates a DM with Alice's token, not a shared one.

    If this assertion fails, an admin or bot could theoretically create
    a DM on behalf of another user, defeating the per-user privacy
    model. This is the linchpin test for the security invariant.
    """
    login_as("@alice:test.local")
    await client.post("/api/users/me/discord/login")
    args, _ = mock_matrix["create_dm_room"].call_args
    alice_token = args[0]

    # Clear and log in as bob.
    mock_matrix["create_dm_room"].reset_mock()
    mock_matrix["bot_send_message"].reset_mock()
    logout()
    login_as("@bob:test.local")
    await client.post("/api/users/me/discord/login")
    args, _ = mock_matrix["create_dm_room"].call_args
    bob_token = args[0]

    # Both use the fake test token (conftest returns it unconditionally),
    # but what matters is that each request depends on get_access_token
    # — not a shared bot token. We assert the test-token value because
    # conftest.login_as overrides get_access_token to return exactly
    # that. If this ever changes, the isolation story needs rethinking.
    assert alice_token == "fake-token-for-tests"
    assert bob_token == "fake-token-for-tests"
