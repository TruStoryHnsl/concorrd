"""Integration tests for the Discord bridge admin router (INS-024 Wave 2).

Covers ``server.routers.admin_bridges`` — the HTTP surface that owns
the enable / disable / rotate / status flow. docker-socket-proxy is
mocked at the ``services.docker_control`` module level because the
test harness has no docker daemon; the assertions check the ORDER of
the multi-step flow and the RBAC gate rather than real container
lifecycle events.

These tests complement ``test_bridge_config.py`` (which covers the
token and file-system primitives in isolation) and ``test_tuwunel_asapi.py``
(which pins the upstream contract the bridge relies on).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Helpers and fixtures
# ---------------------------------------------------------------------


@pytest.fixture
def bridge_tmp_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    """Isolate the bridge config dir AND the tuwunel.toml path.

    The admin router pulls both paths from
    ``services.bridge_config.bridge_config_dir`` (via the
    ``CONCORD_BRIDGE_CONFIG_DIR`` env override) and
    ``services.bridge_config.TUWUNEL_CONFIG_PATH`` (imported from
    ``tuwunel_config`` at module load). To make the router tests
    hermetic we override both — the env var handles bridge_config_dir,
    and a monkeypatch on the imported module-level path handles
    tuwunel.toml.
    """
    cfg = tmp_path / "config"
    (cfg / "mautrix-discord").mkdir(parents=True)
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(cfg))

    from services import bridge_config as bc_mod

    tuwunel_path = tmp_path / "tuwunel.toml"
    # ``ensure_appservice_entry`` reads TUWUNEL_CONFIG_PATH from the
    # module namespace at call time, so monkeypatch on the module.
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_path)
    return cfg


@pytest.fixture
def mock_docker(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    """Patch the three docker-socket-proxy helpers.

    Returns a dict with ``start``, ``stop``, ``restart`` mocks so tests
    can assert on call ordering and arguments.
    """
    from routers import admin_bridges as ab_mod

    restart_mock = AsyncMock(return_value={"restarted": ["abc123def456"], "elapsed_seconds": 0.01})
    start_mock = AsyncMock(return_value={"started": ["abc456"], "already_running": [], "elapsed_seconds": 0.01})
    stop_mock = AsyncMock(return_value={"stopped": ["abc456"], "already_stopped": [], "elapsed_seconds": 0.01})

    monkeypatch.setattr(ab_mod, "restart_compose_service", restart_mock)
    monkeypatch.setattr(ab_mod, "start_compose_service", start_mock)
    monkeypatch.setattr(ab_mod, "stop_compose_service", stop_mock)
    return {"restart": restart_mock, "start": start_mock, "stop": stop_mock}


# ---------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------


async def test_status_requires_admin(
    client: AsyncClient,
    bridge_tmp_dir: Path,
) -> None:
    """A non-admin user must get 403 from the status endpoint."""
    login_as("@regular_user:test.local")
    resp = await client.get("/api/admin/bridges/discord/status")
    assert resp.status_code == 403
    logout()


async def test_enable_requires_admin(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Non-admin cannot enable the bridge."""
    login_as("@regular_user:test.local")
    resp = await client.post("/api/admin/bridges/discord/enable", json={})
    assert resp.status_code == 403
    assert mock_docker["start"].await_count == 0
    assert mock_docker["restart"].await_count == 0
    logout()


async def test_disable_requires_admin(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Non-admin cannot disable the bridge."""
    login_as("@regular_user:test.local")
    resp = await client.post("/api/admin/bridges/discord/disable", json={})
    assert resp.status_code == 403
    assert mock_docker["stop"].await_count == 0
    logout()


async def test_rotate_requires_admin(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Non-admin cannot rotate tokens."""
    login_as("@regular_user:test.local")
    resp = await client.post("/api/admin/bridges/discord/rotate", json={})
    assert resp.status_code == 403
    logout()


# ---------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------


async def test_status_reports_disabled_when_no_registration(
    client: AsyncClient,
    bridge_tmp_dir: Path,
) -> None:
    """Fresh install reports enabled=False."""
    login_as("@test_admin:test.local")
    resp = await client.get("/api/admin/bridges/discord/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] is False
    assert body["appservice_id"] is None
    logout()


# ---------------------------------------------------------------------
# POST /enable
# ---------------------------------------------------------------------


async def test_enable_writes_registration_then_tuwunel_then_restarts(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """The enable flow must run its four steps in the documented order.

    Order: write_registration → inject_tuwunel_toml → restart conduwuit
    → start bridge. If any future refactor reorders these steps we
    want the test to fail loudly, because the ordering is what keeps
    the contract safe (tuwunel must SEE the registration before the
    bridge connects to it).
    """
    login_as("@test_admin:test.local")
    resp = await client.post("/api/admin/bridges/discord/enable", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    step_names = [s["name"] for s in body["steps"]]
    assert step_names == [
        "write_registration",
        "inject_tuwunel_toml",
        "restart_conduwuit",
        "start_bridge",
    ]
    # Docker mocks should have been called in order: restart conduwuit
    # before start bridge.
    assert mock_docker["restart"].await_args.args == ("conduwuit",)
    assert mock_docker["start"].await_args.args == ("concord-discord-bridge",)
    assert mock_docker["stop"].await_count == 0
    # Side effects on disk.
    reg_file = bridge_tmp_dir / "mautrix-discord" / "registration.yaml"
    assert reg_file.exists()
    logout()


async def test_enable_is_idempotent_for_existing_registration(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Calling enable twice re-uses the same tokens.

    Retrying an enable after a transient docker error should NOT
    rotate the tokens — that would invalidate any in-flight work the
    bridge has already done. Rotation is a separate endpoint.
    """
    login_as("@test_admin:test.local")
    r1 = await client.post("/api/admin/bridges/discord/enable", json={})
    assert r1.status_code == 200
    reg_file = bridge_tmp_dir / "mautrix-discord" / "registration.yaml"
    first_bytes = reg_file.read_bytes()

    r2 = await client.post("/api/admin/bridges/discord/enable", json={})
    assert r2.status_code == 200
    second_bytes = reg_file.read_bytes()
    assert first_bytes == second_bytes, "Enable rotated tokens on retry"
    logout()


async def test_enable_rejects_unexpected_body_fields(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Pydantic v2 strict-extra must reject bogus body keys with 422."""
    login_as("@test_admin:test.local")
    resp = await client.post(
        "/api/admin/bridges/discord/enable",
        json={"trojan_horse": "payload"},
    )
    assert resp.status_code == 422
    assert mock_docker["start"].await_count == 0
    logout()


# ---------------------------------------------------------------------
# POST /disable
# ---------------------------------------------------------------------


async def test_disable_stops_bridge_but_does_not_touch_other_services(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Disable must target only ``concord-discord-bridge``.

    This is the INS-024 §4.5 acceptance criterion: disabling the
    bridge must not knock conduwuit or concord-api offline. Asserted
    by checking that the stop mock was called exactly once with the
    bridge service name, and the restart mock was called with
    conduwuit ONLY as part of the post-removal reload (a planned
    side effect, not an accidental one).
    """
    login_as("@test_admin:test.local")
    # Enable first so there's state to tear down.
    await client.post("/api/admin/bridges/discord/enable", json={})

    mock_docker["restart"].reset_mock()
    mock_docker["stop"].reset_mock()
    mock_docker["start"].reset_mock()

    resp = await client.post("/api/admin/bridges/discord/disable", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True

    # Stop called once, with the bridge service.
    assert mock_docker["stop"].await_count == 1
    assert mock_docker["stop"].await_args.args == ("concord-discord-bridge",)

    # Restart conduwuit is the planned reload, NOT a restart of the
    # bridge or concord-api.
    assert mock_docker["restart"].await_count == 1
    assert mock_docker["restart"].await_args.args == ("conduwuit",)

    # Bridge should NOT be started as part of disable.
    assert mock_docker["start"].await_count == 0

    # On-disk cleanup: registration file must be gone.
    reg_file = bridge_tmp_dir / "mautrix-discord" / "registration.yaml"
    assert not reg_file.exists()
    logout()


async def test_disable_is_idempotent_when_nothing_configured(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Calling disable on a never-enabled bridge is a no-op, not an error."""
    login_as("@test_admin:test.local")
    resp = await client.post("/api/admin/bridges/discord/disable", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "disable"
    # The stop call is still made (it's a safe no-op when no container
    # exists), and we just assert we got through cleanly.
    logout()


# ---------------------------------------------------------------------
# POST /rotate
# ---------------------------------------------------------------------


async def test_rotate_writes_new_tokens_and_restarts_bridge(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Rotate generates fresh tokens and calls restart on the bridge."""
    login_as("@test_admin:test.local")
    # Enable once to establish a baseline registration.
    await client.post("/api/admin/bridges/discord/enable", json={})
    reg_file = bridge_tmp_dir / "mautrix-discord" / "registration.yaml"
    baseline = reg_file.read_bytes()

    mock_docker["restart"].reset_mock()
    mock_docker["start"].reset_mock()

    resp = await client.post("/api/admin/bridges/discord/rotate", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    rotated = reg_file.read_bytes()
    assert rotated != baseline, "Rotate did not change tokens"

    # Both conduwuit and the bridge should have been restarted — the
    # bridge restart is the final step that picks up the new tokens.
    restart_args = [call.args for call in mock_docker["restart"].await_args_list]
    assert ("conduwuit",) in restart_args
    assert ("concord-discord-bridge",) in restart_args
    logout()


# ---------------------------------------------------------------------
# Token leak audit
# ---------------------------------------------------------------------


async def test_tokens_never_appear_in_status_response(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Status must never echo raw tokens into the response body.

    Commercial-scope requirement: the admin UI surfaces state, not
    secrets. We grep the response body for the real on-disk tokens
    and assert neither appears. Any future refactor that accidentally
    serialises the registration dataclass directly would fail here.
    """
    login_as("@test_admin:test.local")
    await client.post("/api/admin/bridges/discord/enable", json={})

    from services.bridge_config import read_registration_file

    reg = read_registration_file()
    assert reg is not None
    resp = await client.get("/api/admin/bridges/discord/status")
    assert resp.status_code == 200
    raw = resp.text
    assert reg.as_token not in raw, "as_token leaked into status response"
    assert reg.hs_token not in raw, "hs_token leaked into status response"
    body = resp.json()
    assert body["enabled"] is True
    assert body["appservice_id"] == "concord_discord"
    logout()


async def test_tokens_never_appear_in_enable_response(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    mock_docker: dict[str, AsyncMock],
) -> None:
    """Enable response body must not contain raw tokens.

    The enable endpoint returns a steps list with ``detail`` fields
    populated from docker mock results. Those results are redacted
    via ``redact_for_logging`` before they land in the response, so
    raw tokens must never be visible. Regression pin for the whole
    redaction pipeline.
    """
    login_as("@test_admin:test.local")
    resp = await client.post("/api/admin/bridges/discord/enable", json={})
    assert resp.status_code == 200
    body = resp.text

    from services.bridge_config import read_registration_file

    reg = read_registration_file()
    assert reg is not None
    assert reg.as_token not in body
    assert reg.hs_token not in body
    logout()


# ---------------------------------------------------------------------
# Docker error handling
# ---------------------------------------------------------------------


async def test_enable_reports_docker_failure_in_steps(
    client: AsyncClient,
    bridge_tmp_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A docker failure during restart surfaces as a failed step, not 500."""
    from routers import admin_bridges as ab_mod
    from services.docker_control import DockerControlError

    async def boom(*_args: object, **_kwargs: object) -> None:
        raise DockerControlError("simulated proxy unreachable")

    monkeypatch.setattr(ab_mod, "restart_compose_service", boom)
    # Stop and start are not reached but must be present to avoid AttributeError.
    monkeypatch.setattr(ab_mod, "start_compose_service", AsyncMock())
    monkeypatch.setattr(ab_mod, "stop_compose_service", AsyncMock())

    login_as("@test_admin:test.local")
    resp = await client.post("/api/admin/bridges/discord/enable", json={})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    step_names = [s["name"] for s in body["steps"]]
    assert "restart_conduwuit" in step_names
    failing = [s for s in body["steps"] if s["status"] == "failed"]
    assert len(failing) == 1
    assert "simulated" in failing[0]["detail"]
    logout()
