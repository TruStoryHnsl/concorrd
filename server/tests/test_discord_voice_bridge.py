"""Tests for the Discord voice bridge admin router."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from models import Channel, Server, ServerMember
from tests.conftest import login_as, logout


@pytest.fixture
def voice_bridge_tmp_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Path:
    cfg = tmp_path / "discord-voice-bridge"

    from routers import admin_discord_voice as router_mod
    from services import discord_voice_config as config_mod

    monkeypatch.setattr(config_mod, "CONFIG_DIR", cfg)
    monkeypatch.setattr(config_mod, "ROOMS_FILE", cfg / "rooms.json")
    monkeypatch.setattr(router_mod, "ROOMS_FILE", cfg / "rooms.json")
    return cfg


@pytest.fixture
def mock_voice_docker(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    from routers import admin_discord_voice as router_mod

    restart_mock = AsyncMock(return_value={"restarted": ["voice123"], "elapsed_seconds": 0.01})
    start_mock = AsyncMock(return_value={"started": ["voice123"], "already_running": [], "elapsed_seconds": 0.01})
    stop_mock = AsyncMock(return_value={"stopped": ["voice123"], "already_stopped": [], "elapsed_seconds": 0.01})

    monkeypatch.setattr(router_mod, "restart_compose_service", restart_mock)
    monkeypatch.setattr(router_mod, "start_compose_service", start_mock)
    monkeypatch.setattr(router_mod, "stop_compose_service", stop_mock)
    return {"restart": restart_mock, "start": start_mock, "stop": stop_mock}


async def _seed_server_with_channels(db_session: Any) -> tuple[Channel, Channel]:
    server = Server(id="srv_voice_bridge", name="Voice Test", owner_id="@owner:test.local")
    voice_channel = Channel(
        server_id=server.id,
        matrix_room_id="!voice:test.local",
        name="Voice",
        channel_type="voice",
    )
    text_channel = Channel(
        server_id=server.id,
        matrix_room_id="!text:test.local",
        name="Text",
        channel_type="text",
    )
    admin = ServerMember(server_id=server.id, user_id="@test_admin:test.local", role="admin")
    regular = ServerMember(server_id=server.id, user_id="@regular:test.local", role="member")

    db_session.add_all([server, voice_channel, text_channel, admin, regular])
    await db_session.commit()
    await db_session.refresh(voice_channel)
    await db_session.refresh(text_channel)
    return voice_channel, text_channel


async def test_upsert_room_requires_server_admin(
    client: AsyncClient,
    db_session: Any,
    voice_bridge_tmp_dir: Path,
) -> None:
    voice_channel, _ = await _seed_server_with_channels(db_session)

    login_as("@regular:test.local")
    resp = await client.post(
        "/api/admin/bridges/discord/voice/rooms",
        json={
            "channel_id": voice_channel.id,
            "discord_guild_id": "123456789012345678",
            "discord_channel_id": "234567890123456789",
        },
    )
    assert resp.status_code == 403
    assert not (voice_bridge_tmp_dir / "rooms.json").exists()
    logout()


async def test_upsert_room_writes_sidecar_rooms_file(
    client: AsyncClient,
    db_session: Any,
    voice_bridge_tmp_dir: Path,
) -> None:
    voice_channel, _ = await _seed_server_with_channels(db_session)

    login_as("@test_admin:test.local")
    resp = await client.post(
        "/api/admin/bridges/discord/voice/rooms",
        json={
            "channel_id": voice_channel.id,
            "discord_guild_id": "123456789012345678",
            "discord_channel_id": "234567890123456789",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["matrix_room_id"] == "!voice:test.local"

    rooms = json.loads((voice_bridge_tmp_dir / "rooms.json").read_text(encoding="utf-8"))
    assert rooms == {
        "rooms": [
            {
                "id": resp.json()["id"],
                "server_id": "srv_voice_bridge",
                "channel_id": voice_channel.id,
                "matrix_room_id": "!voice:test.local",
                "discord_guild_id": "123456789012345678",
                "discord_channel_id": "234567890123456789",
                "enabled": True,
            }
        ]
    }
    logout()


async def test_upsert_room_rejects_text_channels(
    client: AsyncClient,
    db_session: Any,
    voice_bridge_tmp_dir: Path,
) -> None:
    _, text_channel = await _seed_server_with_channels(db_session)

    login_as("@test_admin:test.local")
    resp = await client.post(
        "/api/admin/bridges/discord/voice/rooms",
        json={
            "channel_id": text_channel.id,
            "discord_guild_id": "123456789012345678",
            "discord_channel_id": "234567890123456789",
        },
    )
    assert resp.status_code == 422
    assert "Only Concord voice channels" in resp.text
    assert not (voice_bridge_tmp_dir / "rooms.json").exists()
    logout()


async def test_restart_targets_voice_bridge_service(
    client: AsyncClient,
    db_session: Any,
    voice_bridge_tmp_dir: Path,
    mock_voice_docker: dict[str, AsyncMock],
) -> None:
    voice_channel, _ = await _seed_server_with_channels(db_session)

    login_as("@test_admin:test.local")
    await client.post(
        "/api/admin/bridges/discord/voice/rooms",
        json={
            "channel_id": voice_channel.id,
            "discord_guild_id": "123456789012345678",
            "discord_channel_id": "234567890123456789",
        },
    )
    resp = await client.post("/api/admin/bridges/discord/voice/restart")
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert mock_voice_docker["restart"].await_args.args == ("concord-discord-voice-bridge",)
    assert mock_voice_docker["start"].await_count == 0
    assert mock_voice_docker["stop"].await_count == 0
    assert (voice_bridge_tmp_dir / "rooms.json").exists()
    logout()


async def test_start_targets_voice_bridge_service(
    client: AsyncClient,
    db_session: Any,
    voice_bridge_tmp_dir: Path,
    mock_voice_docker: dict[str, AsyncMock],
) -> None:
    voice_channel, _ = await _seed_server_with_channels(db_session)

    login_as("@test_admin:test.local")
    await client.post(
        "/api/admin/bridges/discord/voice/rooms",
        json={
            "channel_id": voice_channel.id,
            "discord_guild_id": "123456789012345678",
            "discord_channel_id": "234567890123456789",
        },
    )
    resp = await client.post("/api/admin/bridges/discord/voice/start")
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert mock_voice_docker["start"].await_args.args == ("concord-discord-voice-bridge",)
    assert mock_voice_docker["restart"].await_count == 0
    assert mock_voice_docker["stop"].await_count == 0
    assert (voice_bridge_tmp_dir / "rooms.json").exists()
    logout()
