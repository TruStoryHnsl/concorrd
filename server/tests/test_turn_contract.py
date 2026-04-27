from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

from httpx import AsyncClient

from models import Channel, Server, ServerMember
from tests.conftest import login_as, logout


async def _seed_voice_server(db_session: Any) -> Channel:
    server = Server(id="srv_turn", name="TURN Test", owner_id="@owner:test.local")
    voice_channel = Channel(
        server_id=server.id,
        matrix_room_id="!turn:test.local",
        name="Voice",
        channel_type="voice",
    )
    member = ServerMember(
        server_id=server.id,
        user_id="@regular:test.local",
        role="member",
    )
    db_session.add_all([server, voice_channel, member])
    await db_session.commit()
    await db_session.refresh(voice_channel)
    return voice_channel


def test_generate_turn_credentials_defaults_to_3478_udp_and_tcp(monkeypatch) -> None:
    from routers import voice as voice_router

    monkeypatch.setenv("TURN_SECRET", "secret")
    monkeypatch.setenv("TURN_HOST", "turn.example.com")
    monkeypatch.setenv("TURN_DOMAIN", "example.com")
    monkeypatch.setenv("TURN_TLS_ENABLED", "false")

    servers = voice_router._generate_turn_credentials("@alice:example.com")

    assert [server.model_dump() for server in servers] == [
        {
            "urls": [
                "turn:turn.example.com:3478?transport=udp",
                "turn:turn.example.com:3478?transport=tcp",
            ],
            "username": servers[0].username,
            "credential": servers[0].credential,
        },
        {
            "urls": "stun:stun.l.google.com:19302",
            "username": None,
            "credential": None,
        },
    ]
    assert servers[0].username
    assert servers[0].credential


def test_generate_turn_credentials_can_advertise_separate_public_tls_port(monkeypatch) -> None:
    from routers import voice as voice_router

    monkeypatch.setenv("TURN_SECRET", "secret")
    monkeypatch.setenv("TURN_HOST", "turn.example.com")
    monkeypatch.setenv("TURN_TLS_ENABLED", "true")
    monkeypatch.setenv("TURN_TLS_PORT", "5349")
    monkeypatch.setenv("TURN_PUBLIC_TLS_PORT", "443")

    servers = voice_router._generate_turn_credentials("@alice:example.com")

    assert servers[0].urls == [
        "turns:turn.example.com:443?transport=tcp",
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
    ]


def test_generate_turn_credentials_can_advertise_tls_only(monkeypatch) -> None:
    from routers import voice as voice_router

    monkeypatch.setenv("TURN_SECRET", "secret")
    monkeypatch.setenv("TURN_HOST", "turn.example.com")
    monkeypatch.setenv("TURN_TLS_ENABLED", "true")
    monkeypatch.setenv("TURN_TLS_PORT", "5349")
    monkeypatch.setenv("TURN_PUBLIC_TLS_PORT", "443")
    monkeypatch.setenv("TURN_TLS_ONLY", "true")

    servers = voice_router._generate_turn_credentials("@alice:example.com")

    assert servers[0].urls == [
        "turns:turn.example.com:443?transport=tcp",
    ]


async def test_voice_token_endpoint_returns_turn_contract_for_members(
    client: AsyncClient,
    db_session: Any,
    monkeypatch,
) -> None:
    await _seed_voice_server(db_session)

    monkeypatch.setenv("TURN_SECRET", "secret")
    monkeypatch.setenv("TURN_HOST", "turn.example.com")
    monkeypatch.setenv("TURN_TLS_ENABLED", "false")

    login_as("@regular:test.local")
    with patch("routers.voice.generate_token", return_value="lk-token"):
        resp = await client.post("/api/voice/token", json={"room_name": "!turn:test.local"})
    logout()

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["token"] == "lk-token"
    assert body["ice_servers"] == [
        {
            "urls": [
                "turn:turn.example.com:3478?transport=udp",
                "turn:turn.example.com:3478?transport=tcp",
            ],
            "username": body["ice_servers"][0]["username"],
            "credential": body["ice_servers"][0]["credential"],
        },
        {
            "urls": "stun:stun.l.google.com:19302",
            "username": None,
            "credential": None,
        },
    ]


def test_turn_stack_architecture_is_env_driven() -> None:
    repo_root = Path(__file__).resolve().parents[2]

    compose = (repo_root / "docker-compose.yml").read_text(encoding="utf-8")
    turn_config = (repo_root / "config/turnserver.conf").read_text(encoding="utf-8")
    turn_entrypoint = (repo_root / "config/coturn-entrypoint.sh").read_text(encoding="utf-8")
    install_script = (repo_root / "install.sh").read_text(encoding="utf-8")

    assert "coturn-entrypoint.sh" in compose
    assert "TURN_EXTERNAL_IP" in compose
    assert "TURN_LISTEN_IP" in compose
    assert "TURN_RELAY_IP" in compose
    assert "TURN_PUBLIC_PORT" in compose
    assert "TURN_TLS_ENABLED" in compose
    assert "TURN_TLS_PORT" in compose
    assert "TURN_PUBLIC_TLS_PORT" in compose
    assert "TURN_TLS_ONLY" in compose
    assert "TURN_TLS_CERT_DIR" in compose
    assert "alt-listening-port=5349" not in turn_config
    assert "TURN_HEALTH_IP" in compose
    assert "$${TURN_LISTEN_IP:-}" in compose
    assert "$${TURN_EXTERNAL_IP#*/}" in compose
    assert "/certs:ro" in compose
    assert "--external-ip=${TURN_EXTERNAL_IP}" in turn_entrypoint
    assert "--listening-ip=${TURN_LISTEN_IP_VALUE}" in turn_entrypoint
    assert "--relay-ip=${TURN_RELAY_IP_VALUE}" in turn_entrypoint
    assert "--tls-listening-port=${TURN_TLS_PORT:-5349}" in turn_entrypoint
    assert "--no-tls --no-dtls" in turn_entrypoint
    assert 'TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP}"' in install_script
    assert 'TURN_PUBLIC_TLS_PORT=443' in install_script
    assert 'TURN_TLS_ONLY=false' in install_script


def test_turn_entrypoint_derives_bind_ips_from_mapped_external_ip(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    entrypoint = repo_root / "config/coturn-entrypoint.sh"
    args_file = tmp_path / "turnserver.args"
    fake_turnserver = tmp_path / "turnserver"
    fake_turnserver.write_text(
        "#!/bin/sh\n"
        "printf '%s\n' \"$@\" > \"$ARGS_FILE\"\n",
        encoding="utf-8",
    )
    fake_turnserver.chmod(0o755)

    env = os.environ.copy()
    env.update({
        "PATH": f"{tmp_path}:{env.get('PATH', '')}",
        "ARGS_FILE": str(args_file),
        "TURN_SECRET": "secret",
        "TURN_DOMAIN": "example.concordchat.net",
        "TURN_EXTERNAL_IP": "162.195.121.21/192.168.1.145",
        "TURN_TLS_ENABLED": "false",
    })

    subprocess.run(
        ["sh", str(entrypoint)],
        check=True,
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )

    args = args_file.read_text(encoding="utf-8").splitlines()
    assert "--external-ip=162.195.121.21/192.168.1.145" in args
    assert "--listening-ip=192.168.1.145" in args
    assert "--relay-ip=192.168.1.145" in args
    assert "--no-tls" in args
    assert "--no-dtls" in args
