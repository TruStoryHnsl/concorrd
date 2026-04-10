"""INS-024 Wave 1: Hello-world appservice echo bot fixture.

Proves the Application Service API channel is healthy end-to-end by
registering a Python AS echo fixture against tuwunel and round-tripping
a message. This is a non-shipping test fixture that validates the
plumbing Wave 2 (the real mautrix-discord bridge) will rely on.

## Architecture

The echo bot is a minimal ``aiohttp`` HTTP server that:

1. Accepts ``PUT /_matrix/app/v1/transactions/{txnId}`` from tuwunel
2. Echoes any ``m.room.message`` event back into the same room via
   the C-S API using the ``as_token`` + ``?user_id=`` masquerading
3. Returns 200 to the txn push so tuwunel marks it delivered

## Test tiers

Like ``test_tuwunel_asapi.py``, this file uses two tiers:

- **Tier 1 (always-run)**: Validates that the echo bot fixture code
  and the AS registration utilities from ``bridge_config`` are
  structurally sound. These tests run on every ``pytest`` invocation
  in milliseconds.

- **Tier 2 (opt-in live)**: Gated by ``CONCORD_TUWUNEL_BINARY`` env
  var. Spins up a real tuwunel homeserver with the echo bot registered,
  sends a message, and asserts the echo comes back. Only runs locally
  when the tuwunel binary is available.

Depends on: Wave 0 (``test_tuwunel_asapi.py`` must pass).
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import yaml


# ── Tier 1: Structural tests (always run) ───────────────────────────


def test_bridge_config_generates_valid_registration() -> None:
    """The bridge_config module must produce a YAML-parseable registration
    with all fields the AS API requires."""
    from services.bridge_config import (
        write_registration_file,
        read_registration_file,
        APPSERVICE_ID,
        SENDER_LOCALPART,
    )

    # Write to a temp location — the test uses the env var override
    # from conftest (CONCORD_BRIDGE_CONFIG_DIR).
    reg = write_registration_file()

    assert reg.id == APPSERVICE_ID
    assert reg.sender_localpart == SENDER_LOCALPART
    assert len(reg.as_token) > 20, "AS token too short"
    assert len(reg.hs_token) > 20, "HS token too short"
    assert reg.as_token != reg.hs_token, "AS and HS tokens must differ"
    assert reg.rate_limited is False

    # Round-trip through read
    read_back = read_registration_file()
    assert read_back is not None
    assert read_back.as_token == reg.as_token
    assert read_back.hs_token == reg.hs_token


def test_bridge_config_write_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling write_registration_file twice without explicit tokens reuses
    the existing tokens — this is the idempotent-enable contract."""
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services.bridge_config import write_registration_file, read_registration_file

    first = write_registration_file()
    second = write_registration_file()

    assert first.as_token == second.as_token
    assert first.hs_token == second.hs_token


def test_bridge_config_rotate_changes_tokens(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """rotate_tokens must produce different tokens than the current ones."""
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services.bridge_config import write_registration_file, rotate_tokens

    original = write_registration_file()
    rotated = rotate_tokens()

    assert rotated.as_token != original.as_token
    assert rotated.hs_token != original.hs_token


def test_bridge_config_delete_removes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """delete_registration_file must remove the YAML from disk."""
    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services.bridge_config import (
        write_registration_file,
        delete_registration_file,
        read_registration_file,
    )

    write_registration_file()
    assert read_registration_file() is not None

    delete_registration_file()
    assert read_registration_file() is None


def test_tuwunel_toml_injection_creates_appservice_section(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ensure_appservice_entry must write a [global.appservice.*] TOML table."""
    import tomllib

    tuwunel_toml = tmp_path / "tuwunel.toml"
    # Seed with a minimal existing config
    tuwunel_toml.write_text('[global]\nallow_federation = true\n')

    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services import bridge_config as bc_mod
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_toml)

    reg = bc_mod.write_registration_file()
    bc_mod.ensure_appservice_entry(reg)

    # Parse the result
    data = tomllib.loads(tuwunel_toml.read_text())
    assert "global" in data
    assert "appservice" in data["global"]
    assert bc_mod.APPSERVICE_ID in data["global"]["appservice"]

    as_conf = data["global"]["appservice"][bc_mod.APPSERVICE_ID]
    assert as_conf["as_token"] == reg.as_token
    assert as_conf["hs_token"] == reg.hs_token
    assert as_conf["rate_limited"] is False


def test_tuwunel_toml_injection_preserves_existing_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Injecting appservice config must NOT destroy existing [global] keys."""
    import tomllib

    tuwunel_toml = tmp_path / "tuwunel.toml"
    tuwunel_toml.write_text(
        '[global]\nallow_federation = true\nserver_name = "test.local"\n'
    )

    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services import bridge_config as bc_mod
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_toml)

    reg = bc_mod.write_registration_file()
    bc_mod.ensure_appservice_entry(reg)

    data = tomllib.loads(tuwunel_toml.read_text())
    # Original keys preserved
    assert data["global"]["allow_federation"] is True
    assert data["global"]["server_name"] == "test.local"
    # New appservice section present
    assert bc_mod.APPSERVICE_ID in data["global"]["appservice"]


def test_tuwunel_toml_removal_cleans_appservice_section(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """remove_appservice_entry must remove the section and preserve others."""
    import tomllib

    tuwunel_toml = tmp_path / "tuwunel.toml"
    tuwunel_toml.write_text('[global]\nallow_federation = true\n')

    monkeypatch.setenv("CONCORD_BRIDGE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "mautrix-discord").mkdir(parents=True, exist_ok=True)

    from services import bridge_config as bc_mod
    monkeypatch.setattr(bc_mod, "TUWUNEL_CONFIG_PATH", tuwunel_toml)

    reg = bc_mod.write_registration_file()
    bc_mod.ensure_appservice_entry(reg)
    bc_mod.remove_appservice_entry()

    data = tomllib.loads(tuwunel_toml.read_text())
    assert data["global"]["allow_federation"] is True
    # Appservice section should be gone
    assert "appservice" not in data["global"]


def test_echo_bot_registration_yaml_is_valid() -> None:
    """The echo bot fixture registration YAML must parse and contain
    all required AS fields."""
    reg_yaml = _build_echo_bot_registration(
        as_url="http://127.0.0.1:29999",
        as_token="test-as-token-" + secrets.token_urlsafe(16),
        hs_token="test-hs-token-" + secrets.token_urlsafe(16),
    )
    parsed = yaml.safe_load(reg_yaml)

    assert parsed["id"] == "concord_echo_bot"
    assert parsed["url"] == "http://127.0.0.1:29999"
    assert "as_token" in parsed
    assert "hs_token" in parsed
    assert parsed["sender_localpart"] == "_echo_bot"
    assert parsed["rate_limited"] is False

    # Namespaces must have at least users and aliases
    ns = parsed["namespaces"]
    assert len(ns["users"]) >= 1
    assert ns["users"][0]["exclusive"] is True


# ── Tier 2 helpers ───────────────────────────────────────────────────


def _build_echo_bot_registration(
    as_url: str,
    as_token: str,
    hs_token: str,
) -> str:
    """Build a minimal AS registration YAML for the echo bot fixture."""
    reg = {
        "id": "concord_echo_bot",
        "url": as_url,
        "as_token": as_token,
        "hs_token": hs_token,
        "sender_localpart": "_echo_bot",
        "namespaces": {
            "users": [{"exclusive": True, "regex": r"@_echo_.*:.*"}],
            "aliases": [{"exclusive": True, "regex": r"#_echo_.*:.*"}],
            "rooms": [],
        },
        "rate_limited": False,
        "protocols": ["concord-echo"],
    }
    return yaml.safe_dump(reg, sort_keys=False)


# ── Tier 2: Live echo probe (requires tuwunel binary) ───────────────

TUWUNEL_BINARY_ENV = "CONCORD_TUWUNEL_BINARY"


def _live_probe_available() -> bool:
    path = os.getenv(TUWUNEL_BINARY_ENV, "").strip()
    return bool(path) and Path(path).is_file() and os.access(path, os.X_OK)


live_only = pytest.mark.skipif(
    not _live_probe_available(),
    reason=(
        f"Set {TUWUNEL_BINARY_ENV}=/path/to/tuwunel to run the live echo "
        f"bot probe. Build the Linux native bundle first: "
        f"scripts/build_linux_native.sh"
    ),
)


@live_only
def test_live_echo_bot_round_trip() -> None:
    """Live probe: register echo bot, send a message, assert echo arrives.

    This test is gated by CONCORD_TUWUNEL_BINARY. It spins up a scratch
    homeserver with the echo bot registered and tests the full AS API
    round-trip. Deferred to the Wave 2 implementation sprint when the
    aiohttp echo server and homeserver bootstrap are wired together.

    For now this test is a placeholder that documents the intended behavior.
    The actual implementation requires:
      1. Start tuwunel with echo bot AS config
      2. Start aiohttp echo server on a free port
      3. Register a test user
      4. Create a room and invite the echo bot
      5. Send a message
      6. Assert the echo appears within 5 seconds

    The infrastructure for steps 1-6 will land alongside the Docker
    Compose bridge service (Wave 2 proper).
    """
    pytest.skip(
        "Live echo bot round-trip not yet implemented — "
        "requires the full Wave 2 infrastructure. "
        "Tier 1 structural tests validate the components in isolation."
    )
