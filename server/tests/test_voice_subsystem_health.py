"""Tests for the Phase-0 voice-subsystem-health work:

1. ``_turn_host()`` ignores RFC1918 values in TURN_HOST and derives
   from INSTANCE_DOMAIN instead — closes the silent-broken-voice class
   where a hand-edited LAN IP got advertised to off-LAN browsers.
2. ``_turn_host()`` derives ``turn.<INSTANCE_DOMAIN>`` when no explicit
   TURN_HOST is set.
3. ``_is_rfc1918()`` correctly classifies private / loopback / link-local
   IPv4 addresses but not DNS names or public IPs.
4. ``/api/hosting/status`` returns the cached snapshot.
5. ``/api/voice/token`` returns 503 when the cached snapshot is
   explicitly unhealthy, but lets the never-probed boot window through.
"""

from __future__ import annotations

import time
import uuid

import pytest

from models import Channel, Server, ServerMember
from services import voice_health
from tests.conftest import login_as


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------
# _turn_host() / _is_rfc1918() — config derivation
# ---------------------------------------------------------------------


def test_is_rfc1918_classifies_private_addresses(monkeypatch):
    from routers.voice import _is_rfc1918

    assert _is_rfc1918("192.168.1.1") is True
    assert _is_rfc1918("10.0.0.5") is True
    assert _is_rfc1918("172.16.0.1") is True
    assert _is_rfc1918("127.0.0.1") is True
    assert _is_rfc1918("169.254.0.1") is True


def test_is_rfc1918_passes_public_and_dns(monkeypatch):
    from routers.voice import _is_rfc1918

    assert _is_rfc1918("8.8.8.8") is False
    assert _is_rfc1918("1.1.1.1") is False
    assert _is_rfc1918("turn.example.com") is False
    assert _is_rfc1918("not-an-ip") is False
    assert _is_rfc1918("") is False


def test_turn_host_rejects_rfc1918_env_and_derives_from_instance_domain(monkeypatch):
    """The TURN_HOST=192.168.1.152 misconfiguration that historically
    broke off-LAN voice is now ignored at runtime — _turn_host falls
    back to the derived value instead of advertising a LAN IP."""
    monkeypatch.setenv("TURN_HOST", "192.168.1.152")
    import config

    monkeypatch.setattr(config, "INSTANCE_DOMAIN", "chat.example.com")

    from routers.voice import _turn_host

    result = _turn_host()
    assert result == "turn.chat.example.com", (
        f"_turn_host should ignore an RFC1918 TURN_HOST and derive "
        f"turn.<INSTANCE_DOMAIN>; got {result!r}"
    )


def test_turn_host_honors_public_explicit_env(monkeypatch):
    """An operator who explicitly sets TURN_HOST to a public DNS name
    keeps that override — auto-derive only kicks in for the broken
    (RFC1918) cases and for the unset-by-default case."""
    monkeypatch.setenv("TURN_HOST", "turn.operator-choice.example.com")
    import config

    monkeypatch.setattr(config, "INSTANCE_DOMAIN", "chat.example.com")

    from routers.voice import _turn_host

    assert _turn_host() == "turn.operator-choice.example.com"


def test_turn_host_derives_when_env_unset(monkeypatch):
    monkeypatch.delenv("TURN_HOST", raising=False)
    monkeypatch.delenv("TURN_DOMAIN", raising=False)
    import config

    monkeypatch.setattr(config, "INSTANCE_DOMAIN", "chat.example.com")

    from routers.voice import _turn_host

    assert _turn_host() == "turn.chat.example.com"


def test_turn_domain_rejects_rfc1918(monkeypatch):
    monkeypatch.setenv("TURN_DOMAIN", "192.168.1.152")
    import config

    monkeypatch.setattr(config, "INSTANCE_DOMAIN", "chat.example.com")

    from routers.voice import _turn_domain

    assert _turn_domain() == "chat.example.com"


# ---------------------------------------------------------------------
# /api/hosting/status — surfaces the cached snapshot
# ---------------------------------------------------------------------


@pytest.mark.anyio
async def test_hosting_status_returns_cached_snapshot(client, monkeypatch):
    snap = voice_health.VoiceHealthSnapshot(
        healthy=True,
        turn_configured=True,
        turn_host="turn.example.com",
        turn_reachable=True,
        turn_latency_ms=42.0,
        last_checked_at=time.time(),
    )
    monkeypatch.setattr(voice_health, "current_status", lambda: snap)
    login_as("@operator:test.local")

    resp = await client.get("/api/hosting/status")

    assert resp.status_code == 200
    body = resp.json()
    assert body["voice"]["healthy"] is True
    assert body["voice"]["turn_host"] == "turn.example.com"
    assert body["voice"]["turn_latency_ms"] == 42.0


@pytest.mark.anyio
async def test_hosting_status_surfaces_unhealthy_with_remediation(client, monkeypatch):
    snap = voice_health.VoiceHealthSnapshot(
        healthy=False,
        turn_configured=True,
        turn_host="turn.example.com",
        turn_reachable=False,
        last_error="STUN timeout",
        remediation=["Forward UDP/3478 on the home router."],
        last_checked_at=time.time(),
    )
    monkeypatch.setattr(voice_health, "current_status", lambda: snap)
    login_as("@operator:test.local")

    resp = await client.get("/api/hosting/status")

    assert resp.status_code == 200
    body = resp.json()["voice"]
    assert body["healthy"] is False
    assert body["last_error"] == "STUN timeout"
    assert "Forward UDP/3478" in body["remediation"][0]


# ---------------------------------------------------------------------
# /api/voice/token gate — 503 on known-unhealthy, allow during boot window
# ---------------------------------------------------------------------


async def _seed_voice_channel(db_session, *, room_id: str, user_id: str) -> str:
    server_id = _new_id()
    db_session.add(Server(id=server_id, name=f"srv-{server_id}", owner_id=user_id))
    db_session.add(ServerMember(server_id=server_id, user_id=user_id, role="owner"))
    db_session.add(
        Channel(
            server_id=server_id,
            name="voice-room",
            channel_type="voice",
            matrix_room_id=room_id,
            position=0,
        )
    )
    await db_session.commit()
    return server_id


@pytest.mark.anyio
async def test_voice_token_returns_503_when_turn_unconfigured(
    client, db_session, monkeypatch
):
    """A hard-broken voice subsystem (no TURN_SECRET / RFC1918 host)
    must not silently mint tokens that point at unreachable ICE
    servers — the endpoint surfaces the failure with an actionable
    error code instead.

    ``turn_configured=False`` is the probe's signal for "this is a
    state no browser can recover from", and is the ONLY snapshot
    state that should produce a 503 here. Soft failures (STUN probe
    timeout from the api container's network namespace, transient
    coturn restart) must NOT block the endpoint — those still
    permit LAN + Google STUN paths to work, and the 503 itself
    produced a worse silent-broken-voice failure mode where users
    saw 'Authentication failed' for what was actually a routable
    relay.
    """
    user = "@member:test.local"
    room_id = "!voice-503:test.local"
    await _seed_voice_channel(db_session, room_id=room_id, user_id=user)

    snap = voice_health.VoiceHealthSnapshot(
        healthy=False,
        turn_configured=False,  # hard-broken — no creds can be minted
        turn_host="turn.localhost",
        turn_reachable=False,
        last_error="TURN_HOST 'turn.localhost' resolves to private address 127.0.0.1",
        remediation=["Set PUBLIC_BASE_URL so INSTANCE_DOMAIN is non-loopback."],
        last_checked_at=time.time(),
    )
    monkeypatch.setattr(
        "services.voice_health.current_status", lambda: snap
    )
    login_as(user)

    resp = await client.post("/api/voice/token", json={"room_name": room_id})

    assert resp.status_code == 503
    body = resp.json()
    assert body["error_code"] == "VOICE_SUBSYSTEM_UNAVAILABLE"
    assert "127.0.0.1" in body["message"] or "private" in body["message"]


@pytest.mark.anyio
async def test_voice_token_allows_request_when_only_stun_probe_failed(
    client, db_session, monkeypatch
):
    """Regression for the 2026-05-28 voice-token bug: an api container
    that can't STUN-reach its own (host-networked) coturn from the
    bridge network would 503 every voice join, even though the
    browser-side path to coturn was fine. The endpoint must NOT
    block on STUN-probe failure when ``turn_configured=True``;
    LAN peers + Google STUN still work, and forcing 503 there was
    surfacing as 'Authentication failed' on the client (because the
    client's error parser fell through to the literal 'Failed to
    get voice token' string and mislabeled the cause).
    """
    user = "@member:test.local"
    room_id = "!voice-stun-fail:test.local"
    await _seed_voice_channel(db_session, room_id=room_id, user_id=user)

    snap = voice_health.VoiceHealthSnapshot(
        healthy=False,  # probe says unhealthy
        turn_configured=True,  # but creds CAN be minted
        turn_host="turn.example.com",
        turn_reachable=False,
        last_error="STUN binding to turn.example.com:3478/udp timed out",
        remediation=["Verify coturn is up and UDP/3478 forwards through."],
        last_checked_at=time.time(),
    )
    monkeypatch.setattr(
        "services.voice_health.current_status", lambda: snap
    )
    login_as(user)

    resp = await client.post("/api/voice/token", json={"room_name": room_id})

    assert resp.status_code == 200, (
        "STUN probe failure from the api container's network namespace "
        "must NOT block voice-token issuance — coturn may be reachable "
        "from the browser even when the api container can't reach it, "
        "and Google STUN remains a viable fallback for LAN peers."
    )
    body = resp.json()
    assert "token" in body
    assert body["token"]


@pytest.mark.anyio
async def test_voice_token_allows_request_during_never_probed_boot_window(
    client, db_session, monkeypatch
):
    """If the background probe hasn't completed its first cycle yet,
    voice token requests succeed — otherwise a clean boot would 503
    every voice-join for the first 10 minutes."""
    user = "@member:test.local"
    room_id = "!voice-boot:test.local"
    await _seed_voice_channel(db_session, room_id=room_id, user_id=user)

    snap = voice_health.VoiceHealthSnapshot(
        healthy=False,
        turn_configured=False,
        last_checked_at=0.0,  # never probed
    )
    monkeypatch.setattr(
        "services.voice_health.current_status", lambda: snap
    )
    login_as(user)

    resp = await client.post("/api/voice/token", json={"room_name": room_id})

    assert resp.status_code == 200, (
        "Never-probed snapshot must not 503 voice-join — that would "
        "break every install for the first probe interval after boot."
    )


# ---------------------------------------------------------------------
# Snapshot probe — sanity check the synchronous implementation
# ---------------------------------------------------------------------


def test_probe_records_remediation_for_unset_turn_secret(monkeypatch):
    monkeypatch.delenv("TURN_SECRET", raising=False)

    snap = voice_health._probe_voice_blocking()

    assert snap.healthy is False
    assert snap.turn_configured is False
    assert snap.last_error == "TURN_SECRET unset"
    assert any("TURN_SECRET is unset" in r for r in snap.remediation)


def test_probe_detects_rfc1918_resolution(monkeypatch):
    """When TURN_HOST resolves to a private address, the probe records
    that as a structured failure rather than attempting the STUN check
    (which would itself succeed against a LAN coturn, masking the real
    'this won't work for off-LAN clients' problem)."""
    monkeypatch.setenv("TURN_SECRET", "x" * 32)
    monkeypatch.setenv("TURN_HOST", "lan-only.invalid")
    import socket

    monkeypatch.setattr(socket, "gethostbyname", lambda _h: "192.168.1.52")

    snap = voice_health._probe_voice_blocking()

    assert snap.healthy is False
    assert snap.turn_configured is True
    assert "private" in snap.last_error.lower() or "192.168" in snap.last_error
    assert any("WAN IP" in r or "public DNS" in r for r in snap.remediation)
