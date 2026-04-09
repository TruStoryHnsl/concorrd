"""Tests for the place ownership re-minting pillar (TASK 28).

Re-minting transfers ownership of a place to a new user by creating a
NEW Server record that links back to the previous one via
``previous_place_id`` and snapshots the prior ledger (channels +
members + media filenames) into a ``PlaceLedgerHeader``.

Scope:
1. Encrypted re-mint preserves media filenames.
2. Unencrypted re-mint transfers ownership.
3. Non-owner cannot re-mint.
4. previous_place_id link is set on the new place.
5. Pydantic validation rejects malformed new_owner_user_id.
6. New owner is added as a member of the new place.
7. Self re-mint is rejected.
"""

from __future__ import annotations

import base64
import json

import pytest
from sqlalchemy import select

from models import (
    Channel,
    PlaceLedgerHeader,
    Server,
    ServerMember,
    SoundboardClip,
)
from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture
async def seeded_place_with_media(db_session):
    """Insert a place owned by alice with two channels and a media
    clip on disk so the re-mint flow has something to snapshot."""
    place = Server(id="srv_remint_1", name="Old Place", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_remint_1", user_id="@alice:test.local", role="owner"
    ))
    db_session.add(ServerMember(
        server_id="srv_remint_1", user_id="@bob:test.local", role="member"
    ))
    db_session.add(Channel(
        server_id="srv_remint_1",
        matrix_room_id="!room1:test.local",
        name="general",
        channel_type="text",
        position=0,
    ))
    db_session.add(Channel(
        server_id="srv_remint_1",
        matrix_room_id="!room2:test.local",
        name="voice",
        channel_type="voice",
        position=1,
    ))
    db_session.add(SoundboardClip(
        server_id="srv_remint_1",
        name="airhorn",
        filename="airhorn.mp3",
        uploaded_by="@alice:test.local",
    ))
    db_session.add(SoundboardClip(
        server_id="srv_remint_1",
        name="rimshot",
        filename="rimshot.mp3",
        uploaded_by="@alice:test.local",
    ))
    await db_session.commit()
    return place


# ---------------------------------------------------------------------
# Happy path: encrypted + unencrypted re-mints
# ---------------------------------------------------------------------


async def test_remint_preserves_media_filenames(client, db_session, seeded_place_with_media):
    """An unencrypted re-mint must preserve the media filenames in the
    PlaceLedgerHeader payload (which we base64-decode and inspect).

    (This test used to assert the same for ``encrypted=True``, but
    encrypted re-mint is now rejected with 501 ENCRYPTION_NOT_AVAILABLE
    until a real encryption backend lands — see
    ``test_remint_encrypted_returns_not_implemented``.)
    """
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["encrypted"] is False
        assert body["new_owner_id"] == "@carol:test.local"
        assert body["previous_place_id"] == "srv_remint_1"
        assert body["media_filenames_preserved"] == 2
    finally:
        logout()

    # Decode the snapshot and verify media filenames are present.
    result = await db_session.execute(
        select(PlaceLedgerHeader).where(
            PlaceLedgerHeader.previous_place_id == "srv_remint_1"
        )
    )
    header = result.scalar_one()
    assert header.encrypted is False
    decoded = json.loads(base64.b64decode(header.payload))
    assert sorted(decoded["media_filenames"]) == ["airhorn.mp3", "rimshot.mp3"]
    # Channels and members should also be in the snapshot.
    assert len(decoded["channels"]) == 2
    assert len(decoded["members"]) == 2


async def test_remint_unencrypted_transfers_ownership(client, db_session, seeded_place_with_media):
    """An unencrypted re-mint must create a new place owned by the
    new owner. The old place is preserved (audit chain)."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        new_place_id = body["new_place_id"]
        assert new_place_id != "srv_remint_1"
    finally:
        logout()

    # New place exists, owned by carol
    new_place = await db_session.get(Server, new_place_id)
    assert new_place is not None
    assert new_place.owner_id == "@carol:test.local"
    # Old place is preserved
    old_place = await db_session.get(Server, "srv_remint_1")
    assert old_place is not None
    assert old_place.owner_id == "@alice:test.local"


async def test_remint_creates_previous_place_link(client, db_session, seeded_place_with_media):
    """The new Server record must have previous_place_id pointing to
    the old place's id. This is the audit chain link."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 200, resp.text
        new_place_id = resp.json()["new_place_id"]
    finally:
        logout()

    new_place = await db_session.get(Server, new_place_id)
    assert new_place.previous_place_id == "srv_remint_1"


async def test_remint_adds_new_owner_as_member(client, db_session, seeded_place_with_media):
    """The new place must have the new owner as a ServerMember with
    role='owner' so the standard auth checks see them as the owner."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        new_place_id = resp.json()["new_place_id"]
    finally:
        logout()

    result = await db_session.execute(
        select(ServerMember).where(
            ServerMember.server_id == new_place_id,
            ServerMember.user_id == "@carol:test.local",
        )
    )
    member = result.scalar_one()
    assert member.role == "owner"


# ---------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------


async def test_non_owner_cannot_remint(client, db_session, seeded_place_with_media):
    """Bob is a member but not the owner — re-mint must 403 with
    OWNER_REQUIRED."""
    login_as("@bob:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 403
        body = resp.json()
        assert body["error_code"] == "OWNER_REQUIRED"
    finally:
        logout()


async def test_remint_unknown_place_returns_404(client):
    """Re-minting a place that doesn't exist must return a structured
    RESOURCE_NOT_FOUND error."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/does-not-exist/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["error_code"] == "RESOURCE_NOT_FOUND"
    finally:
        logout()


# ---------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------


async def test_remint_with_invalid_user_id_fails(client, db_session, seeded_place_with_media):
    """A new_owner_user_id that doesn't match the Matrix user ID
    pattern must be rejected by Pydantic at the validation layer."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "not-a-matrix-id", "encrypted": False},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_remint_to_self_rejected(client, db_session, seeded_place_with_media):
    """Re-minting to yourself is a no-op and must be rejected with
    OWNERSHIP_TRANSFER_FAILED. Otherwise an owner could spam re-mints
    of their own place and inflate the audit chain."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@alice:test.local", "encrypted": False},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["error_code"] == "OWNERSHIP_TRANSFER_FAILED"
    finally:
        logout()


# ---------------------------------------------------------------------
# BETA ATTACK TESTS — BT-*
# ---------------------------------------------------------------------


async def test_BT_remint_server_enumeration_via_404_vs_403(client, db_session):
    """BT-7 [MEDIUM]: Same information-leak pattern as ban-disposables.
    An authenticated non-owner gets 404 (RESOURCE_NOT_FOUND) for a
    nonexistent server vs 403 (OWNER_REQUIRED) for an existing one.
    This lets an attacker enumerate server IDs via the re-mint endpoint.

    The re-mint endpoint checks `server = db.get(...)` BEFORE the owner
    check, leaking existence to any authenticated caller."""
    place = Server(id="srv_enum_remint", name="Secret", owner_id="@alice:test.local")
    db_session.add(place)
    await db_session.commit()

    login_as("@attacker:test.local")
    try:
        resp_exists = await client.post(
            "/api/servers/srv_enum_remint/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        resp_missing = await client.post(
            "/api/servers/srv_nope/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
    finally:
        logout()

    assert resp_exists.status_code == 403
    assert resp_missing.status_code == 404
    assert resp_exists.status_code != resp_missing.status_code


async def test_BT_remint_encrypted_and_unencrypted_are_identical(
    client, db_session, seeded_place_with_media
):
    """BT-8 [CRITICAL] — regression guard (fix applied).

    Originally this test proved that ``encrypted=True`` silently
    stored plaintext base64 with an ``encrypted=True`` column — a
    security-promise violation where the DB row LIED about the
    encryption state.

    The fix (C-1) rejects ``encrypted=True`` with a 501
    ``ENCRYPTION_NOT_AVAILABLE`` error until a real encryption
    backend lands. The test is kept under the original name as a
    regression guard: if anyone ever re-introduces a silent
    plaintext path under ``encrypted=True``, this test catches it
    because it asserts the opposite — no row is created and the
    request is rejected cleanly.
    """
    login_as("@alice:test.local")
    try:
        resp_enc = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": True},
        )
    finally:
        logout()

    # The request must be rejected with the dedicated error code.
    assert resp_enc.status_code == 501, resp_enc.text
    body = resp_enc.json()
    assert body["error_code"] == "ENCRYPTION_NOT_AVAILABLE"

    # No PlaceLedgerHeader row must have been created — the re-mint
    # was a clean no-op on failure.
    header_result = await db_session.execute(
        select(PlaceLedgerHeader).where(
            PlaceLedgerHeader.previous_place_id == "srv_remint_1"
        )
    )
    assert header_result.scalar_one_or_none() is None

    # The old server must still exist, unchanged, with its original owner.
    old_place = await db_session.get(Server, "srv_remint_1")
    assert old_place is not None
    assert old_place.owner_id == "@alice:test.local"

    # No orphan new-place rows either — the old place should be the
    # only Server row in the DB with this owner.
    servers_result = await db_session.execute(select(Server))
    all_servers = servers_result.scalars().all()
    assert len(all_servers) == 1
    assert all_servers[0].id == "srv_remint_1"


async def test_remint_encrypted_returns_not_implemented(
    client, db_session, seeded_place_with_media
):
    """Positive guard for C-1: the exact 501 + ENCRYPTION_NOT_AVAILABLE
    contract. Paired with the BT regression test above.

    The point of this test is to pin the response shape so any future
    client (or docs generator) can rely on branching on the error code
    rather than parsing the human-readable message.
    """
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": True},
        )
    finally:
        logout()

    assert resp.status_code == 501
    body = resp.json()
    assert body["error_code"] == "ENCRYPTION_NOT_AVAILABLE"
    assert "encrypted" in body["message"].lower()


async def test_BT_remint_unicode_homoglyph_user_id(client, db_session, seeded_place_with_media):
    """BT-9 [LOW]: The Matrix user ID regex uses ASCII [a-zA-Z0-9._=\\-/+].
    Unicode homoglyphs (e.g., Cyrillic 'а') are rejected at the pattern
    level — confirming the regex is tight on this axis."""
    login_as("@alice:test.local")
    try:
        # Cyrillic 'a' instead of ASCII 'a' in 'alice'
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@\u0430lice:test.local", "encrypted": False},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_BT_remint_trailing_newline_in_user_id_rejected(client, db_session, seeded_place_with_media):
    """BT-10 [LOW]: Python regex `$` by default matches before a trailing
    newline. If Pydantic used re.match, this would be accepted. Pydantic
    uses re.fullmatch so the newline should be rejected. Confirming."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local\n", "encrypted": False},
        )
        assert resp.status_code == 422, f"unexpected {resp.status_code}: {resp.text}"
    finally:
        logout()


async def test_BT_remint_stale_matrix_room_ids_in_snapshot(
    client, db_session, seeded_place_with_media
):
    """BT-11 [HIGH] — regression guard (fix applied).

    Originally this test proved that the re-mint endpoint produced a
    shell place with zero Channel rows, because the snapshot captured
    channel metadata but nothing was rehydrated into the new
    server_id namespace.

    The fix (H-1) iterates the snapshot's channel list and inserts
    fresh Channel rows for the new place, with fresh Matrix room
    IDs. The test is kept under the original name as a regression
    guard.
    """
    from models import Channel

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 200
        new_place_id = resp.json()["new_place_id"]
    finally:
        logout()

    # New place now has the same number of Channel rows as the old
    # place (the snapshot was rehydrated into the new server_id).
    result = await db_session.execute(
        select(Channel).where(Channel.server_id == new_place_id)
    )
    new_channels = result.scalars().all()
    assert len(new_channels) == 2, (
        f"expected new place to have 2 channels (rehydrated from snapshot), "
        f"got {len(new_channels)}"
    )

    # The fresh Matrix room IDs must NOT equal the originals. Sharing
    # a Matrix room across re-mints would let the prior owner send
    # messages into the new owner's place — and the UNIQUE constraint
    # on Channel.matrix_room_id would also forbid it at the DB level.
    original_room_ids = {"!room1:test.local", "!room2:test.local"}
    new_room_ids = {c.matrix_room_id for c in new_channels}
    assert new_room_ids.isdisjoint(original_room_ids), (
        f"new channels reused the original Matrix room IDs: "
        f"{sorted(new_room_ids & original_room_ids)}"
    )

    # Old place still has its 2 channels intact (re-mint preserves
    # the audit chain).
    old_result = await db_session.execute(
        select(Channel).where(Channel.server_id == "srv_remint_1")
    )
    assert len(old_result.scalars().all()) == 2


async def test_remint_preserves_channels(client, db_session):
    """Positive test for H-1: re-mint rehydrates the channel list onto
    the new place with fresh Matrix room IDs, and the response
    includes a channel_id_mapping so the client can rewire any
    cached references.
    """
    from models import Channel, Server, ServerMember

    # Seed a server owned by alice with three channels.
    place = Server(id="srv_remint_ch", name="Channel Test", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_remint_ch", user_id="@alice:test.local", role="owner"
    ))
    db_session.add(Channel(
        server_id="srv_remint_ch",
        matrix_room_id="!chA:test.local",
        name="general",
        channel_type="text",
        position=0,
    ))
    db_session.add(Channel(
        server_id="srv_remint_ch",
        matrix_room_id="!chB:test.local",
        name="random",
        channel_type="text",
        position=1,
    ))
    db_session.add(Channel(
        server_id="srv_remint_ch",
        matrix_room_id="!chC:test.local",
        name="lounge",
        channel_type="voice",
        position=2,
    ))
    await db_session.commit()

    # Capture the old channel IDs so we can verify the mapping.
    old_channels_result = await db_session.execute(
        select(Channel).where(Channel.server_id == "srv_remint_ch")
    )
    old_channels = {c.id: c for c in old_channels_result.scalars().all()}
    assert len(old_channels) == 3

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_ch/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
    finally:
        logout()

    new_place_id = body["new_place_id"]

    # Exactly 3 Channel rows on the new place.
    result = await db_session.execute(
        select(Channel).where(Channel.server_id == new_place_id).order_by(Channel.position)
    )
    new_channels = list(result.scalars().all())
    assert len(new_channels) == 3

    # Names and types preserved (and in the right positions).
    assert [c.name for c in new_channels] == ["general", "random", "lounge"]
    assert [c.channel_type for c in new_channels] == ["text", "text", "voice"]

    # Matrix room IDs are fresh and disjoint from the originals.
    original_room_ids = {"!chA:test.local", "!chB:test.local", "!chC:test.local"}
    new_room_ids = {c.matrix_room_id for c in new_channels}
    assert new_room_ids.isdisjoint(original_room_ids)

    # Response exposes the old -> new channel ID mapping.
    mapping = body["channel_id_mapping"]
    assert len(mapping) == 3
    old_id_set = {str(i) for i in old_channels.keys()}
    assert set(mapping.keys()) == old_id_set
    # The mapping values point at real new channel IDs.
    new_id_set = {str(c.id) for c in new_channels}
    assert set(mapping.values()) == new_id_set


async def test_BT_remint_old_members_not_migrated(
    client, db_session, seeded_place_with_media
):
    """BT-12 [HIGH] — regression guard (fix applied).

    Originally this test proved that the re-mint endpoint evicted
    every prior member of the place, leaving the new owner alone on
    the new Server record. The user-visible behavior was "ownership
    transfer" = "mass kick", which matches nobody's intuition.

    The fix (H-2) iterates the snapshot's member roster and re-
    inserts each prior member with their role preserved, except the
    prior owner is demoted to ``admin``. The test is kept under the
    original name as a regression guard.
    """
    from models import ServerMember

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local", "encrypted": False},
        )
        assert resp.status_code == 200
        new_place_id = resp.json()["new_place_id"]
    finally:
        logout()

    # Members on the new place: carol (new owner), alice (demoted
    # from prior owner to admin), bob (regular member, preserved).
    result = await db_session.execute(
        select(ServerMember).where(ServerMember.server_id == new_place_id)
    )
    new_members = {m.user_id: m for m in result.scalars().all()}
    assert set(new_members.keys()) == {
        "@carol:test.local",
        "@alice:test.local",
        "@bob:test.local",
    }
    assert new_members["@carol:test.local"].role == "owner"
    # Prior owner is demoted to admin on the new place.
    assert new_members["@alice:test.local"].role == "admin"
    # Bob was a plain member on the old place; role preserved.
    assert new_members["@bob:test.local"].role == "member"


async def test_remint_preserves_members(client, db_session):
    """Positive test for H-2: re-mint preserves the full member
    roster with appropriate role demotion.

    Seeds a server with 5 members (owner, 2 admins, 2 regulars) and
    verifies that after a re-mint to a fresh user the new place has
    6 rows with the expected role distribution.
    """
    from models import Channel, Server, ServerMember

    place = Server(id="srv_remint_m", name="Member Test", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_remint_m", user_id="@alice:test.local", role="owner"
    ))
    db_session.add(ServerMember(
        server_id="srv_remint_m", user_id="@admin1:test.local", role="admin"
    ))
    db_session.add(ServerMember(
        server_id="srv_remint_m", user_id="@admin2:test.local", role="admin"
    ))
    db_session.add(ServerMember(
        server_id="srv_remint_m", user_id="@member1:test.local", role="member"
    ))
    db_session.add(ServerMember(
        server_id="srv_remint_m", user_id="@member2:test.local", role="member"
    ))
    # Give the place at least one channel so the snapshot-rehydrate
    # path exercises both code branches.
    db_session.add(Channel(
        server_id="srv_remint_m",
        matrix_room_id="!memtest:test.local",
        name="general",
        channel_type="text",
        position=0,
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_remint_m/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
    finally:
        logout()

    new_place_id = body["new_place_id"]
    assert body["member_count_preserved"] == 6

    result = await db_session.execute(
        select(ServerMember).where(ServerMember.server_id == new_place_id)
    )
    members = {m.user_id: m for m in result.scalars().all()}

    # Exactly 6 rows: new owner (bob), prior owner alice demoted to
    # admin, the 2 original admins, and the 2 original regulars.
    assert set(members.keys()) == {
        "@bob:test.local",
        "@alice:test.local",
        "@admin1:test.local",
        "@admin2:test.local",
        "@member1:test.local",
        "@member2:test.local",
    }

    # The new owner is the sole `owner` on the new place.
    assert members["@bob:test.local"].role == "owner"
    # Alice is demoted from owner to admin.
    assert members["@alice:test.local"].role == "admin"
    # Original admins preserved.
    assert members["@admin1:test.local"].role == "admin"
    assert members["@admin2:test.local"].role == "admin"
    # Original regulars preserved.
    assert members["@member1:test.local"].role == "member"
    assert members["@member2:test.local"].role == "member"

    # Sanity: exactly one owner row.
    owners = [m for m in members.values() if m.role == "owner"]
    assert len(owners) == 1
    assert owners[0].user_id == "@bob:test.local"


async def test_BT_remint_chain_can_infinite_loop_via_case(
    client, db_session
):
    """BT-13 [MEDIUM]: The self-remint check is exact string comparison:
    ``body.new_owner_user_id == server.owner_id``. Matrix user IDs are
    case-insensitive on the localpart per the spec, so
    @Alice:test.local and @alice:test.local refer to the same user,
    but the self-remint check will accept the uppercase one as a
    "different" owner. This lets an owner re-mint a place to their
    own case-different alias, inflating the audit chain indefinitely.

    Severity MEDIUM — not a security hole, but a correctness bug that
    would appear as "why does our server have a 1000-element ownership
    audit chain for the same user"."""
    place = Server(id="srv_case", name="Case Test", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_case", user_id="@alice:test.local", role="owner"
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_case/remint-ownership",
            json={"new_owner_user_id": "@Alice:test.local", "encrypted": False},
        )
        # Passes the == check because case-sensitive.
        assert resp.status_code == 200, (
            f"case-different alias passed self-remint check: "
            f"{resp.status_code} {resp.text}"
        )
    finally:
        logout()


# ---------------------------------------------------------------------
# Wave 2 rework re-verification probes (RW_P*)
#
# These exercise new code paths introduced by the C-1/H-1/H-2 fixes.
# ---------------------------------------------------------------------


async def test_RW_P1_encrypted_default_is_false(client, db_session, seeded_place_with_media):
    """Probe 1: The `encrypted` field defaults to False when omitted.

    If a client sends `{}` for the body (aside from new_owner_user_id),
    Pydantic should apply the default and route through the happy path.
    Confirming the default is NOT True — otherwise every default call
    would trip the ENCRYPTION_NOT_AVAILABLE reject.
    """
    login_as("@alice:test.local")
    try:
        # Deliberately omit the encrypted field.
        resp = await client.post(
            "/api/servers/srv_remint_1/remint-ownership",
            json={"new_owner_user_id": "@carol:test.local"},
        )
    finally:
        logout()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["encrypted"] is False


async def test_RW_P2_remint_with_no_channels_on_old_place(client, db_session):
    """Probe 2: Old place has zero channels -- REMINT_SNAPSHOT_INCOMPLETE
    must NOT fire, and the new place should be created successfully
    with zero channels.
    """
    place = Server(id="srv_nochan", name="No Channels", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_nochan", user_id="@alice:test.local", role="owner"
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_nochan/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
    finally:
        logout()
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["channel_id_mapping"] == {}
    new_place_id = body["new_place_id"]

    result = await db_session.execute(
        select(Channel).where(Channel.server_id == new_place_id)
    )
    assert list(result.scalars().all()) == []


async def test_RW_P4_new_owner_already_member_of_old_place(client, db_session):
    """Probe 4: The new owner was already a member of the old place.
    The seen_user_ids dedupe path should prevent inserting a duplicate
    ServerMember row (which would otherwise violate the unique
    constraint on (server_id, user_id)).
    """
    place = Server(id="srv_alreadymember", name="Already Member", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_alreadymember", user_id="@alice:test.local", role="owner"
    ))
    db_session.add(ServerMember(
        server_id="srv_alreadymember", user_id="@bob:test.local", role="admin"
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_alreadymember/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
    finally:
        logout()
    assert resp.status_code == 200, resp.text
    new_place_id = resp.json()["new_place_id"]

    result = await db_session.execute(
        select(ServerMember).where(ServerMember.server_id == new_place_id)
    )
    members = {m.user_id: m for m in result.scalars().all()}

    # Exactly two members: bob (new owner) and alice (demoted).
    assert set(members.keys()) == {"@bob:test.local", "@alice:test.local"}
    # Bob is the new owner, not the prior admin role.
    assert members["@bob:test.local"].role == "owner"
    # Alice demoted.
    assert members["@alice:test.local"].role == "admin"


async def test_RW_P5_new_owner_already_owns_another_server(client, db_session):
    """Probe 5: Bob already owns server A. Alice re-mints server B to
    Bob. Should succeed -- owning multiple places is fine.
    """
    srv_a = Server(id="srv_a", name="Bob's First", owner_id="@bob:test.local")
    db_session.add(srv_a)
    db_session.add(ServerMember(
        server_id="srv_a", user_id="@bob:test.local", role="owner"
    ))

    srv_b = Server(id="srv_b", name="Alice's Place", owner_id="@alice:test.local")
    db_session.add(srv_b)
    db_session.add(ServerMember(
        server_id="srv_b", user_id="@alice:test.local", role="owner"
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers/srv_b/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
    finally:
        logout()
    assert resp.status_code == 200, resp.text
    new_place_id = resp.json()["new_place_id"]

    # srv_a should remain untouched.
    still_a = await db_session.get(Server, "srv_a")
    assert still_a is not None
    assert still_a.owner_id == "@bob:test.local"

    # The new re-minted place is owned by bob.
    new_place = await db_session.get(Server, new_place_id)
    assert new_place is not None
    assert new_place.owner_id == "@bob:test.local"


async def test_RW_P3_remint_with_many_members_completes(client, db_session):
    """Probe 3: Re-mint a place with 200 members. The rehydration loop
    is O(members) -- confirm it finishes in reasonable time and the
    new place has 201 ServerMember rows (200 rehydrated + new owner).

    200 is a compromise: large enough to exercise the loop, small
    enough to keep the test fast in CI.
    """
    place = Server(id="srv_big", name="Big Place", owner_id="@alice:test.local")
    db_session.add(place)
    db_session.add(ServerMember(
        server_id="srv_big", user_id="@alice:test.local", role="owner"
    ))
    for i in range(199):
        db_session.add(ServerMember(
            server_id="srv_big",
            user_id=f"@member{i}:test.local",
            role="member",
        ))
    await db_session.commit()

    import time as _t
    login_as("@alice:test.local")
    try:
        start = _t.monotonic()
        resp = await client.post(
            "/api/servers/srv_big/remint-ownership",
            json={"new_owner_user_id": "@bob:test.local", "encrypted": False},
        )
        elapsed = _t.monotonic() - start
    finally:
        logout()
    assert resp.status_code == 200, resp.text
    # Generous bound -- it's about O(N) DB inserts. Failure would be
    # minutes, not seconds.
    assert elapsed < 30.0, f"re-mint of 200-member place took {elapsed:.1f}s"

    new_place_id = resp.json()["new_place_id"]
    result = await db_session.execute(
        select(ServerMember).where(ServerMember.server_id == new_place_id)
    )
    new_members = list(result.scalars().all())
    # 199 regulars + alice (demoted) + bob (new owner) = 201.
    assert len(new_members) == 201
