#!/usr/bin/env python3
"""End-to-end TURN relay smoke for the deployed Concord edge.

This script exercises the exact production contract used by Concord voice:

  turns:<TURN_HOST>:<TURN_PUBLIC_TLS_PORT>?transport=tcp

It performs a real TURN Allocate transaction over TLS using the shared-secret
REST credential scheme already used by `server/routers/voice.py`. Success means:

1. The public TLS edge is reachable.
2. SNI routes to the TURN service, not the web app.
3. Certificate validation succeeds for TURN_HOST.
4. TURN long-term auth succeeds.
5. The server returns a public relay allocation.

Run it on the deployment host:

  python3 scripts/turn_relay_smoke.py --env-file .env
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import ssl
import struct
import sys
import time
from pathlib import Path
from typing import Iterable

MAGIC_COOKIE = 0x2112A442

ALLOCATE_REQUEST = 0x0003
ALLOCATE_SUCCESS_RESPONSE = 0x0103
ALLOCATE_ERROR_RESPONSE = 0x0113

ATTR_USERNAME = 0x0006
ATTR_MESSAGE_INTEGRITY = 0x0008
ATTR_ERROR_CODE = 0x0009
ATTR_REALM = 0x0014
ATTR_NONCE = 0x0015
ATTR_XOR_RELAYED_ADDRESS = 0x0016
ATTR_REQUESTED_TRANSPORT = 0x0019

REQUESTED_TRANSPORT_UDP = bytes([17, 0, 0, 0])
MESSAGE_INTEGRITY_SIZE = 20


class SmokeFailure(RuntimeError):
    """Raised when the TURN smoke test fails."""


def load_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        env[key] = value
    return env


def turn_rest_password(shared_secret: str, username: str) -> str:
    digest = hmac.new(shared_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def stun_long_term_key(username: str, realm: str, password: str) -> bytes:
    return hashlib.md5(f"{username}:{realm}:{password}".encode("utf-8")).digest()


def _pad4(value: bytes) -> bytes:
    return value + (b"\x00" * ((4 - len(value) % 4) % 4))


def encode_attr(attr_type: int, value: bytes) -> bytes:
    return struct.pack("!HH", attr_type, len(value)) + _pad4(value)


def parse_attrs(body: bytes) -> list[tuple[int, bytes]]:
    attrs: list[tuple[int, bytes]] = []
    offset = 0
    while offset + 4 <= len(body):
        attr_type, attr_len = struct.unpack("!HH", body[offset:offset + 4])
        offset += 4
        value = body[offset:offset + attr_len]
        offset += attr_len
        offset += (4 - attr_len % 4) % 4
        attrs.append((attr_type, value))
    return attrs


def parse_error_code(value: bytes) -> tuple[int, str]:
    if len(value) < 4:
        raise SmokeFailure("TURN error-code attribute too short")
    code = (value[2] & 0x07) * 100 + value[3]
    reason = value[4:].decode("utf-8", "replace")
    return code, reason


def decode_xor_address(value: bytes, txid: bytes) -> tuple[str, int]:
    if len(value) < 4:
        raise SmokeFailure("XOR address attribute too short")

    family = value[1]
    xport = struct.unpack("!H", value[2:4])[0]
    port = xport ^ (MAGIC_COOKIE >> 16)

    if family == 0x01:
        if len(value) < 8:
            raise SmokeFailure("IPv4 XOR address attribute too short")
        xaddr = int.from_bytes(value[4:8], "big")
        addr = socket.inet_ntoa((xaddr ^ MAGIC_COOKIE).to_bytes(4, "big"))
        return addr, port

    if family == 0x02:
        if len(value) < 20:
            raise SmokeFailure("IPv6 XOR address attribute too short")
        mask = MAGIC_COOKIE.to_bytes(4, "big") + txid
        addr_bytes = bytes(part ^ mask[idx] for idx, part in enumerate(value[4:20]))
        addr = socket.inet_ntop(socket.AF_INET6, addr_bytes)
        return addr, port

    raise SmokeFailure(f"Unsupported XOR address family: {family}")


def recv_exact(sock: ssl.SSLSocket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise SmokeFailure("Socket closed while reading TURN response")
        chunks.extend(chunk)
    return bytes(chunks)


def recv_message(sock: ssl.SSLSocket) -> tuple[int, bytes, bytes]:
    header = recv_exact(sock, 20)
    msg_type, msg_len, magic, txid = struct.unpack("!HHI12s", header)
    if magic != MAGIC_COOKIE:
        raise SmokeFailure(f"Unexpected STUN magic cookie: 0x{magic:08x}")
    body = recv_exact(sock, msg_len)
    return msg_type, txid, body


def build_unauthenticated_allocate_request(txid: bytes) -> bytes:
    attrs = encode_attr(ATTR_REQUESTED_TRANSPORT, REQUESTED_TRANSPORT_UDP)
    return struct.pack("!HHI12s", ALLOCATE_REQUEST, len(attrs), MAGIC_COOKIE, txid) + attrs


def build_authenticated_allocate_request(
    txid: bytes,
    username: str,
    realm: str,
    nonce: str,
    password: str,
) -> bytes:
    body = b"".join([
        encode_attr(ATTR_REQUESTED_TRANSPORT, REQUESTED_TRANSPORT_UDP),
        encode_attr(ATTR_USERNAME, username.encode("utf-8")),
        encode_attr(ATTR_REALM, realm.encode("utf-8")),
        encode_attr(ATTR_NONCE, nonce.encode("utf-8")),
    ])
    header = struct.pack(
        "!HHI12s",
        ALLOCATE_REQUEST,
        len(body) + 4 + MESSAGE_INTEGRITY_SIZE,
        MAGIC_COOKIE,
        txid,
    )
    key = stun_long_term_key(username, realm, password)
    digest = hmac.new(key, header + body, hashlib.sha1).digest()
    return header + body + encode_attr(ATTR_MESSAGE_INTEGRITY, digest)


def first_attr(attrs: Iterable[tuple[int, bytes]], attr_type: int) -> bytes | None:
    for current_type, value in attrs:
        if current_type == attr_type:
            return value
    return None


def _run_smoke_plaintext(
    *,
    turn_host: str,
    port: int,
    username: str,
    password: str,
    timeout: float,
    require_public_relay: bool,
    started: float,
) -> dict[str, object]:
    """Plaintext-TCP variant of run_smoke for ``--target localhost`` (CI).

    Keeps the same allocate+challenge handshake but skips ssl.wrap_socket
    and the public-relay-IP assertion. Used by the CI integration job
    against a freshly-booted docker-compose stack where coturn listens
    on 3478/tcp without TLS termination.
    """
    with socket.create_connection((turn_host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)

        first_txid = secrets.token_bytes(12)
        sock.sendall(build_unauthenticated_allocate_request(first_txid))
        first_type, _, first_body = recv_message(sock)
        first_attrs = parse_attrs(first_body)

        if first_type != ALLOCATE_ERROR_RESPONSE:
            raise SmokeFailure(f"Expected TURN allocate challenge, got 0x{first_type:04x}")

        error_value = first_attr(first_attrs, ATTR_ERROR_CODE)
        if error_value is None:
            raise SmokeFailure("TURN challenge missing ERROR-CODE")
        error_code, error_reason = parse_error_code(error_value)
        if error_code != 401:
            raise SmokeFailure(f"Expected TURN 401 challenge, got {error_code} {error_reason}")

        realm_value = first_attr(first_attrs, ATTR_REALM)
        nonce_value = first_attr(first_attrs, ATTR_NONCE)
        if realm_value is None or nonce_value is None:
            raise SmokeFailure("TURN challenge missing REALM or NONCE")

        realm = realm_value.decode("utf-8", "replace")
        nonce = nonce_value.decode("utf-8", "replace")

        second_txid = secrets.token_bytes(12)
        sock.sendall(
            build_authenticated_allocate_request(
                second_txid,
                username=username,
                realm=realm,
                nonce=nonce,
                password=password,
            )
        )

        second_type, relay_txid, second_body = recv_message(sock)
        second_attrs = parse_attrs(second_body)

        if second_type != ALLOCATE_SUCCESS_RESPONSE:
            error_value = first_attr(second_attrs, ATTR_ERROR_CODE)
            if error_value is not None:
                error_code, error_reason = parse_error_code(error_value)
                raise SmokeFailure(f"TURN allocate failed: {error_code} {error_reason}")
            raise SmokeFailure(f"Expected TURN allocate success, got 0x{second_type:04x}")

        relay_value = first_attr(second_attrs, ATTR_XOR_RELAYED_ADDRESS)
        if relay_value is None:
            raise SmokeFailure("TURN allocate succeeded but omitted XOR-RELAYED-ADDRESS")

        relay_host, relay_port = decode_xor_address(relay_value, relay_txid)
        if require_public_relay:
            relay_ip = ipaddress.ip_address(relay_host)
            if not relay_ip.is_global:
                raise SmokeFailure(f"TURN relay address is not public: {relay_host}:{relay_port}")

        duration_ms = round((time.perf_counter() - started) * 1000, 1)
        return {
            "turn_host": turn_host,
            "public_tls_port": port,
            "username": username,
            "realm": realm,
            "relay_host": relay_host,
            "relay_port": relay_port,
            "tls_version": "plaintext",
            "certificate_subject": (),
            "certificate_san": (),
            "duration_ms": duration_ms,
        }


def run_smoke(
    turn_host: str,
    public_tls_port: int,
    shared_secret: str,
    timeout: float,
    ttl_seconds: int,
    *,
    plaintext: bool = False,
    require_public_relay: bool = True,
) -> dict[str, object]:
    """Run the TURN allocate handshake against a deployed edge.

    ``plaintext=True`` drops the TLS wrap and connects plaintext TCP to
    ``(turn_host, public_tls_port)``. Used by ``--target localhost`` for
    CI integration smoke against a freshly-booted docker-compose stack
    where coturn listens on 3478/tcp without TLS termination.

    ``require_public_relay=False`` skips the assertion that the relay
    address allocated by TURN is globally routable. The loopback /
    docker-bridged relay assigned by a local boot will be private, so
    the check is meaningless in CI integration mode. Production smoke
    must keep this True.
    """
    username = f"{int(time.time()) + ttl_seconds}:smoke"
    password = turn_rest_password(shared_secret, username)
    started = time.perf_counter()

    if plaintext:
        return _run_smoke_plaintext(
            turn_host=turn_host,
            port=public_tls_port,
            username=username,
            password=password,
            timeout=timeout,
            require_public_relay=require_public_relay,
            started=started,
        )

    context = ssl.create_default_context()
    with socket.create_connection((turn_host, public_tls_port), timeout=timeout) as raw_sock:
        with context.wrap_socket(raw_sock, server_hostname=turn_host) as tls_sock:
            tls_sock.settimeout(timeout)
            certificate = tls_sock.getpeercert()

            first_txid = secrets.token_bytes(12)
            tls_sock.sendall(build_unauthenticated_allocate_request(first_txid))
            first_type, _, first_body = recv_message(tls_sock)
            first_attrs = parse_attrs(first_body)

            if first_type != ALLOCATE_ERROR_RESPONSE:
                raise SmokeFailure(f"Expected TURN allocate challenge, got 0x{first_type:04x}")

            error_value = first_attr(first_attrs, ATTR_ERROR_CODE)
            if error_value is None:
                raise SmokeFailure("TURN challenge missing ERROR-CODE")
            error_code, error_reason = parse_error_code(error_value)
            if error_code != 401:
                raise SmokeFailure(f"Expected TURN 401 challenge, got {error_code} {error_reason}")

            realm_value = first_attr(first_attrs, ATTR_REALM)
            nonce_value = first_attr(first_attrs, ATTR_NONCE)
            if realm_value is None or nonce_value is None:
                raise SmokeFailure("TURN challenge missing REALM or NONCE")

            realm = realm_value.decode("utf-8", "replace")
            nonce = nonce_value.decode("utf-8", "replace")

            second_txid = secrets.token_bytes(12)
            tls_sock.sendall(
                build_authenticated_allocate_request(
                    second_txid,
                    username=username,
                    realm=realm,
                    nonce=nonce,
                    password=password,
                )
            )

            second_type, relay_txid, second_body = recv_message(tls_sock)
            second_attrs = parse_attrs(second_body)

            if second_type != ALLOCATE_SUCCESS_RESPONSE:
                error_value = first_attr(second_attrs, ATTR_ERROR_CODE)
                if error_value is not None:
                    error_code, error_reason = parse_error_code(error_value)
                    raise SmokeFailure(f"TURN allocate failed: {error_code} {error_reason}")
                raise SmokeFailure(f"Expected TURN allocate success, got 0x{second_type:04x}")

            relay_value = first_attr(second_attrs, ATTR_XOR_RELAYED_ADDRESS)
            if relay_value is None:
                raise SmokeFailure("TURN allocate succeeded but omitted XOR-RELAYED-ADDRESS")

            relay_host, relay_port = decode_xor_address(relay_value, relay_txid)
            relay_ip = ipaddress.ip_address(relay_host)
            if not relay_ip.is_global:
                raise SmokeFailure(f"TURN relay address is not public: {relay_host}:{relay_port}")

            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            return {
                "turn_host": turn_host,
                "public_tls_port": public_tls_port,
                "username": username,
                "realm": realm,
                "relay_host": relay_host,
                "relay_port": relay_port,
                "tls_version": tls_sock.version(),
                "certificate_subject": certificate.get("subject", ()),
                "certificate_san": certificate.get("subjectAltName", ()),
                "duration_ms": duration_ms,
            }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="TURN relay smoke test for Concord")
    parser.add_argument("--env-file", type=Path, default=Path(".env"), help="Path to deploy .env file")
    parser.add_argument("--turn-host", default="", help="Override TURN_HOST")
    parser.add_argument("--public-tls-port", type=int, default=0, help="Override TURN_PUBLIC_TLS_PORT")
    parser.add_argument("--timeout", type=float, default=10.0, help="Socket timeout in seconds")
    parser.add_argument("--ttl-seconds", type=int, default=900, help="Credential TTL for the smoke username")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of human-readable text")
    # INS-067 W1: localhost integration mode for CI. Targets a freshly-booted
    # docker-compose stack rather than a production TLS edge.
    #   * Connects plaintext TCP to coturn's listening-port (default 3478)
    #     on 127.0.0.1 (no TLS, no SNI verification — the local stack does
    #     not terminate TLS at coturn; production TLS is fronted by sslh
    #     forwarding 443/tcp → 5349/tcp coturn-tls, which CI doesn't replicate).
    #   * Skips the "relay address must be globally routable" assertion
    #     since the loopback relay returns a private 127.0.0.1 address.
    #   * Reads TURN_SECRET / TURN_REALM from the env-file as usual.
    parser.add_argument(
        "--target",
        default="",
        choices=("", "localhost"),
        help="Use 'localhost' for CI integration boot (plaintext TCP STUN against 127.0.0.1:3478)",
    )
    parser.add_argument(
        "--plaintext-port",
        type=int,
        default=3478,
        help="Port for --target localhost plaintext STUN (default 3478)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    env = {}
    if args.env_file.exists():
        env.update(load_env_file(args.env_file))
    env.update({key: value for key, value in os.environ.items() if key.startswith("TURN_")})

    plaintext_mode = args.target == "localhost"

    if plaintext_mode:
        # Localhost CI integration mode: TURN_HOST defaults to 127.0.0.1
        # and TLS is intentionally bypassed (the local stack does not
        # terminate TLS at coturn). TURN_SECRET still required because
        # auth machinery is what we're smoke-testing.
        turn_host = args.turn_host or env.get("TURN_HOST", "").strip() or "127.0.0.1"
        public_tls_port_raw = args.public_tls_port or args.plaintext_port
    else:
        turn_host = args.turn_host or env.get("TURN_HOST", "").strip()
        public_tls_port_raw = args.public_tls_port or int(env.get("TURN_PUBLIC_TLS_PORT", "443") or "443")
        tls_enabled = env.get("TURN_TLS_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
        if not tls_enabled:
            print("FAIL TURN_TLS_ENABLED is false; this smoke expects turns: TLS relay", file=sys.stderr)
            return 2

    shared_secret = env.get("TURN_SECRET", "").strip()

    if not turn_host:
        print("FAIL missing TURN_HOST", file=sys.stderr)
        return 2
    if not shared_secret:
        print("FAIL missing TURN_SECRET", file=sys.stderr)
        return 2

    try:
        result = run_smoke(
            turn_host=turn_host,
            public_tls_port=public_tls_port_raw,
            shared_secret=shared_secret,
            timeout=args.timeout,
            ttl_seconds=args.ttl_seconds,
            plaintext=plaintext_mode,
            require_public_relay=not plaintext_mode,
        )
    except Exception as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        else:
            print(f"FAIL {exc}")
        return 1

    if args.json:
        print(json.dumps({"ok": True, **result}, indent=2))
    else:
        print(
            "PASS "
            f"turns:{result['turn_host']}:{result['public_tls_port']} "
            f"relay={result['relay_host']}:{result['relay_port']} "
            f"tls={result['tls_version']} "
            f"{result['duration_ms']}ms"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
