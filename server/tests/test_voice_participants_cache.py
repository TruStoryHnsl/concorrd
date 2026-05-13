"""Regression tests for the LiveKit participant-list cache + single-flight.

Why this exists
---------------
On 2026-05-09 the sslh TLS demuxer in front of concorrd.com wedged after
25 days of uptime: 124 ESTAB sockets sat with unread TLS ClientHellos
while the main loop had stopped consuming them. Empirical contributor
to the chronic background load: ``/api/voice/participants`` was emitting
one LiveKit ``ListParticipants`` RPC per room per client poll, with no
caching and no single-flight. M users × N rooms × every 10 s produced
bursts visible in livekit-1 logs (hundreds of calls per second).

These tests pin the cache + single-flight behavior that prevents that:

  1. Repeat lookup within the TTL hits the in-memory cache (one LiveKit
     call, not two).
  2. Two concurrent lookups for the same room share one upstream call
     (single-flight via the in-flight task map).
  3. After the TTL elapses the cache misses and re-fetches.
  4. Failed upstream lookups are not cached, so the next caller retries.

We test the cache helper directly rather than the FastAPI endpoint —
the endpoint's pre-cache work (DB membership filtering) is covered by
broader integration paths, and the cache contract is what prevents the
wedge from recurring.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from routers import voice as voice_module


@pytest.fixture(autouse=True)
def _clear_caches():
    """Caches are module-level; reset between tests."""
    voice_module._participants_cache.clear()
    voice_module._participants_inflight.clear()
    yield
    voice_module._participants_cache.clear()
    voice_module._participants_inflight.clear()


def _build_lk_client_mock(participants: list[tuple[str, str]]) -> MagicMock:
    """Build a mock LiveKitAPI whose .room.list_participants returns
    the given (identity, name) pairs once, then is asserted-on by tests."""
    response = SimpleNamespace(
        participants=[
            SimpleNamespace(identity=i, name=n) for i, n in participants
        ]
    )
    client = MagicMock()
    client.room.list_participants = AsyncMock(return_value=response)
    client.aclose = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_cache_hit_within_ttl_avoids_second_livekit_call():
    """Two sequential calls within the TTL should issue exactly one
    LiveKit RPC. This is the primary mechanism that flattens the
    polling load and prevents the chronic background pressure that
    contributed to the sslh wedge."""
    mock_client = _build_lk_client_mock([("u1", "User One")])

    with patch.object(
        voice_module.livekit_api, "LiveKitAPI", return_value=mock_client
    ):
        first = await voice_module._fetch_room_participants_cached("!r:s.tld")
        second = await voice_module._fetch_room_participants_cached("!r:s.tld")

    assert first == [{"identity": "u1", "name": "User One"}]
    assert second == first
    assert mock_client.room.list_participants.await_count == 1


@pytest.mark.asyncio
async def test_concurrent_callers_share_single_upstream_call():
    """Two simultaneous lookups for the same room must share one
    upstream LiveKit RPC via the in-flight task map (single-flight).
    Without this, a thundering herd of polling clients can multiply
    LiveKit RPC volume on cache miss."""
    mock_client = _build_lk_client_mock([("u1", "User One")])

    # Make the upstream call block until we release it, so both
    # callers are guaranteed to be in flight at the same time.
    release = asyncio.Event()

    async def slow_list_participants(_req):
        await release.wait()
        return SimpleNamespace(
            participants=[SimpleNamespace(identity="u1", name="User One")]
        )

    mock_client.room.list_participants = AsyncMock(side_effect=slow_list_participants)

    with patch.object(
        voice_module.livekit_api, "LiveKitAPI", return_value=mock_client
    ):
        a = asyncio.create_task(
            voice_module._fetch_room_participants_cached("!r:s.tld")
        )
        b = asyncio.create_task(
            voice_module._fetch_room_participants_cached("!r:s.tld")
        )
        # Yield so both tasks register in _participants_inflight before
        # the upstream call resolves.
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(a, b)

    assert results[0] == results[1] == [{"identity": "u1", "name": "User One"}]
    assert mock_client.room.list_participants.await_count == 1


@pytest.mark.asyncio
async def test_cache_expires_after_ttl(monkeypatch):
    """Once the TTL elapses, the next call must re-fetch — the cache
    must NOT serve stale data forever."""
    mock_client = _build_lk_client_mock([("u1", "User One")])

    # Pin a controllable clock for the cache. ``time.monotonic`` is what
    # the cache uses internally.
    fake_now = [1000.0]

    def fake_monotonic():
        return fake_now[0]

    monkeypatch.setattr(voice_module.time, "monotonic", fake_monotonic)

    with patch.object(
        voice_module.livekit_api, "LiveKitAPI", return_value=mock_client
    ):
        await voice_module._fetch_room_participants_cached("!r:s.tld")
        # Advance past the TTL.
        fake_now[0] += voice_module._PARTICIPANTS_TTL_S + 0.1
        await voice_module._fetch_room_participants_cached("!r:s.tld")

    assert mock_client.room.list_participants.await_count == 2


@pytest.mark.asyncio
async def test_upstream_failure_is_not_cached():
    """A LiveKit call that raises must produce an empty list AND must
    not populate the cache. The next caller should retry instead of
    serving a phantom empty result for the full TTL window."""
    client_fail = MagicMock()
    client_fail.room.list_participants = AsyncMock(side_effect=RuntimeError("boom"))
    client_fail.aclose = AsyncMock()

    client_ok = _build_lk_client_mock([("u1", "User One")])

    # First call returns the failing client, second the OK one.
    constructed = [client_fail, client_ok]

    def factory(*_a, **_kw):
        return constructed.pop(0)

    with patch.object(voice_module.livekit_api, "LiveKitAPI", side_effect=factory):
        first = await voice_module._fetch_room_participants_cached("!r:s.tld")
        second = await voice_module._fetch_room_participants_cached("!r:s.tld")

    assert first == []
    assert second == [{"identity": "u1", "name": "User One"}]
    # Confirm the failed result wasn't cached: the OK client was actually called.
    assert client_ok.room.list_participants.await_count == 1
