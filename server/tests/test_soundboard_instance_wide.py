"""INS-073: instance-wide soundboard library + Freesound attribution.

These tests verify the ENDPOINT-LEVEL behavior the user asked for:
when alice uploads a clip to server A and bob is a member of server B
(distinct, but on the same instance), bob should see alice's clip in
the library response. They also lock in the Freesound attribution
contract — a clip imported with license + author metadata must surface
those fields on every subsequent listing.

Test rigor notes (per project CLAUDE.md "WRITTEN IN BLOOD"):

- Asserts what the **HTTP client sees**, not internal model fields, so
  a future refactor that breaks the API surface will fail loudly.
- Uses the real-sqlite per-test fixture from conftest. No DB mocking.
- Same-session author risk acknowledged in the PM final report — a
  cold-reader pass is recommended for the Freesound license proxy
  before claiming "DONE".
"""

from __future__ import annotations

import pytest

from models import Server, ServerMember, SoundboardClip
from tests.conftest import login_as, logout


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


async def _seed_two_servers_two_users(db_session) -> None:
    """Two servers (srv_a, srv_b) on the same instance.

    alice owns srv_a and is a member there. bob owns srv_b and is a
    member there. They are NOT cross-members — alice is *not* in srv_b
    and bob is *not* in srv_a. INS-073 says the soundboard is still
    visible across servers because it's instance-wide.
    """
    db_session.add(Server(id="srv_a", name="Alice Place", owner_id="@alice:test.local"))
    db_session.add(Server(id="srv_b", name="Bob Place", owner_id="@bob:test.local"))
    db_session.add(ServerMember(server_id="srv_a", user_id="@alice:test.local", role="owner"))
    db_session.add(ServerMember(server_id="srv_b", user_id="@bob:test.local", role="owner"))
    await db_session.commit()


# ---------------------------------------------------------------------
# Instance-wide visibility
# ---------------------------------------------------------------------


async def test_library_endpoint_returns_clips_from_every_server(client, db_session):
    """A clip uploaded against srv_a is visible to bob (member of srv_b only)
    via GET /api/soundboard/library.

    This is the load-bearing assertion for the user's stated goal — the
    instance-wide pool. If this test passes against a per-server filter,
    the implementation is wrong.
    """
    await _seed_two_servers_two_users(db_session)

    # Insert alice's clip directly (bypassing the upload endpoint, which
    # requires a real audio payload — we want to exercise the LIST path).
    db_session.add(SoundboardClip(
        server_id="srv_a",
        name="airhorn",
        filename="airhorn.mp3",
        uploaded_by="@alice:test.local",
    ))
    await db_session.commit()

    login_as("@bob:test.local")
    try:
        resp = await client.get("/api/soundboard/library")
    finally:
        logout()

    assert resp.status_code == 200, resp.text
    clips = resp.json()
    names = [c["name"] for c in clips]
    assert "airhorn" in names, f"bob did not see alice's clip: {names}"


async def test_legacy_per_server_endpoint_also_returns_full_library(client, db_session):
    """GET /api/soundboard/{server_id} (legacy URL) must now return the
    instance-wide library, not a server-filtered slice.

    This guarantees old clients keep working AND keeps the rollout safe:
    nothing is hidden from anybody who already had access.
    """
    await _seed_two_servers_two_users(db_session)
    db_session.add(SoundboardClip(
        server_id="srv_a",
        name="from-a",
        filename="a.mp3",
        uploaded_by="@alice:test.local",
    ))
    db_session.add(SoundboardClip(
        server_id="srv_b",
        name="from-b",
        filename="b.mp3",
        uploaded_by="@bob:test.local",
    ))
    await db_session.commit()

    login_as("@bob:test.local")
    try:
        # Bob is in srv_b — the legacy endpoint requires server membership
        # but should still return clips from srv_a as well.
        resp = await client.get("/api/soundboard/srv_b")
    finally:
        logout()

    assert resp.status_code == 200, resp.text
    names = sorted(c["name"] for c in resp.json())
    assert names == ["from-a", "from-b"], names


async def test_library_query_filters_by_name_substring(client, db_session):
    """`?q=horn` should filter to names containing "horn"."""
    await _seed_two_servers_two_users(db_session)
    for nm in ("airhorn", "rimshot", "foghorn"):
        db_session.add(SoundboardClip(
            server_id="srv_a",
            name=nm,
            filename=f"{nm}.mp3",
            uploaded_by="@alice:test.local",
        ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.get("/api/soundboard/library?q=horn")
    finally:
        logout()

    assert resp.status_code == 200, resp.text
    names = sorted(c["name"] for c in resp.json())
    assert names == ["airhorn", "foghorn"], names


# ---------------------------------------------------------------------
# Freesound license + attribution persistence
# ---------------------------------------------------------------------


async def test_freesound_attribution_fields_surface_in_library(client, db_session):
    """A row inserted with Freesound metadata must surface those fields
    in the library response — UI consumers rely on them to render the
    "via freesound.org · CC0 · by <author>" badge.
    """
    await _seed_two_servers_two_users(db_session)
    db_session.add(SoundboardClip(
        server_id="srv_a",
        name="cc0-bell",
        filename="bell.mp3",
        uploaded_by="@alice:test.local",
        source="freesound",
        source_id="12345",
        license="Creative Commons 0",
        license_url="https://creativecommons.org/publicdomain/zero/1.0/",
        attribution="some_author",
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.get("/api/soundboard/library")
    finally:
        logout()

    assert resp.status_code == 200, resp.text
    clip = next(c for c in resp.json() if c["name"] == "cc0-bell")
    assert clip["source"] == "freesound"
    assert clip["license"] == "Creative Commons 0"
    assert clip["license_url"] == "https://creativecommons.org/publicdomain/zero/1.0/"
    assert clip["attribution"] == "some_author"


async def test_user_uploaded_clip_has_null_attribution(client, db_session):
    """A regular upload (no Freesound source) must NOT pretend to have
    license/attribution data — those fields stay null so the UI doesn't
    render a misleading "CC-licensed" badge.
    """
    await _seed_two_servers_two_users(db_session)
    db_session.add(SoundboardClip(
        server_id="srv_a",
        name="user-original",
        filename="orig.mp3",
        uploaded_by="@alice:test.local",
    ))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.get("/api/soundboard/library")
    finally:
        logout()

    clip = next(c for c in resp.json() if c["name"] == "user-original")
    assert clip["source"] is None
    assert clip["license"] is None
    assert clip["license_url"] is None
    assert clip["attribution"] is None


# ---------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------


async def test_library_requires_authentication(client, db_session):
    """No login → no library. The auth gate is `get_user_id` which
    raises in tests when no override is set."""
    await _seed_two_servers_two_users(db_session)
    # No login_as — get_user_id fires the real Matrix path which we
    # haven't stubbed, so the request must NOT return a 200.
    resp = await client.get("/api/soundboard/library")
    assert resp.status_code != 200, "library returned 200 without auth"
