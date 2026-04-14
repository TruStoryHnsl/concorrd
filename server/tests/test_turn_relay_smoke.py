from __future__ import annotations

import importlib.util
import socket
import struct
from pathlib import Path


def _load_smoke_module():
    repo_root = Path(__file__).resolve().parents[2]
    script_path = repo_root / "scripts" / "turn_relay_smoke.py"
    spec = importlib.util.spec_from_file_location("turn_relay_smoke", script_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_load_env_file_strips_quotes(tmp_path: Path) -> None:
    smoke = _load_smoke_module()
    env_file = tmp_path / ".env"
    env_file.write_text(
        "# comment\n"
        "TURN_HOST=turn.concorrd.com\n"
        "TURN_SECRET=\"abc123\"\n"
        "TURN_TLS_ENABLED='true'\n",
        encoding="utf-8",
    )

    env = smoke.load_env_file(env_file)

    assert env == {
        "TURN_HOST": "turn.concorrd.com",
        "TURN_SECRET": "abc123",
        "TURN_TLS_ENABLED": "true",
    }


def test_turn_rest_password_is_shared_secret_hmac() -> None:
    smoke = _load_smoke_module()

    password = smoke.turn_rest_password(
        "secret",
        "1776150129:probe",
    )

    assert password == "CS1l1tas5dTOQRjYBzoRnIErA4U="


def test_build_authenticated_allocate_request_includes_integrity() -> None:
    smoke = _load_smoke_module()

    request = smoke.build_authenticated_allocate_request(
        txid=b"0123456789ab",
        username="1776150129:probe",
        realm="turn.concorrd.com",
        nonce="nonce123",
        password="password123",
    )

    msg_type, msg_len, magic, txid = struct.unpack("!HHI12s", request[:20])
    attrs = smoke.parse_attrs(request[20:])

    assert msg_type == smoke.ALLOCATE_REQUEST
    assert msg_len == len(request) - 20
    assert magic == smoke.MAGIC_COOKIE
    assert txid == b"0123456789ab"
    assert any(attr_type == smoke.ATTR_MESSAGE_INTEGRITY and len(value) == 20 for attr_type, value in attrs)
    assert any(attr_type == smoke.ATTR_REQUESTED_TRANSPORT for attr_type, _ in attrs)


def test_decode_xor_address_ipv4_round_trip() -> None:
    smoke = _load_smoke_module()
    txid = b"abcdefghijkl"
    port = 49176
    host = "162.195.121.21"

    xport = port ^ (smoke.MAGIC_COOKIE >> 16)
    xhost = int.from_bytes(socket.inet_aton(host), "big") ^ smoke.MAGIC_COOKIE
    encoded = b"\x00\x01" + struct.pack("!H", xport) + xhost.to_bytes(4, "big")

    decoded_host, decoded_port = smoke.decode_xor_address(encoded, txid)

    assert decoded_host == host
    assert decoded_port == port
