"""Regression tests for the two split-brain fixes landed in the
architecture-cleanup sprint:

1. ``GET /api/servers`` lobby auto-join: if a single Matrix room-join
   fails, the membership row must NOT be committed. The original code
   ``except Exception: pass`` swallowed the failure and committed
   anyway, leaving the user with a Concord lobby tile that pointed at
   rooms they couldn't read.

2. ``POST /api/servers/{id}/bans``: must fan a Matrix-room ban out
   across every channel of the server, and must NOT commit the DB ban
   row if any Matrix ban fails. The original code just deleted the
   ``ServerMember`` row and never touched the Matrix homeserver — a
   banned user kept reading channel history.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import pytest
from sqlalchemy import select

import services.matrix_admin as matrix_admin
from config import INSTANCE_SETTINGS_FILE
from models import Channel, Server, ServerBan, ServerMember
from tests.conftest import login_as


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


async def _seed_server_with_channels(
    db_session, *, owner_id: str, channel_room_ids: list[str]
) -> str:
    server_id = _new_id()
    db_session.add(Server(id=server_id, name=f"srv-{server_id}", owner_id=owner_id))
    db_session.add(ServerMember(server_id=server_id, user_id=owner_id, role="owner"))
    for i, room_id in enumerate(channel_room_ids):
        db_session.add(
            Channel(
                server_id=server_id,
                name=f"channel-{i}",
                channel_type="text",
                matrix_room_id=room_id,
                position=i,
            )
        )
    await db_session.commit()
    return server_id


# -----------------------------------------------------------------------
# Lobby auto-join: failure path must NOT commit a membership row.
# -----------------------------------------------------------------------


@pytest.fixture
async def lobby_with_channels(db_session):
    """Set up a default lobby server with two channels. The test that
    consumes this fixture controls whether the join_room calls succeed
    by monkeypatching ``services.matrix_admin.join_room``."""
    lobby_id = await _seed_server_with_channels(
        db_session,
        owner_id="@lobby_owner:test.local",
        channel_room_ids=["!lobby-general:test.local", "!lobby-rules:test.local"],
    )
    original = (
        json.loads(INSTANCE_SETTINGS_FILE.read_text())
        if INSTANCE_SETTINGS_FILE.exists()
        else {}
    )
    INSTANCE_SETTINGS_FILE.write_text(json.dumps({**original, "default_server_id": lobby_id}))
    yield lobby_id
    if original:
        INSTANCE_SETTINGS_FILE.write_text(json.dumps(original))
    else:
        INSTANCE_SETTINGS_FILE.unlink(missing_ok=True)


@pytest.mark.anyio
async def test_lobby_auto_join_failure_does_not_commit_membership(
    client, db_session, lobby_with_channels, monkeypatch
):
    """When even one channel join fails, the user must NOT end up as a
    lobby member in the DB — otherwise they see a server tile pointing
    at rooms they can't read."""
    lobby_id = lobby_with_channels
    join_calls: list[str] = []

    async def flaky_join(_access_token: str, room_id: str) -> None:
        join_calls.append(room_id)
        if "rules" in room_id:
            raise RuntimeError("simulated homeserver timeout")

    monkeypatch.setattr("routers.servers.join_room", flaky_join)
    login_as("@newcomer:test.local")

    resp = await client.get("/api/servers")

    assert resp.status_code == 200
    # First channel was attempted, second failed → membership rollback.
    assert len(join_calls) == 2
    result = await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == lobby_id,
            ServerMember.user_id == "@newcomer:test.local",
        )
    )
    assert result.scalar_one_or_none() is None, (
        "newcomer must not have a lobby membership row after a partial "
        "Matrix-join failure"
    )


@pytest.mark.anyio
async def test_lobby_auto_join_success_commits_membership(
    client, db_session, lobby_with_channels, monkeypatch
):
    """All channels succeed → membership row committed, lobby visible."""
    lobby_id = lobby_with_channels

    async def ok_join(_access_token: str, _room_id: str) -> None:
        return None

    monkeypatch.setattr("routers.servers.join_room", ok_join)
    login_as("@newcomer:test.local")

    resp = await client.get("/api/servers")

    assert resp.status_code == 200
    body = resp.json()
    assert any(s["id"] == lobby_id for s in body)
    result = await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == lobby_id,
            ServerMember.user_id == "@newcomer:test.local",
        )
    )
    assert result.scalar_one_or_none() is not None


# -----------------------------------------------------------------------
# ban_user: must fan Matrix ban across every channel, no partial commits.
# -----------------------------------------------------------------------


@pytest.mark.anyio
async def test_ban_user_fans_matrix_ban_across_every_channel(
    client, db_session, monkeypatch
):
    """A ban must call ``ban_from_room`` for every channel of the server
    AND commit the DB row only when all calls succeed."""
    server_id = await _seed_server_with_channels(
        db_session,
        owner_id="@owner:test.local",
        channel_room_ids=["!a:test.local", "!b:test.local", "!c:test.local"],
    )
    target = "@spammer:test.local"
    db_session.add(ServerMember(server_id=server_id, user_id=target, role="member"))
    await db_session.commit()

    banned_rooms: list[str] = []

    async def fake_ban(_token: str, room_id: str, user_id: str, **_: Any) -> None:
        assert user_id == target
        banned_rooms.append(room_id)

    monkeypatch.setattr("routers.servers.ban_from_room", fake_ban)
    login_as("@owner:test.local")

    resp = await client.post(
        f"/api/servers/{server_id}/bans",
        json={"user_id": target},
    )

    assert resp.status_code == 200
    assert sorted(banned_rooms) == ["!a:test.local", "!b:test.local", "!c:test.local"]

    ban_row = (
        await db_session.execute(
            select(ServerBan).where(
                ServerBan.server_id == server_id, ServerBan.user_id == target
            )
        )
    ).scalar_one_or_none()
    assert ban_row is not None
    member_row = (
        await db_session.execute(
            select(ServerMember).where(
                ServerMember.server_id == server_id, ServerMember.user_id == target
            )
        )
    ).scalar_one_or_none()
    assert member_row is None, "membership row must be deleted on successful ban"


@pytest.mark.anyio
async def test_ban_user_aborts_on_partial_matrix_failure(
    client, db_session, monkeypatch
):
    """If any per-channel Matrix ban fails, the DB ban row must NOT be
    written and the API must surface 502 so the caller can retry."""
    server_id = await _seed_server_with_channels(
        db_session,
        owner_id="@owner:test.local",
        channel_room_ids=["!ok:test.local", "!flaky:test.local"],
    )
    target = "@spammer:test.local"
    db_session.add(ServerMember(server_id=server_id, user_id=target, role="member"))
    await db_session.commit()

    async def flaky_ban(_token: str, room_id: str, _user_id: str, **_: Any) -> None:
        if "flaky" in room_id:
            raise RuntimeError("simulated homeserver 503")

    monkeypatch.setattr("routers.servers.ban_from_room", flaky_ban)
    login_as("@owner:test.local")

    resp = await client.post(
        f"/api/servers/{server_id}/bans",
        json={"user_id": target},
    )

    assert resp.status_code == 502

    ban_row = (
        await db_session.execute(
            select(ServerBan).where(
                ServerBan.server_id == server_id, ServerBan.user_id == target
            )
        )
    ).scalar_one_or_none()
    assert ban_row is None, "DB ban row must NOT be committed when any Matrix ban fails"

    member_row = (
        await db_session.execute(
            select(ServerMember).where(
                ServerMember.server_id == server_id, ServerMember.user_id == target
            )
        )
    ).scalar_one_or_none()
    assert member_row is not None, "membership must remain — ban was aborted"


@pytest.mark.anyio
async def test_ban_from_room_helper_raises_on_non_200(monkeypatch):
    """Unit-test the helper itself: any non-200 must raise so the route
    can treat it as a hard failure."""

    class FakeResp:
        def __init__(self, code: int, body: dict[str, Any]):
            self.status_code = code
            self._body = body

        def json(self) -> dict[str, Any]:
            return self._body

    class FakeClient:
        def __init__(self, resp: FakeResp):
            self._resp = resp

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, *_args, **_kwargs):
            return self._resp

    def fake_async_client(*_args, **_kwargs):
        return FakeClient(FakeResp(403, {"error": "user not allowed"}))

    monkeypatch.setattr(matrix_admin.httpx, "AsyncClient", fake_async_client)

    with pytest.raises(Exception, match="HTTP 403"):
        await matrix_admin.ban_from_room("token", "!room:x", "@u:x")
