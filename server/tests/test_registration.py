"""Tests for the user registration pillar.

Scope:
1. Rate limiting (`_check_registration_rate_limit`) — pure sliding
   window, unit-test-friendly.
2. Invite pre-validation rejection paths — these 400 BEFORE any Matrix
   call, so they need no stubbing.
3. The compensating-transaction logic when Matrix registration fails
   after an invite slot has been atomically reserved — this is a
   subtle correctness property (the slot must be released) that is
   easy to break during a refactor and impossible to notice without
   a test.
4. Default-lobby onboarding. Fresh users may auto-join the configured
   lobby, but they must NOT silently inherit other public servers.

Scope exclusions:
- The "happy path" full registration is light-touch covered here via a
  monkeypatched `register_matrix_user`. A real end-to-end test needs
  conduwuit running and belongs in an integration-marked file.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

import config as config_module
from models import Channel, Server, InviteToken, ServerMember
import routers.registration as registration_module
import routers.servers as servers_module
from routers.registration import _check_registration_rate_limit, _reg_rate_limits
from tests.conftest import login_as


# ---------------------------------------------------------------------
# Rate limit: pure function
# ---------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_rate_limit_state():
    """The rate limit uses a module-level dict. Tests that exercise it
    must run in isolation, so we clear between tests.

    Autouse because forgetting to clear it leaks state between unrelated
    test files and causes flaky "why does this only fail when run
    alongside X" bugs — exactly the thing the feedback memory warns
    about.
    """
    _reg_rate_limits.clear()
    yield
    _reg_rate_limits.clear()


def test_rate_limit_allows_under_threshold():
    """Five registrations from the same IP should all pass (the
    threshold is 5 per 15 minutes)."""
    ip = "1.2.3.4"
    for _ in range(5):
        assert _check_registration_rate_limit(ip) is True


def test_rate_limit_blocks_over_threshold():
    """The 6th attempt from the same IP must be blocked."""
    ip = "1.2.3.4"
    for _ in range(5):
        _check_registration_rate_limit(ip)
    assert _check_registration_rate_limit(ip) is False


def test_rate_limit_is_per_ip():
    """Exhausting one IP's quota must NOT affect another IP."""
    for _ in range(5):
        _check_registration_rate_limit("1.2.3.4")
    # 1.2.3.4 is exhausted
    assert _check_registration_rate_limit("1.2.3.4") is False
    # 5.6.7.8 should still be clean
    assert _check_registration_rate_limit("5.6.7.8") is True


def test_rate_limit_evicts_empty_deques(monkeypatch):
    """H-3 twin in registration.py: ``_reg_rate_limits`` must not
    grow unbounded. An attacker spraying many distinct IPs a single
    time each used to leak one dict entry per IP forever.

    The fix adds a per-call post-pop ``del`` (fires when the same IP
    comes back after the window) plus a periodic sweep that walks
    the whole dict and drops fully-expired keys. This test drives
    the sweep directly with simulated time so the 1000-call interval
    doesn't have to be hit for real.
    """
    _reg_rate_limits.clear()
    registration_module._reg_sweep_counter = 0

    # Populate 50 distinct IPs at "now - 2000s" (outside the 900s window).
    real_now = time.time()
    past = real_now - 2000
    monkeypatch.setattr(registration_module.time, "time", lambda: past)
    for i in range(50):
        _check_registration_rate_limit(f"198.51.100.{i}")
    assert len(_reg_rate_limits) == 50

    # Jump back to the real present and run the sweep.
    monkeypatch.setattr(registration_module.time, "time", lambda: real_now)
    registration_module._sweep_reg_rate_limits(real_now)

    # All 50 keys are gone — their single entry was outside the window.
    assert len(_reg_rate_limits) == 0, (
        f"rate limit dict should be empty after sweep, "
        f"got {sorted(_reg_rate_limits.keys())[:5]}"
    )


def test_rate_limit_per_call_eviction_after_expiry(monkeypatch):
    """When the same IP comes back *after* its window has expired,
    the per-call pop-then-del path must keep the dict clean instead
    of letting the key linger with stale deque content.
    """
    _reg_rate_limits.clear()

    real_now = time.time()
    fake_now = [real_now - 2000]
    monkeypatch.setattr(registration_module.time, "time", lambda: fake_now[0])

    ip = "203.0.113.42"
    # Fill up the window well in the past.
    for _ in range(5):
        _check_registration_rate_limit(ip)
    # dict has one key with 5 expired entries
    assert len(_reg_rate_limits[ip]) == 5

    # Jump forward past the window.
    fake_now[0] = real_now
    # The next call must evict every stale entry, del the key, and
    # then re-add a fresh entry. Net: one key with one fresh entry.
    assert _check_registration_rate_limit(ip) is True
    assert len(_reg_rate_limits[ip]) == 1


def test_rate_limit_sliding_window_expires_old_entries(monkeypatch):
    """Entries older than the window should be evicted, freeing up
    slots for new attempts. Guards the deque-cleanup loop in
    `_check_registration_rate_limit`.

    We can't monkeypatch `time.time` directly and then call
    `time.time()` ourselves to get "real now" — the patch is global.
    Instead we capture real-time values FIRST, then install the patch
    and drive it with a mutable reference.
    """
    real_now = time.time()
    fake_now = [real_now - 2000]  # 2000s ago — well outside the 900s window

    # Install the patch AFTER capturing real_now so the assignment
    # below uses the real value, not the patched one.
    monkeypatch.setattr(
        registration_module.time, "time", lambda: fake_now[0]
    )

    ip = "1.2.3.4"
    for _ in range(5):
        _check_registration_rate_limit(ip)
    # At this point the deque has 5 entries all timestamped `real_now - 2000`.

    # Jump "forward" to the real present (which is >900s ahead of our
    # earlier fake-now). Those five entries should now be evicted on
    # the next call, freeing up the slot.
    fake_now[0] = real_now
    assert _check_registration_rate_limit(ip) is True


# ---------------------------------------------------------------------
# Invite pre-validation rejections (no Matrix stub needed)
# ---------------------------------------------------------------------

async def test_register_with_nonexistent_invite_token_returns_400(client):
    """If the invite token doesn't exist, we must 400 BEFORE touching
    the Matrix homeserver. This prevents a case where a user could
    create a Matrix account but fail to join a server, leaving a
    dangling account. Also avoids free account farming via the
    registration token."""
    resp = await client.post(
        "/api/register",
        json={
            "username": "alice",
            "password": "hunter2hunter2",
            "invite_token": "does-not-exist-at-all",
        },
    )
    assert resp.status_code == 400
    assert "invalid" in resp.json()["detail"].lower() or "expired" in resp.json()["detail"].lower()


async def test_register_with_expired_invite_token_returns_400(client, db_session):
    """Expired invite tokens must be rejected at the pre-Matrix stage."""
    server = Server(id="srv_exp", name="Expired Land", owner_id="@owner:test.local")
    db_session.add(server)
    await db_session.commit()

    expired = InviteToken(
        token="expired-token-abc",
        server_id=server.id,
        created_by="@owner:test.local",
        max_uses=10,
        use_count=0,
        permanent=False,
        expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    db_session.add(expired)
    await db_session.commit()

    resp = await client.post(
        "/api/register",
        json={
            "username": "bob",
            "password": "hunter2hunter2",
            "invite_token": "expired-token-abc",
        },
    )
    assert resp.status_code == 400


async def test_register_with_exhausted_invite_atomic_reject(client, db_session):
    """If another request already consumed the last slot, the atomic
    `UPDATE ... WHERE use_count < max_uses` must return 0 rows and we
    must 400 with "maximum uses" — NOT proceed to Matrix registration.

    This is the race-condition guard at registration.py:89-98. Without
    it, two concurrent requests could both pass the `is_valid` check
    and both succeed against Matrix, overcommitting the invite.
    """
    server = Server(id="srv_maxed", name="Maxed Server", owner_id="@owner:test.local")
    db_session.add(server)
    await db_session.commit()

    # Pre-populate an invite that's already at max_uses
    maxed = InviteToken(
        token="maxed-token",
        server_id=server.id,
        created_by="@owner:test.local",
        max_uses=1,
        use_count=1,  # already exhausted
        permanent=False,
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db_session.add(maxed)
    await db_session.commit()

    resp = await client.post(
        "/api/register",
        json={
            "username": "carol",
            "password": "hunter2hunter2",
            "invite_token": "maxed-token",
        },
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------
# Happy path + compensating-transaction — stubbed Matrix
# ---------------------------------------------------------------------

async def test_register_happy_path_with_stubbed_matrix(client, db_session, monkeypatch):
    """Stub `register_matrix_user` so the code path that depends on a
    real conduwuit returns a synthetic success. The test then asserts
    the response wires the Matrix identifiers back to the client.
    """
    async def fake_register(username, password):
        return {
            "access_token": "fake_access_token_xyz",
            "user_id": f"@{username}:test.local",
            "device_id": "DEVICE_TEST",
        }

    async def fake_join_room(access_token, room_id):
        return None

    monkeypatch.setenv("OPEN_REGISTRATION", "true")
    monkeypatch.setattr(registration_module, "register_matrix_user", fake_register)
    monkeypatch.setattr(registration_module, "join_room", fake_join_room)

    resp = await client.post(
        "/api/register",
        json={
            "username": "dave",
            "password": "hunter2hunter2",
            # No invite — just plain account creation
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user_id"] == "@dave:test.local"
    assert body["access_token"] == "fake_access_token_xyz"
    assert body["device_id"] == "DEVICE_TEST"
    assert body["server_id"] is None
    assert body["server_name"] is None


async def test_register_open_signup_only_auto_joins_default_lobby(
    client, db_session, monkeypatch, tmp_path
):
    lobby = Server(
        id="srv_lobby",
        name="Concorrd Lobby",
        owner_id="@owner:test.local",
        visibility="public",
    )
    tc17 = Server(
        id="srv_tc17",
        name="TC#17",
        owner_id="@owner:test.local",
        visibility="public",
    )
    db_session.add_all([lobby, tc17])
    db_session.add_all([
        Channel(server_id=lobby.id, matrix_room_id="!lobby:test.local", name="welcome", position=0),
        Channel(server_id=tc17.id, matrix_room_id="!tc17:test.local", name="general", position=0),
    ])
    await db_session.commit()

    instance_file = tmp_path / "instance.json"
    instance_file.write_text(json.dumps({"default_server_id": lobby.id}))
    monkeypatch.setattr(config_module, "INSTANCE_SETTINGS_FILE", instance_file)
    monkeypatch.setenv("OPEN_REGISTRATION", "true")

    joined_rooms: list[str] = []

    async def fake_register(username, password):
        return {
            "access_token": "fake_access_token_xyz",
            "user_id": f"@{username}:test.local",
            "device_id": "DEVICE_TEST",
        }

    async def fake_join_room(access_token, room_id):
        joined_rooms.append(room_id)
        return None

    monkeypatch.setattr(registration_module, "register_matrix_user", fake_register)
    monkeypatch.setattr(registration_module, "join_room", fake_join_room)

    resp = await client.post(
        "/api/register",
        json={
            "username": "bopeep",
            "password": "hunter2hunter2",
        },
    )
    assert resp.status_code == 200, resp.text

    memberships = await db_session.execute(
        select(ServerMember.server_id).where(ServerMember.user_id == "@bopeep:test.local")
    )
    assert memberships.scalars().all() == [lobby.id]
    assert joined_rooms == ["!lobby:test.local"]


async def test_register_with_invite_joins_server(client, db_session, monkeypatch):
    """If an invite is provided and Matrix succeeds, the user must be
    added to the server's members table."""
    server = Server(id="srv_join", name="Join Here", owner_id="@owner:test.local")
    db_session.add(server)
    await db_session.commit()

    invite = InviteToken(
        token="good-invite",
        server_id=server.id,
        created_by="@owner:test.local",
        max_uses=10,
        use_count=0,
        permanent=False,
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db_session.add(invite)
    await db_session.commit()

    async def fake_register(username, password):
        return {
            "access_token": "tok",
            "user_id": f"@{username}:test.local",
            "device_id": "D",
        }

    async def fake_join_room(access_token, room_id):
        return None

    monkeypatch.setattr(registration_module, "register_matrix_user", fake_register)
    monkeypatch.setattr(registration_module, "join_room", fake_join_room)

    resp = await client.post(
        "/api/register",
        json={
            "username": "eve",
            "password": "hunter2hunter2",
            "invite_token": "good-invite",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["server_id"] == "srv_join"
    assert body["server_name"] == "Join Here"

    # The invite use_count must have been incremented
    await db_session.refresh(invite)
    assert invite.use_count == 1


async def test_list_servers_only_auto_joins_default_lobby(client, db_session, monkeypatch, tmp_path):
    lobby = Server(
        id="srv_lobby",
        name="Concorrd Lobby",
        owner_id="@owner:test.local",
        visibility="public",
    )
    tc17 = Server(
        id="srv_tc17",
        name="TC#17",
        owner_id="@owner:test.local",
        visibility="public",
    )
    db_session.add_all([lobby, tc17])
    db_session.add_all([
        Channel(server_id=lobby.id, matrix_room_id="!lobby:test.local", name="welcome", position=0),
        Channel(server_id=tc17.id, matrix_room_id="!tc17:test.local", name="general", position=0),
    ])
    await db_session.commit()

    instance_file = tmp_path / "instance.json"
    instance_file.write_text(json.dumps({"default_server_id": lobby.id}))
    monkeypatch.setattr(config_module, "INSTANCE_SETTINGS_FILE", instance_file)

    joined_rooms: list[str] = []

    async def fake_join_room(access_token, room_id):
        joined_rooms.append(room_id)
        return None

    monkeypatch.setattr(servers_module, "join_room", fake_join_room)
    login_as("@bo-peep:test.local")

    resp = await client.get("/api/servers")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [server["id"] for server in body] == [lobby.id]

    memberships = await db_session.execute(
        select(ServerMember.server_id).where(ServerMember.user_id == "@bo-peep:test.local")
    )
    assert memberships.scalars().all() == [lobby.id]
    assert joined_rooms == ["!lobby:test.local"]


async def test_register_matrix_failure_releases_reserved_invite_slot(
    client, db_session, monkeypatch
):
    """The compensating-transaction path: if the invite slot was
    reserved and Matrix then rejects the username, the reserved slot
    must be released so the next user isn't locked out.

    This is the single most important test in this file. The bug it
    guards against is: user A with invite X triggers a reservation
    (use_count 0 → 1), Matrix errors out, but we forget to roll back,
    so use_count stays at 1 forever. If max_uses was 1, the invite is
    now dead even though nobody successfully used it.
    """
    server = Server(id="srv_comp", name="Compensation Server", owner_id="@owner:test.local")
    db_session.add(server)
    await db_session.commit()

    invite = InviteToken(
        token="comp-token",
        server_id=server.id,
        created_by="@owner:test.local",
        max_uses=2,
        use_count=0,
        permanent=False,
        expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    db_session.add(invite)
    await db_session.commit()

    async def failing_register(username, password):
        raise RuntimeError("User ID already taken")

    monkeypatch.setattr(registration_module, "register_matrix_user", failing_register)

    resp = await client.post(
        "/api/register",
        json={
            "username": "frank",
            "password": "hunter2hunter2",
            "invite_token": "comp-token",
        },
    )
    assert resp.status_code == 400
    assert "taken" in resp.json()["detail"].lower()

    # The use_count must have been restored to 0 (the compensation).
    await db_session.refresh(invite)
    assert invite.use_count == 0, (
        "BUG: invite slot was reserved but not released after Matrix "
        "registration failed — this invite is now permanently leaking "
        "a use count per failed registration"
    )


async def test_first_boot_operator_inherits_bot_owned_lobby(
    client, db_session, monkeypatch, tmp_path
):
    """Regression for: the first human operator landed as `role='member'`
    on a Lobby the bot had seeded as placeholder owner, which left the
    operator unable to see the per-server Invite User tab (gated on
    `isOwner || isAdmin`). First-boot registration must transfer the
    bot-seeded Lobby's ownership to the new user so they can administer
    their own instance.

    Empirical signal that drove this test: on the local dev instance,
    ``servers.owner_id`` was ``@concord-bot:…`` while the only human
    (``@corr:…``) sat in ``server_members`` with ``role='member'`` —
    confirmed by a direct DB read.
    """
    import services.bot as bot_module

    bot_user = "@concord-bot:test.local"
    monkeypatch.setattr(bot_module, "BOT_USER_ID", bot_user)

    lobby = Server(
        id="srv_lobby_bootstrap",
        name="Concord Lobby",
        owner_id=bot_user,
        visibility="public",
    )
    db_session.add(lobby)
    db_session.add(ServerMember(
        server_id=lobby.id,
        user_id=bot_user,
        role="owner",
    ))
    db_session.add(Channel(
        server_id=lobby.id,
        matrix_room_id="!lobby-general:test.local",
        name="general",
        position=0,
    ))
    await db_session.commit()

    instance_file = tmp_path / "instance.json"
    # First boot: file either missing or without first_boot_complete.
    instance_file.write_text(json.dumps({"default_server_id": lobby.id}))
    monkeypatch.setattr(config_module, "INSTANCE_SETTINGS_FILE", instance_file)

    async def fake_register(username, password):
        return {
            "access_token": "tok",
            "user_id": f"@{username}:test.local",
            "device_id": "D",
        }

    async def fake_join_room(access_token, room_id):
        return None

    monkeypatch.setattr(registration_module, "register_matrix_user", fake_register)
    monkeypatch.setattr(registration_module, "join_room", fake_join_room)

    resp = await client.post(
        "/api/register",
        json={"username": "corr", "password": "hunter2hunter2"},
    )
    assert resp.status_code == 200, resp.text

    await db_session.refresh(lobby)
    assert lobby.owner_id == "@corr:test.local", (
        "BUG: first-boot operator did not inherit the bot-seeded Lobby. "
        f"lobby.owner_id is still {lobby.owner_id!r}. This is the regression "
        "that left corr as a plain member on the only server on their instance."
    )

    corr_membership = (await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == lobby.id,
            ServerMember.user_id == "@corr:test.local",
        )
    )).scalar_one()
    assert corr_membership.role == "owner"
    assert corr_membership.can_kick is True
    assert corr_membership.can_ban is True

    bot_membership = (await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == lobby.id,
            ServerMember.user_id == bot_user,
        )
    )).scalar_one()
    assert bot_membership.role == "admin", (
        "Bot should be demoted from owner to admin so it retains rights "
        "for bot-driven features without being the instance owner."
    )

    # Instance-admin list also records the operator on first boot.
    settings = json.loads(instance_file.read_text())
    assert settings.get("first_boot_complete") is True
    assert "@corr:test.local" in settings.get("admin_user_ids", [])


async def test_second_user_does_not_hijack_bot_lobby(
    client, db_session, monkeypatch, tmp_path
):
    """Negative control for the above: once first boot is complete, a
    subsequent registrant must NOT be promoted to owner, even if the
    Lobby is still bot-owned (e.g. an older instance where the operator
    never registered). Ownership transfer is a one-shot first-boot
    privilege, not a free-for-all."""
    import services.bot as bot_module

    bot_user = "@concord-bot:test.local"
    monkeypatch.setattr(bot_module, "BOT_USER_ID", bot_user)

    lobby = Server(
        id="srv_lobby_late",
        name="Concord Lobby",
        owner_id=bot_user,
        visibility="public",
    )
    db_session.add(lobby)
    db_session.add(ServerMember(server_id=lobby.id, user_id=bot_user, role="owner"))
    db_session.add(Channel(
        server_id=lobby.id,
        matrix_room_id="!late:test.local",
        name="general",
        position=0,
    ))
    await db_session.commit()

    instance_file = tmp_path / "instance.json"
    instance_file.write_text(json.dumps({
        "default_server_id": lobby.id,
        "first_boot_complete": True,
        "admin_user_ids": ["@someone-else:test.local"],
    }))
    monkeypatch.setattr(config_module, "INSTANCE_SETTINGS_FILE", instance_file)
    monkeypatch.setenv("OPEN_REGISTRATION", "true")

    async def fake_register(username, password):
        return {
            "access_token": "tok",
            "user_id": f"@{username}:test.local",
            "device_id": "D",
        }

    async def fake_join_room(access_token, room_id):
        return None

    monkeypatch.setattr(registration_module, "register_matrix_user", fake_register)
    monkeypatch.setattr(registration_module, "join_room", fake_join_room)

    resp = await client.post(
        "/api/register",
        json={"username": "drifter", "password": "hunter2hunter2"},
    )
    assert resp.status_code == 200, resp.text

    await db_session.refresh(lobby)
    assert lobby.owner_id == bot_user, (
        "Only the first-boot registrant may inherit the Lobby. A later "
        "sign-up must NOT hijack ownership."
    )
    drifter = (await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == lobby.id,
            ServerMember.user_id == "@drifter:test.local",
        )
    )).scalar_one()
    assert drifter.role == "member"
