"""Tests for the Phase 7 deployment-profile hosting endpoints.

Covers:
1. ``GET /api/hosting/profile`` reports ``p2p_only`` when no env var
   is set (fresh native install) and ``web_stack_running=False`` when
   the docker proxy reports no running representative containers.
2. ``GET /api/hosting/profile`` reports ``web_first`` when
   ``CONCORD_PROFILE=web_first`` is set in the process env.
3. ``POST /api/hosting/profile/enable_web_stack`` calls
   ``docker_control.start_compose_service`` with the expected service
   names and returns the post-start status. Mocked at the
   ``docker_control`` module level so no real docker socket is
   touched.
4. ``POST /api/hosting/profile/enable_web_stack`` is admin-gated —
   a non-admin caller gets 403.
"""

from __future__ import annotations

import time

import pytest

from services import docker_control, voice_health
from tests.conftest import login_as


# ---------------------------------------------------------------------
# GET /api/hosting/profile
# ---------------------------------------------------------------------


@pytest.mark.anyio
async def test_profile_defaults_to_p2p_only_with_web_stack_off(
    client, monkeypatch
):
    """Fresh native install: no CONCORD_PROFILE env var, no running
    web-stack containers. The endpoint must report ``p2p_only`` +
    ``web_stack_running=False`` so the Settings UI renders the
    toggle in its off state without explanatory mismatch.
    """
    monkeypatch.delenv("CONCORD_PROFILE", raising=False)

    async def fake_is_running(_svc: str) -> bool:
        return False

    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    login_as("@operator:test.local")

    resp = await client.get("/api/hosting/profile")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["profile"] == "p2p_only"
    assert body["web_stack_running"] is False
    # last_changed is optional; not yet wired so it's None.
    assert body["last_changed"] is None


@pytest.mark.anyio
async def test_profile_reads_web_first_from_env(client, monkeypatch):
    """Docker stack: CONCORD_PROFILE=web_first set in compose. The
    endpoint must report that exactly so the UI in the docker-served
    web build shows "Web-first profile is active (configured via
    CONCORD_PROFILE env)" and renders the toggle read-only.
    """
    monkeypatch.setenv("CONCORD_PROFILE", "web_first")

    async def fake_is_running(_svc: str) -> bool:
        return True

    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    login_as("@operator:test.local")

    resp = await client.get("/api/hosting/profile")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["profile"] == "web_first"
    assert body["web_stack_running"] is True


@pytest.mark.anyio
async def test_profile_unknown_env_value_falls_back_to_p2p_only(
    client, monkeypatch
):
    """Invalid CONCORD_PROFILE values must not crash boot or leak
    untrusted strings into the JSON contract — fall back to
    ``p2p_only`` (the safer-for-native default).
    """
    monkeypatch.setenv("CONCORD_PROFILE", "garbage-value")

    async def fake_is_running(_svc: str) -> bool:
        return False

    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    login_as("@operator:test.local")

    resp = await client.get("/api/hosting/profile")

    assert resp.status_code == 200, resp.text
    assert resp.json()["profile"] == "p2p_only"


# ---------------------------------------------------------------------
# POST /api/hosting/profile/enable_web_stack
# ---------------------------------------------------------------------


@pytest.mark.anyio
async def test_enable_web_stack_calls_docker_control_for_each_service(
    client, monkeypatch
):
    """The endpoint must call ``start_compose_service`` for each of
    the upstream web-stack services. Mock the docker_control call so
    the test never touches a real docker socket; assert the call
    list directly.
    """
    monkeypatch.setenv("CONCORD_PROFILE", "p2p_only")

    started_calls: list[str] = []

    async def fake_start(service_name: str) -> dict:
        started_calls.append(service_name)
        return {
            "started": [f"id-{service_name}"],
            "already_running": [],
            "elapsed_seconds": 0.1,
        }

    async def fake_is_running(_svc: str) -> bool:
        return True

    async def fake_probe_now() -> voice_health.VoiceHealthSnapshot:
        return voice_health.VoiceHealthSnapshot(
            healthy=True,
            turn_configured=True,
            turn_host="turn.example.com",
            turn_reachable=True,
            last_checked_at=time.time(),
        )

    monkeypatch.setattr(docker_control, "start_compose_service", fake_start)
    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    monkeypatch.setattr(voice_health, "probe_now", fake_probe_now)

    # ADMIN_USER_IDS is seeded to '@test_admin:test.local' by conftest;
    # login as that user so require_admin lets us through.
    login_as("@test_admin:test.local")

    resp = await client.post("/api/hosting/profile/enable_web_stack")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # All three expected upstream services were started.
    assert sorted(started_calls) == sorted([
        "conduwuit",
        "livekit",
        "docker-socket-proxy",
    ])
    # Started IDs are surfaced under started_services for the UI.
    assert sorted(body["started_services"]) == sorted([
        "id-conduwuit",
        "id-livekit",
        "id-docker-socket-proxy",
    ])
    # Voice snapshot was re-probed and folded into the response.
    assert body["voice"]["healthy"] is True
    assert body["web_stack_running"] is True


@pytest.mark.anyio
async def test_enable_web_stack_is_admin_only(client, monkeypatch):
    """A non-admin caller must get 403 — flipping the profile starts
    services on the host and is not something every logged-in user
    should be able to do.
    """
    async def fake_start(_service_name: str) -> dict:
        raise AssertionError(
            "docker_control should not be called for non-admin caller"
        )

    monkeypatch.setattr(docker_control, "start_compose_service", fake_start)

    # Plain user (not in ADMIN_USER_IDS).
    login_as("@member:test.local")

    resp = await client.post("/api/hosting/profile/enable_web_stack")

    assert resp.status_code == 403, resp.text


@pytest.mark.anyio
async def test_enable_web_stack_idempotent_when_already_running(
    client, monkeypatch
):
    """When every requested service is already running, the endpoint
    must succeed (no error) and report them under
    ``already_running_services`` so the UI can show the no-op
    confirmation message instead of a spurious "started" toast.
    """
    async def fake_start(service_name: str) -> dict:
        return {
            "started": [],
            "already_running": [f"id-{service_name}"],
            "elapsed_seconds": 0.0,
        }

    async def fake_is_running(_svc: str) -> bool:
        return True

    async def fake_probe_now() -> voice_health.VoiceHealthSnapshot:
        return voice_health.VoiceHealthSnapshot(
            healthy=True,
            turn_configured=True,
            last_checked_at=time.time(),
        )

    monkeypatch.setattr(docker_control, "start_compose_service", fake_start)
    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    monkeypatch.setattr(voice_health, "probe_now", fake_probe_now)

    login_as("@test_admin:test.local")

    resp = await client.post("/api/hosting/profile/enable_web_stack")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["started_services"] == []
    assert len(body["already_running_services"]) == 3
    assert body["message"] == "Web stack already running — no action taken."


@pytest.mark.anyio
async def test_enable_web_stack_503_when_docker_proxy_unreachable(
    client, monkeypatch
):
    """When every start call fails (docker-socket-proxy unreachable,
    blocked, etc.), the endpoint must surface a 503 so the UI can
    render a retry control instead of silently claiming success.
    """
    async def fake_start(service_name: str) -> dict:
        raise docker_control.DockerControlError(
            f"docker-socket-proxy unreachable for {service_name}"
        )

    async def fake_is_running(_svc: str) -> bool:
        return False

    async def fake_probe_now() -> voice_health.VoiceHealthSnapshot:
        return voice_health.VoiceHealthSnapshot(
            healthy=False,
            turn_configured=True,
            last_checked_at=time.time(),
        )

    monkeypatch.setattr(docker_control, "start_compose_service", fake_start)
    monkeypatch.setattr(
        docker_control, "is_service_running", fake_is_running
    )
    monkeypatch.setattr(voice_health, "probe_now", fake_probe_now)

    login_as("@test_admin:test.local")

    resp = await client.post("/api/hosting/profile/enable_web_stack")

    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert detail["error_code"] == "DOCKER_PROXY_UNAVAILABLE"
    assert len(detail["failures"]) == 3
