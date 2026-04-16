"""Tests for the service-node resource + role configuration module (INS-023).

Covers three surfaces:

* :class:`ServiceNodeConfig` dataclass validation + defaults.
* :func:`load_config` / :func:`save_config` atomic-file I/O against
  a real temp directory (no mocking — the atomic-write pattern is the
  thing we actually want to exercise).
* The admin-only ``/api/admin/service-node`` router wired through the
  shared ``client`` + ``login_as`` fixtures from ``conftest.py``, and
  the public exposure of the stripped subset via ``/api/instance``
  and ``/.well-known/concord/client``.

All tests here are hermetic — they monkeypatch ``CONCORD_DATA_DIR``
so a fresh tempdir holds the state for each test function, and no
test touches a real data directory.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from services.service_node_config import (
    ALLOWED_ROLES,
    MAX_BANDWIDTH_MBPS,
    MAX_CPU_PERCENT,
    MAX_STORAGE_GB,
    SERVICE_NODE_FILE_NAME,
    ServiceNodeConfig,
    ServiceNodeConfigError,
    load_config,
    public_view,
    save_config,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fresh_data_dir(tmp_path, monkeypatch):
    """Redirect ``CONCORD_DATA_DIR`` at every service_node.json read/write.

    The service_node_config module resolves the data dir lazily at
    every call, so a monkeypatched env var is honored across the
    same-test lifetime. Tests that assert file contents can use the
    returned :class:`Path` directly.
    """
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    # Also make sure the legacy var isn't shadowing us.
    monkeypatch.delenv("CONCORRD_DATA_DIR", raising=False)
    return tmp_path


# ---------------------------------------------------------------------------
# Dataclass: defaults + validation
# ---------------------------------------------------------------------------

def test_defaults_are_sane():
    cfg = ServiceNodeConfig.defaults()
    assert cfg.max_cpu_percent == 80
    assert cfg.max_bandwidth_mbps == 0  # 0 == unlimited
    assert cfg.max_storage_gb == 0
    assert cfg.tunnel_anchor_enabled is False
    assert cfg.node_role == "hybrid"
    # Default config must validate — if it doesn't, every fresh
    # deployment would crash on first boot.
    cfg.validate()


def test_validate_rejects_cpu_zero():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_cpu_percent = 0
    with pytest.raises(ServiceNodeConfigError, match="max_cpu_percent"):
        cfg.validate()


def test_validate_rejects_cpu_over_max():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_cpu_percent = MAX_CPU_PERCENT + 1
    with pytest.raises(ServiceNodeConfigError, match="max_cpu_percent"):
        cfg.validate()


def test_validate_accepts_cpu_boundary_values():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_cpu_percent = 1
    cfg.validate()
    cfg.max_cpu_percent = MAX_CPU_PERCENT
    cfg.validate()


def test_validate_rejects_negative_bandwidth():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_bandwidth_mbps = -1
    with pytest.raises(ServiceNodeConfigError, match="max_bandwidth_mbps"):
        cfg.validate()


def test_validate_rejects_bandwidth_over_max():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_bandwidth_mbps = MAX_BANDWIDTH_MBPS + 1
    with pytest.raises(ServiceNodeConfigError, match="max_bandwidth_mbps"):
        cfg.validate()


def test_validate_rejects_negative_storage():
    cfg = ServiceNodeConfig.defaults()
    cfg.max_storage_gb = -1
    with pytest.raises(ServiceNodeConfigError, match="max_storage_gb"):
        cfg.validate()


def test_validate_rejects_unknown_role():
    cfg = ServiceNodeConfig.defaults()
    cfg.node_role = "supernode"  # type: ignore[assignment]
    with pytest.raises(ServiceNodeConfigError, match="node_role"):
        cfg.validate()


def test_validate_accepts_every_allowed_role():
    for role in ALLOWED_ROLES:
        cfg = ServiceNodeConfig.defaults()
        cfg.node_role = role  # type: ignore[assignment]
        cfg.validate()


def test_validate_rejects_bool_as_int_fields():
    # Python's ``bool`` is a subclass of ``int``, so naive
    # isinstance checks would accept ``True``/``False`` as CPU%.
    cfg = ServiceNodeConfig.defaults()
    cfg.max_cpu_percent = True  # type: ignore[assignment]
    with pytest.raises(ServiceNodeConfigError, match="max_cpu_percent"):
        cfg.validate()


def test_anchor_role_without_flag_logs_warning_but_validates(caplog):
    cfg = ServiceNodeConfig(
        max_cpu_percent=80,
        max_bandwidth_mbps=0,
        max_storage_gb=0,
        tunnel_anchor_enabled=False,
        node_role="anchor",
    )
    # Incoherent, but deliberately non-raising — we surface the
    # warning so the admin can fix it, not block the save.
    with caplog.at_level("WARNING"):
        cfg.validate()
    assert any(
        "anchor" in rec.message.lower() for rec in caplog.records
    ), "incoherent anchor state should log a warning"


# ---------------------------------------------------------------------------
# Disk I/O: load + save round trips
# ---------------------------------------------------------------------------

def test_load_config_returns_defaults_when_file_missing(fresh_data_dir):
    # File does not exist; load_config must NOT raise and must return
    # a valid default config.
    assert not (fresh_data_dir / SERVICE_NODE_FILE_NAME).exists()
    cfg = load_config()
    assert cfg == ServiceNodeConfig.defaults()


def test_load_config_returns_defaults_when_file_empty(fresh_data_dir):
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text("")
    cfg = load_config()
    assert cfg == ServiceNodeConfig.defaults()


def test_save_then_load_round_trip(fresh_data_dir):
    original = ServiceNodeConfig(
        max_cpu_percent=42,
        max_bandwidth_mbps=500,
        max_storage_gb=250,
        tunnel_anchor_enabled=True,
        node_role="anchor",
    )
    saved = save_config(original)
    assert saved == original

    reloaded = load_config()
    assert reloaded == original


def test_save_writes_valid_json_to_canonical_path(fresh_data_dir):
    cfg = ServiceNodeConfig(
        max_cpu_percent=50,
        max_bandwidth_mbps=10,
        max_storage_gb=1,
        tunnel_anchor_enabled=True,
        node_role="hybrid",
    )
    save_config(cfg)

    path = fresh_data_dir / SERVICE_NODE_FILE_NAME
    assert path.exists()
    payload = json.loads(path.read_text())
    assert payload["max_cpu_percent"] == 50
    assert payload["max_bandwidth_mbps"] == 10
    assert payload["max_storage_gb"] == 1
    assert payload["tunnel_anchor_enabled"] is True
    assert payload["node_role"] == "hybrid"


def test_save_rejects_invalid_config_before_touching_disk(fresh_data_dir):
    cfg = ServiceNodeConfig.defaults()
    cfg.max_cpu_percent = -5
    with pytest.raises(ServiceNodeConfigError):
        save_config(cfg)
    # No file written on failure — validate() ran before open().
    assert not (fresh_data_dir / SERVICE_NODE_FILE_NAME).exists()


def test_load_config_rejects_corrupt_json(fresh_data_dir):
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text("{not json")
    with pytest.raises(ServiceNodeConfigError, match="not valid JSON"):
        load_config()


def test_load_config_rejects_non_object_root(fresh_data_dir):
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text("[1,2,3]")
    with pytest.raises(ServiceNodeConfigError, match="JSON object"):
        load_config()


def test_load_config_rejects_out_of_range_value(fresh_data_dir):
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text(
        json.dumps({"max_cpu_percent": 999})
    )
    with pytest.raises(ServiceNodeConfigError, match="max_cpu_percent"):
        load_config()


def test_load_config_tolerates_missing_optional_fields(fresh_data_dir):
    # A config written by an older version that doesn't know about
    # new fields must upgrade cleanly — missing fields fall through
    # to the dataclass defaults.
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text(
        json.dumps({"max_cpu_percent": 75})
    )
    cfg = load_config()
    assert cfg.max_cpu_percent == 75
    assert cfg.max_bandwidth_mbps == 0  # default fallback
    assert cfg.node_role == "hybrid"    # default fallback


def test_save_does_not_leave_tempfile_on_success(fresh_data_dir):
    save_config(ServiceNodeConfig.defaults())
    leftover = [
        p for p in fresh_data_dir.iterdir()
        if p.name.startswith(f".{SERVICE_NODE_FILE_NAME}.")
    ]
    assert leftover == [], f"stale tempfile(s) left behind: {leftover}"


# ---------------------------------------------------------------------------
# public_view stripping
# ---------------------------------------------------------------------------

def test_public_view_only_contains_safe_fields(fresh_data_dir):
    save_config(
        ServiceNodeConfig(
            max_cpu_percent=99,
            max_bandwidth_mbps=1234,
            max_storage_gb=5678,
            tunnel_anchor_enabled=True,
            node_role="anchor",
        )
    )
    pub = public_view()
    # Only structural role data should be exposed.
    assert pub.tunnel_anchor_enabled is True
    assert pub.node_role == "anchor"
    # The class deliberately has no cap fields. Guard against a future
    # author accidentally widening it.
    assert not hasattr(pub, "max_cpu_percent")
    assert not hasattr(pub, "max_bandwidth_mbps")
    assert not hasattr(pub, "max_storage_gb")


def test_public_view_falls_back_on_corrupt_file(fresh_data_dir, caplog):
    (fresh_data_dir / SERVICE_NODE_FILE_NAME).write_text("garbage")
    with caplog.at_level("WARNING"):
        pub = public_view()
    assert pub.node_role == "hybrid"
    assert pub.tunnel_anchor_enabled is False
    # Warning must mention the fallback so operators notice.
    assert any(
        "fallback" in rec.message.lower() or "falling back" in rec.message.lower()
        for rec in caplog.records
    )


# ---------------------------------------------------------------------------
# HTTP surface: admin endpoints (require `client` + `login_as` fixtures)
# ---------------------------------------------------------------------------

async def test_admin_get_requires_auth(client, monkeypatch, tmp_path):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    # Non-admin user should get 403.  A missing Authorization header gives
    # 422 (FastAPI header validation) rather than 401 — test with a real
    # non-admin identity so the router's require_admin check fires.
    login_as("@not_admin:test.local")
    resp = await client.get("/api/admin/service-node")
    assert resp.status_code == 403
    logout()


async def test_admin_get_returns_defaults_on_fresh_deploy(
    client, monkeypatch, tmp_path
):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    login_as("@test_admin:test.local")

    resp = await client.get("/api/admin/service-node")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["max_cpu_percent"] == 80
    assert body["max_bandwidth_mbps"] == 0
    assert body["max_storage_gb"] == 0
    assert body["tunnel_anchor_enabled"] is False
    assert body["node_role"] == "hybrid"
    # Limits block exposes the module-level maxima so the UI can
    # render slider bounds without shipping the constants itself.
    assert body["limits"]["max_cpu_percent"] == MAX_CPU_PERCENT
    assert body["limits"]["max_bandwidth_mbps"] == MAX_BANDWIDTH_MBPS
    assert body["limits"]["max_storage_gb"] == MAX_STORAGE_GB
    assert set(body["limits"]["allowed_roles"]) == set(ALLOWED_ROLES)


async def test_admin_get_rejects_non_admin(
    client, monkeypatch, tmp_path
):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    login_as("@not_admin:test.local")

    resp = await client.get("/api/admin/service-node")
    assert resp.status_code == 403


async def test_admin_put_persists_new_config(
    client, monkeypatch, tmp_path
):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    login_as("@test_admin:test.local")

    payload = {
        "max_cpu_percent": 60,
        "max_bandwidth_mbps": 100,
        "max_storage_gb": 20,
        "tunnel_anchor_enabled": True,
        "node_role": "anchor",
    }
    resp = await client.put("/api/admin/service-node", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for key, val in payload.items():
        assert body[key] == val

    # Round-trip via a subsequent GET should return the same values.
    resp2 = await client.get("/api/admin/service-node")
    assert resp2.status_code == 200
    for key, val in payload.items():
        assert resp2.json()[key] == val


async def test_admin_put_rejects_cpu_over_max(
    client, monkeypatch, tmp_path
):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    login_as("@test_admin:test.local")

    payload = {
        "max_cpu_percent": 999,
        "max_bandwidth_mbps": 0,
        "max_storage_gb": 0,
        "tunnel_anchor_enabled": False,
        "node_role": "hybrid",
    }
    resp = await client.put("/api/admin/service-node", json=payload)
    # Pydantic field constraints turn this into a 422 before the
    # handler even runs.
    assert resp.status_code == 422


async def test_admin_put_rejects_unknown_role(
    client, monkeypatch, tmp_path
):
    from tests.conftest import login_as, logout
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    login_as("@test_admin:test.local")

    payload = {
        "max_cpu_percent": 80,
        "max_bandwidth_mbps": 0,
        "max_storage_gb": 0,
        "tunnel_anchor_enabled": False,
        "node_role": "supernode",
    }
    resp = await client.put("/api/admin/service-node", json=payload)
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# HTTP surface: public instance endpoint exposes stripped subset
# ---------------------------------------------------------------------------

async def test_public_instance_exposes_role_but_not_caps(
    client, monkeypatch, tmp_path
):
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))
    save_config(
        ServiceNodeConfig(
            max_cpu_percent=42,
            max_bandwidth_mbps=1000,
            max_storage_gb=200,
            tunnel_anchor_enabled=True,
            node_role="anchor",
        )
    )

    resp = await client.get("/api/instance")
    assert resp.status_code == 200
    body = resp.json()
    # Role subset is published.
    assert body["node_role"] == "anchor"
    assert body["tunnel_anchor_enabled"] is True
    # Raw caps are explicitly NOT published.
    assert "max_cpu_percent" not in body
    assert "max_bandwidth_mbps" not in body
    assert "max_storage_gb" not in body
