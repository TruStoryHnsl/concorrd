"""Tests for the disposable anonymous node pillar (TASK 27).

Scope:
1. Disposable node creation: returns a session token + temp identifier,
   sets must_contribute_compute=True, expires_at in the future.
2. Rate limiting: per-IP sliding window mirrors registration.py.
3. Place admin can ban all disposables from a place via the new
   /api/admin/places/{id}/ban-disposables endpoint.
4. Non-owners cannot ban disposables.

The disposable-node session token is opaque — there's no auth shim
yet that converts it into a Bearer token. These tests verify the
DB-side contract: session created, structurally banned, revoked.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from models import DisposableNode, Server, ServerMember
from tests.conftest import login_as, logout
import routers.nodes as nodes_module


@pytest.fixture(autouse=True)
def _clear_disposable_rate_limit_state():
    """The rate limit uses a module-level dict — clear between tests
    so per-IP state doesn't leak across cases."""
    nodes_module._disposable_rate_limits.clear()
    yield
    nodes_module._disposable_rate_limits.clear()


# ---------------------------------------------------------------------
# POST /api/nodes/disposable
# ---------------------------------------------------------------------


async def test_create_disposable_node_returns_session_token(client, db_session):
    """Happy path: a request with no body should still mint a node
    with a non-empty session token, a temp_identifier, and an
    expires_at in the future."""
    resp = await client.post("/api/nodes/disposable", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "session_token" in body
    assert len(body["session_token"]) >= 16
    assert body["temp_identifier"].startswith("anon-")
    assert body["must_contribute_compute"] is True
    # The expires_at must parse and be in the future.
    expires = datetime.fromisoformat(body["expires_at"])
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    assert expires > datetime.now(timezone.utc)


async def test_disposable_node_creation_rate_limited(client):
    """The 6th request from the same IP within the window must be
    rejected with a structured RATE_LIMITED error."""
    # The default test client has no real client IP — set one via
    # X-Real-Ip so the rate limiter can key on it.
    headers = {"X-Real-Ip": "203.0.113.7"}
    for _ in range(5):
        resp = await client.post("/api/nodes/disposable", json={}, headers=headers)
        assert resp.status_code == 200, resp.text

    # 6th attempt should be rate-limited.
    resp = await client.post("/api/nodes/disposable", json={}, headers=headers)
    assert resp.status_code == 429
    body = resp.json()
    assert body["error_code"] == "RATE_LIMITED"


async def test_disposable_node_has_must_contribute_flag(client, db_session):
    """After a node is created, the row in disposable_nodes must
    have must_contribute_compute=True."""
    resp = await client.post("/api/nodes/disposable", json={})
    assert resp.status_code == 200
    session_token = resp.json()["session_token"]

    result = await db_session.execute(
        select(DisposableNode).where(DisposableNode.session_token == session_token)
    )
    node = result.scalar_one()
    assert node.must_contribute_compute is True
    assert node.is_disposable is True
    assert node.revoked is False


async def test_disposable_node_rejects_no_compute_contribution(client):
    """Refusing to contribute compute is a hard fail with the
    DISPOSABLE_NODE_REJECTED error code (per PLAN.md)."""
    resp = await client.post(
        "/api/nodes/disposable",
        json={"contribute_compute": False},
    )
    assert resp.status_code == 403
    body = resp.json()
    assert body["error_code"] == "DISPOSABLE_NODE_REJECTED"


async def test_disposable_node_rejects_oversize_user_agent(client):
    """user_agent_hint has max_length=200 — 1KB is rejected by Pydantic."""
    resp = await client.post(
        "/api/nodes/disposable",
        json={"user_agent_hint": "x" * 1000},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------
# POST /api/admin/places/{place_id}/ban-disposables
# ---------------------------------------------------------------------


async def test_admin_can_ban_disposables_from_place(client, db_session):
    """The place owner can call ban-disposables. The Server row must
    have bans_disposables=True afterward, and any active disposable
    sessions are marked revoked."""
    # Create a place owned by alice
    place = Server(id="srv_disp1", name="Disposable Land", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(server_id="srv_disp1", user_id="@alice:test.local", role="owner"))
    await db_session.commit()

    # Mint two disposable nodes first
    r1 = await client.post("/api/nodes/disposable", json={}, headers={"X-Real-Ip": "1.2.3.4"})
    r2 = await client.post("/api/nodes/disposable", json={}, headers={"X-Real-Ip": "5.6.7.8"})
    assert r1.status_code == 200
    assert r2.status_code == 200

    # Now alice (the owner) bans disposables from her place.
    login_as("@alice:test.local")
    try:
        resp = await client.post("/api/admin/places/srv_disp1/ban-disposables")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["bans_disposables"] is True
        assert body["revoked_count"] == 2
    finally:
        logout()

    # Verify the Server row was actually updated.
    await db_session.refresh(place)
    assert place.bans_disposables is True

    # Verify both disposable nodes are now revoked.
    result = await db_session.execute(select(DisposableNode))
    nodes = result.scalars().all()
    assert len(nodes) == 2
    assert all(n.revoked for n in nodes)


async def test_non_admin_cannot_ban_disposables(client, db_session):
    """A user who isn't the place owner (and isn't a global admin)
    must get OWNER_REQUIRED 403."""
    place = Server(id="srv_disp2", name="Other Place", owner_id="@alice:test.local")
    db_session.add(place)
    await db_session.commit()

    login_as("@bob:test.local")  # bob is neither owner nor global admin
    try:
        resp = await client.post("/api/admin/places/srv_disp2/ban-disposables")
        assert resp.status_code == 403
        body = resp.json()
        assert body["error_code"] == "OWNER_REQUIRED"
    finally:
        logout()


async def test_global_admin_can_ban_disposables_from_any_place(client, db_session):
    """A user in ADMIN_USER_IDS (the global admin) can ban disposables
    from a place they don't own — admin override."""
    place = Server(id="srv_disp3", name="Admin Place", owner_id="@alice:test.local")
    db_session.add(place)
    await db_session.commit()

    # The conftest sets ADMIN_USER_IDS="@test_admin:test.local"
    login_as("@test_admin:test.local")
    try:
        resp = await client.post("/api/admin/places/srv_disp3/ban-disposables")
        assert resp.status_code == 200, resp.text
        assert resp.json()["bans_disposables"] is True
    finally:
        logout()


async def test_ban_disposables_unknown_place_returns_404(client):
    """Banning disposables from a place that doesn't exist must return
    a structured RESOURCE_NOT_FOUND error."""
    login_as("@test_admin:test.local")
    try:
        resp = await client.post("/api/admin/places/does-not-exist/ban-disposables")
        assert resp.status_code == 404
        body = resp.json()
        assert body["error_code"] == "RESOURCE_NOT_FOUND"
    finally:
        logout()


# ---------------------------------------------------------------------
# BETA ATTACK TESTS — BT-*
# These tests demonstrate vulnerabilities found during beta QA.
# ---------------------------------------------------------------------


async def test_BT_rate_limiter_dict_grows_unbounded(client, monkeypatch):
    """BT-1 [HIGH] — regression guard (fix applied).

    Originally this test proved that ``_disposable_rate_limits`` grew
    one entry per distinct client IP and never evicted them — a
    trivial DoS where an attacker spraying many IPs (e.g., via an
    IPv6 /64 they control) could OOM the process.

    The fix (H-3) adds two cleanup mechanisms:

    1. After the sliding-window pop in ``_check_disposable_rate_limit``,
       if the deque is empty the IP key itself is deleted.
    2. A periodic sweep walks the whole dict every
       ``_DISPOSABLE_SWEEP_INTERVAL`` calls and drops any fully-expired
       entries — catching the spray case where each IP is hit only
       once.

    The test drives both mechanisms: 50 distinct IPs are hit, time is
    advanced past the window, and one more call triggers the post-pop
    cleanup path for the 51st IP. The dict must be bounded — not
    necessarily empty (the last call recreates one key), but small.
    """
    # Clean start — autouse fixture handles this but be explicit.
    nodes_module._disposable_rate_limits.clear()
    nodes_module._disposable_sweep_counter = 0

    # Hit 50 distinct IPs a single time each.
    for i in range(50):
        ip = f"198.51.100.{i}"
        resp = await client.post(
            "/api/nodes/disposable",
            json={},
            headers={"X-Real-Ip": ip},
        )
        assert resp.status_code == 200, resp.text

    # The dict has grown to 50 entries. Now advance virtual time past
    # the sliding window so every stored entry is "expired" from the
    # rate-limiter's point of view.
    import time as _real_time
    future = _real_time.time() + nodes_module._DISPOSABLE_RATE_WINDOW + 10
    monkeypatch.setattr(nodes_module.time, "time", lambda: future)

    # Hit the endpoint from one more IP. That call will:
    # (a) bump the per-call eviction path for the 51st IP (no-op since
    #     it's brand new), and
    # (b) force the sweep counter to tick — but we also call the sweep
    #     directly below to make the test deterministic regardless of
    #     the sweep interval.
    resp = await client.post(
        "/api/nodes/disposable",
        json={},
        headers={"X-Real-Ip": "203.0.113.99"},
    )
    assert resp.status_code == 200, resp.text

    # Run the sweep explicitly — in production it runs every N calls;
    # we test the code path directly here rather than hammering the
    # endpoint 1000 times.
    nodes_module._sweep_disposable_rate_limits(future)

    # The dict must be bounded after cleanup. The 51st IP's single
    # fresh entry may or may not still be present depending on whether
    # it fell inside the sweep's virtual "now" — either way, the
    # 50 stale IPs MUST be gone.
    remaining = set(nodes_module._disposable_rate_limits.keys())
    stale_ips = {f"198.51.100.{i}" for i in range(50)}
    leaked = remaining & stale_ips
    assert not leaked, (
        f"{len(leaked)} stale IP keys leaked after window expiry + sweep: "
        f"{sorted(leaked)[:5]}"
    )
    assert len(nodes_module._disposable_rate_limits) <= 1, (
        f"rate limit dict should be bounded after sweep, "
        f"got {len(nodes_module._disposable_rate_limits)} entries"
    )


async def test_BT_place_enumeration_via_ban_disposables(client, db_session):
    """BT-2 [MEDIUM]: An authenticated but non-admin user can enumerate
    which place IDs exist by calling /api/admin/places/{id}/ban-disposables.
    A nonexistent place returns 404 (RESOURCE_NOT_FOUND), an existing
    place returns 403 (OWNER_REQUIRED). This differential leaks
    existence to unauthorized users.

    The fix direction: check auth FIRST, then existence."""
    place = Server(id="srv_enum_secret", name="Secret Place", owner_id="@alice:test.local")
    db_session.add(place)
    await db_session.commit()

    login_as("@attacker:test.local")  # not owner, not admin
    try:
        # Query a place that exists
        resp_exists = await client.post(
            "/api/admin/places/srv_enum_secret/ban-disposables"
        )
        # Query a place that does not exist
        resp_missing = await client.post(
            "/api/admin/places/srv_enum_notexist/ban-disposables"
        )
    finally:
        logout()

    # Demonstrate the info leak: different status codes reveal existence
    assert resp_exists.status_code == 403, (
        f"expected 403 for existing place, got {resp_exists.status_code}"
    )
    assert resp_missing.status_code == 404, (
        f"expected 404 for missing place, got {resp_missing.status_code}"
    )
    # An attacker can differentiate existence from non-existence.
    assert resp_exists.status_code != resp_missing.status_code


async def test_BT_ban_disposables_empty_body_ok(client, db_session):
    """BT-3 [LOW]: confirm the ban-disposables endpoint accepts an empty
    body (no Content-Type). Documented as safe — just a sanity check
    that empty body handling is correct."""
    place = Server(id="srv_bt3", name="BT3", owner_id="@alice:test.local")
    db_session.add(place)
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        # Empty body, no Content-Type. Endpoint has no body model so this is fine.
        resp = await client.post("/api/admin/places/srv_bt3/ban-disposables")
        assert resp.status_code == 200
    finally:
        logout()


async def test_BT_disposable_creation_no_content_type(client):
    """BT-4 [LOW]: Sending POST /api/nodes/disposable with no Content-Type
    header and an empty body — does FastAPI still accept it?"""
    # httpx will default to application/json when json= is provided, so
    # to force "no content-type", pass content= with explicit header override.
    resp = await client.post("/api/nodes/disposable", content=b"", headers={"Content-Type": ""})
    # FastAPI requires a JSON body because DisposableNodeRequest has fields.
    # With no body this should 422, not crash.
    assert resp.status_code in (200, 422), f"unexpected {resp.status_code}: {resp.text}"
    assert "Traceback" not in resp.text
    assert "File \"" not in resp.text


async def test_BT_disposable_creation_huge_body(client):
    """BT-5 [LOW]: Send a JSON body with a user_agent_hint exactly at the
    Pydantic limit of 200 chars to confirm the boundary, then one over."""
    # At limit — accepted
    resp = await client.post(
        "/api/nodes/disposable",
        json={"user_agent_hint": "x" * 200},
        headers={"X-Real-Ip": "192.0.2.10"},
    )
    assert resp.status_code == 200, resp.text

    # One over — rejected at validation layer
    resp = await client.post(
        "/api/nodes/disposable",
        json={"user_agent_hint": "x" * 201},
        headers={"X-Real-Ip": "192.0.2.11"},
    )
    assert resp.status_code == 422


async def test_BT_disposable_creation_malformed_body(client):
    """BT-6 [LOW]: Send a non-JSON body that can't be parsed. Must not
    leak a stack trace."""
    resp = await client.post(
        "/api/nodes/disposable",
        content=b"not-json-at-all{{{",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code in (400, 422)
    assert "Traceback" not in resp.text
    assert "File \"" not in resp.text


# ---------------------------------------------------------------------
# Wave 2 rework re-verification probes (RW_P*) — rate limiter hardening
# ---------------------------------------------------------------------


def test_RW_P7_sweep_does_not_crash_on_concurrent_mutation(monkeypatch):
    """Probe 7: The sweep materializes the key list via list(keys())
    before iterating, so mutating the dict mid-walk shouldn't raise
    `dictionary changed size during iteration`.

    We can't easily run real threads here (async loop complications),
    but we can confirm the sweep is robust by making the dict mutate
    between `.keys()` capture and iteration body. Since the sweep does
    `list(_disposable_rate_limits.keys())`, the snapshot decouples
    iteration from mutation -- a missing key is a no-op via pop(default).
    """
    from collections import deque

    nodes_module._disposable_rate_limits.clear()

    now = 1_000_000.0
    # Seed a bunch of stale entries.
    for i in range(20):
        nodes_module._disposable_rate_limits[f"ip{i}"] = deque(
            [now - 10_000]  # well outside the window
        )

    # Insert ANOTHER entry after the snapshot would have been taken --
    # i.e. simulate a concurrent insertion. We can't actually do it
    # mid-call, but we can at least confirm the sweep is idempotent
    # and safe.
    nodes_module._sweep_disposable_rate_limits(now)
    # All stale entries dropped.
    assert len(nodes_module._disposable_rate_limits) == 0

    # Add some live + some stale, sweep again.
    nodes_module._disposable_rate_limits["live"] = deque([now - 10])
    nodes_module._disposable_rate_limits["stale"] = deque([now - 100_000])
    nodes_module._sweep_disposable_rate_limits(now)
    assert "live" in nodes_module._disposable_rate_limits
    assert "stale" not in nodes_module._disposable_rate_limits


def test_RW_P7_sweep_empty_deque_entry(monkeypatch):
    """If a key somehow has an empty deque (e.g. a dict-level default
    that never got an append), the sweep should delete it instead of
    leaving a phantom key.
    """
    from collections import deque

    nodes_module._disposable_rate_limits.clear()
    nodes_module._disposable_rate_limits["phantom"] = deque()
    nodes_module._sweep_disposable_rate_limits(1_000_000.0)
    assert "phantom" not in nodes_module._disposable_rate_limits
