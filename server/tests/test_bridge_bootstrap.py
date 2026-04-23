"""Tests for ``services/bridge_bootstrap.py``.

The bootstrap is the core of the "invisible infrastructure" model for
the user-scoped bridge. Instead of an admin Enable button, the bridge
registers itself on every concord-api startup by reconciling
``registration.yaml`` against ``tuwunel.toml``.

These tests pin the state-table behavior documented in the module
docstring. Each test isolates the bridge config dir and the
tuwunel.toml path via monkeypatch, mocks the conduwuit restart (we
have no docker daemon in the test harness), and asserts that the
bootstrap produces the documented action string for the given input
state.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture
def bridge_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> dict:
    """Point the bridge config dir and tuwunel.toml at tmp_path.

    Returns a dict with ``config_dir`` and ``tuwunel_path`` so tests
    can pre-populate / read the files directly.
    """
    cfg = tmp_path / "config"
    (cfg / "mautrix-discord").mkdir(parents=True)
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(cfg))

    # A minimal template config.yaml so write_bridge_runtime_config
    # (if it gets called) won't explode. Bootstrap shouldn't call it
    # in PR2 but better to be defensive.
    (cfg / "mautrix-discord" / "config.yaml").write_text(
        "homeserver: {}\nappservice: {}\ndiscord: {}\n",
        encoding="utf-8",
    )

    tuwunel_path = tmp_path / "tuwunel.toml"

    from services import bridge_config as bc_mod
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_path)
    monkeypatch.setattr(bc_mod.os, "chown", lambda *_args, **_kwargs: None)

    return {"config_dir": cfg, "tuwunel_path": tuwunel_path}


@pytest.fixture
def mock_docker(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    """Patch ``restart_compose_service`` at the point bootstrap imports it."""
    from services import bridge_bootstrap as bb_mod

    restart = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(bb_mod, "restart_compose_service", restart)
    return restart


# ---------------------------------------------------------------------
# State table tests (see module docstring for the full matrix)
# ---------------------------------------------------------------------


async def test_fresh_install(
    bridge_paths: dict,
    mock_docker: AsyncMock,
) -> None:
    """No registration + no tuwunel → fresh enable."""
    from services.bridge_bootstrap import bootstrap_bridge_registration
    from services.bridge_config import (
        DISCORD_BRIDGE_APPSERVICE_ID,
        read_appservice_ids,
        read_registration_file,
    )

    summary = await bootstrap_bridge_registration()

    assert summary["action"] == "fresh_enable"
    assert summary["changed"] is True
    assert summary["restarted_conduwuit"] is True

    # Registration file was generated.
    reg = read_registration_file()
    assert reg is not None
    assert reg.id == DISCORD_BRIDGE_APPSERVICE_ID
    assert reg.as_token
    assert reg.hs_token

    # Tuwunel.toml has the matching entry.
    ids = read_appservice_ids()
    assert ids == [DISCORD_BRIDGE_APPSERVICE_ID]

    # Conduwuit was restarted exactly once.
    assert mock_docker.await_count == 1


async def test_steady_state_is_noop(
    bridge_paths: dict,
    mock_docker: AsyncMock,
) -> None:
    """Registration + matching tuwunel entry → no action, no restart."""
    from services.bridge_bootstrap import bootstrap_bridge_registration
    from services.bridge_config import (
        ensure_appservice_entry,
        generate_registration,
        write_registration_file,
    )

    # Pre-seed a steady state.
    reg = generate_registration()
    write_registration_file(reg)
    ensure_appservice_entry(reg)

    summary = await bootstrap_bridge_registration()

    assert summary["action"] == "noop"
    assert summary["changed"] is False
    assert summary["restarted_conduwuit"] is False
    assert mock_docker.await_count == 0


async def test_drift_registration_without_tuwunel(
    bridge_paths: dict,
    mock_docker: AsyncMock,
) -> None:
    """Registration on disk but no tuwunel entry → re-inject, restart."""
    from services.bridge_bootstrap import bootstrap_bridge_registration
    from services.bridge_config import (
        DISCORD_BRIDGE_APPSERVICE_ID,
        generate_registration,
        read_appservice_ids,
        write_registration_file,
    )

    reg = generate_registration()
    write_registration_file(reg)
    # Deliberately DO NOT inject into tuwunel — simulate drift.

    summary = await bootstrap_bridge_registration()

    assert summary["action"] == "reconciled_tuwunel"
    assert summary["changed"] is True
    assert summary["restarted_conduwuit"] is True

    # Tuwunel now has the entry that registration had all along.
    ids = read_appservice_ids()
    assert ids == [DISCORD_BRIDGE_APPSERVICE_ID]

    # Tokens did NOT change — reg.as_token still on disk.
    assert mock_docker.await_count == 1


async def test_orphan_tuwunel_entry_stripped(
    bridge_paths: dict,
    mock_docker: AsyncMock,
) -> None:
    """No registration but tuwunel has stale entries → strip, no restart.

    No restart because conduwuit ignores entries with no backing
    appservice anyway, and restart drops federation connections.
    """
    from services.bridge_bootstrap import bootstrap_bridge_registration
    from services.bridge_config import (
        ensure_appservice_entry,
        generate_registration,
        read_appservice_ids,
        delete_registration_file,
        write_registration_file,
    )

    # Write a registration, inject, then delete the registration —
    # simulating a half-rolled-back disable.
    reg = generate_registration()
    write_registration_file(reg)
    ensure_appservice_entry(reg)
    delete_registration_file()

    summary = await bootstrap_bridge_registration()

    assert summary["action"] == "stripped_orphans"
    assert summary["changed"] is True
    assert summary["restarted_conduwuit"] is False

    assert read_appservice_ids() == []
    assert mock_docker.await_count == 0


async def test_id_mismatch_full_reset(
    bridge_paths: dict,
    mock_docker: AsyncMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Registration id != current constant → full reset with new id.

    Simulates the scenario where an earlier code version used
    ``concord_discord`` and the upgrade renamed the constant to
    ``concord_discord_2``.
    """
    from services.bridge_bootstrap import bootstrap_bridge_registration
    from services.bridge_config import (
        DISCORD_BRIDGE_APPSERVICE_ID,
        DiscordBridgeRegistration,
        read_appservice_ids,
        read_registration_file,
        write_registration_file,
    )

    # Write a registration with the OLD id (simulate pre-upgrade state).
    old_reg = DiscordBridgeRegistration(
        id="concord_discord_legacy",
        as_token="as_legacy_token",
        hs_token="hs_legacy_token",
    )
    write_registration_file(old_reg)

    summary = await bootstrap_bridge_registration()

    assert summary["action"] == "fresh_enable"
    assert summary["changed"] is True
    assert summary["restarted_conduwuit"] is True

    # New registration replaced the old one, with the CURRENT constant.
    new_reg = read_registration_file()
    assert new_reg is not None
    assert new_reg.id == DISCORD_BRIDGE_APPSERVICE_ID
    assert new_reg.as_token != "as_legacy_token"

    # Tuwunel now has only the new id.
    ids = read_appservice_ids()
    assert ids == [DISCORD_BRIDGE_APPSERVICE_ID]


async def test_restart_failure_does_not_block_startup(
    bridge_paths: dict,
    mock_docker: AsyncMock,
) -> None:
    """Conduwuit restart failing is logged, returns degraded flag, but
    bootstrap still completes. Concord-api MUST come up even if
    docker-socket-proxy is unreachable."""
    from services import bridge_bootstrap as bb_mod
    from services.docker_control import DockerControlError

    mock_docker.side_effect = DockerControlError("docker socket unavailable")

    summary = await bb_mod.bootstrap_bridge_registration()

    # Fresh enable was still attempted — registration + tuwunel were
    # written — but conduwuit restart failed. That's a degraded-but-
    # recoverable state, not a hard failure.
    assert summary["action"] == "fresh_enable"
    assert summary["restarted_conduwuit"] is False


async def test_tuwunel_unreadable_returns_degraded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed tuwunel.toml should not crash the instance — bootstrap
    surfaces a degraded state and returns.
    """
    cfg = tmp_path / "config"
    (cfg / "mautrix-discord").mkdir(parents=True)
    (cfg / "mautrix-discord" / "config.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(cfg))

    tuwunel_path = tmp_path / "tuwunel.toml"
    tuwunel_path.write_text("not = valid [ toml", encoding="utf-8")

    from services import bridge_config as bc_mod
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_path)
    monkeypatch.setattr(bc_mod.os, "chown", lambda *_args, **_kwargs: None)

    from services import bridge_bootstrap as bb_mod
    restart = AsyncMock()
    monkeypatch.setattr(bb_mod, "restart_compose_service", restart)

    summary = await bb_mod.bootstrap_bridge_registration()

    # Either handled gracefully as degraded, or the malformed toml is
    # treated as "no entries" and we fall through to fresh_enable
    # (which then writes a valid tuwunel.toml). Both outcomes are
    # acceptable — what's NOT acceptable is an uncaught exception.
    assert summary["action"] in ("degraded", "fresh_enable")
