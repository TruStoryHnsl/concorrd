"""Background voice-subsystem health check.

A self-hosted Concord instance can find itself in a state where its
TURN relay is configured but not reachable from the public internet
(no port-forward, stale WAN IP, sslh missing in front of coturn, etc.).
Historically this state was silent — the API kept returning ICE servers
the client couldn't route to, voice silently failed for off-LAN users,
and the operator had no visible signal anything was wrong.

This module fixes that. It runs ``check_turn_health()``-style probes
in the background, caches the result, and exposes:

* ``current_status()`` — synchronous read of the latest snapshot.
* ``/api/hosting/status`` (via routers/hosting.py) — operator-visible
  surface so misconfiguration becomes a visible problem instead of an
  invisible one.
* ``/api/voice/token`` integration — when the subsystem is unhealthy,
  the token endpoint returns 503 with an actionable error message
  instead of issuing credentials a client cannot use.

Design rules (set in the architecture-cleanup sprint):

* concord-api MUST boot even when the voice subsystem is broken. The
  Concord *client* role works fine without working local hosting — a
  user can still connect to other instances. So health checks here
  never raise out of the lifespan hook; they record and report.
* The check runs periodically (every 10 minutes by default) so the
  operator can fix DNS/firewall/router config and have it noticed
  without an API restart.
* All blocking network IO runs in an executor so the asyncio loop
  stays responsive.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# Default cadence: 10 minutes. Override via env for tests / aggressive
# probing on a new install. Refreshed at boot regardless.
PROBE_INTERVAL_SECONDS = int(os.getenv("CONCORD_VOICE_HEALTH_INTERVAL", "600"))
PROBE_TIMEOUT_SECONDS = 3.0


@dataclass
class VoiceHealthSnapshot:
    """Current state of the voice subsystem from the operator's POV."""

    healthy: bool
    turn_configured: bool
    turn_host: str = ""
    turn_reachable: bool = False
    turn_latency_ms: Optional[float] = None
    remediation: list[str] = field(default_factory=list)
    last_checked_at: float = 0.0
    last_error: str = ""

    def to_dict(self) -> dict:
        return {
            "healthy": self.healthy,
            "turn_configured": self.turn_configured,
            "turn_host": self.turn_host,
            "turn_reachable": self.turn_reachable,
            "turn_latency_ms": self.turn_latency_ms,
            "remediation": list(self.remediation),
            "last_checked_at": self.last_checked_at,
            "last_error": self.last_error,
        }


# Sentinel for "never been probed yet." Boot returns this until the
# first probe completes. Callers should treat it as "unknown" — neither
# fail-closed (which would block legitimate requests on a clean install
# before the first probe runs) nor fail-open (which would silently
# return ICE servers we haven't verified).
_NEVER_PROBED = VoiceHealthSnapshot(
    healthy=False,
    turn_configured=False,
    remediation=["Voice subsystem hasn't been probed yet. Try again in a few seconds."],
)


class _HealthState:
    def __init__(self) -> None:
        self._snapshot: VoiceHealthSnapshot = _NEVER_PROBED
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    @property
    def snapshot(self) -> VoiceHealthSnapshot:
        return self._snapshot

    async def _set(self, snap: VoiceHealthSnapshot) -> None:
        async with self._lock:
            self._snapshot = snap

    async def probe_once(self) -> VoiceHealthSnapshot:
        """Run one round of probing and update the cached snapshot."""
        snap = await asyncio.get_event_loop().run_in_executor(None, _probe_voice_blocking)
        await self._set(snap)
        return snap

    async def _loop(self) -> None:
        # First probe runs immediately so we have data ASAP after boot.
        # Subsequent probes run on the configured interval.
        while not self._stop.is_set():
            try:
                await self.probe_once()
            except Exception as e:
                logger.warning("voice_health: probe raised: %s", e)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=PROBE_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                continue

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="voice_health_loop")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
            self._task = None


_state = _HealthState()


def current_status() -> VoiceHealthSnapshot:
    """Read the latest cached snapshot. Always returns a snapshot —
    callers don't have to handle a None case."""
    return _state.snapshot


def start_background_probe() -> None:
    """Kick off the periodic probe loop. Call from concord-api lifespan."""
    _state.start()


async def stop_background_probe() -> None:
    """Clean up the probe loop at shutdown."""
    await _state.stop()


async def probe_now() -> VoiceHealthSnapshot:
    """Trigger an immediate probe (e.g. after the operator edits config
    and wants to see if the fix worked without waiting for the next
    scheduled cycle)."""
    return await _state.probe_once()


# ---------------------------------------------------------------------
# Probe implementation — synchronous (runs in an executor).
# ---------------------------------------------------------------------


def _probe_voice_blocking() -> VoiceHealthSnapshot:
    """Run a one-shot health probe of the voice subsystem.

    Steps, each independently logged:
    1. Is TURN_SECRET set? Without it the API can't mint credentials.
    2. Does TURN_HOST resolve to a non-RFC1918 address? An RFC1918
       TURN_HOST means off-LAN clients can't reach the relay even if
       it's running.
    3. Can we open a STUN binding against the configured TURN host on
       port 3478 from this process? Catches "TURN_HOST DNS resolves
       but coturn isn't actually listening / firewall drops it" cases.

    Aggregated into a single VoiceHealthSnapshot with explicit
    remediation suggestions when something is wrong.
    """
    from routers.voice import _turn_host, _turn_public_port, _turn_secret
    from routers.voice import _is_rfc1918

    snap = VoiceHealthSnapshot(
        healthy=False,
        turn_configured=False,
        last_checked_at=time.time(),
    )

    if not _turn_secret():
        snap.remediation.append(
            "TURN_SECRET is unset. Generate one with `openssl rand -hex 32` and "
            "set it in your .env, then restart concord-api so coturn and the "
            "API share the same shared secret."
        )
        snap.last_error = "TURN_SECRET unset"
        return snap

    snap.turn_configured = True
    host = _turn_host()
    port = _turn_public_port()
    snap.turn_host = host

    # Resolve and reject obviously-broken hosts.
    try:
        resolved = socket.gethostbyname(host)
    except OSError as exc:
        snap.last_error = f"DNS lookup for {host!r} failed: {exc}"
        snap.remediation.append(
            f"TURN_HOST resolves to nothing. Ensure {host} has an A record "
            f"pointing at your instance's public IP."
        )
        return snap

    if _is_rfc1918(resolved):
        snap.last_error = f"TURN_HOST {host!r} resolves to private address {resolved}"
        snap.remediation.append(
            f"TURN_HOST {host} resolves to {resolved}, which is a private/loopback "
            f"address that off-LAN clients cannot reach. Update DNS or change "
            f"TURN_HOST (or PUBLIC_BASE_URL, which it derives from) to a public "
            f"DNS name that resolves to your WAN IP."
        )
        return snap

    # STUN bind probe — confirms the relay is actually listening.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(PROBE_TIMEOUT_SECONDS)
    import secrets as _secrets

    tx_id = _secrets.token_bytes(12)
    stun_header = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tx_id
    started = time.monotonic()
    try:
        sock.sendto(stun_header, (host, port))
        data, _ = sock.recvfrom(1024)
        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        if len(data) >= 20 and struct.unpack("!H", data[:2])[0] == 0x0101:
            snap.turn_reachable = True
            snap.turn_latency_ms = elapsed_ms
            snap.healthy = True
        else:
            snap.last_error = (
                f"STUN response from {host}:{port} was not a Binding Success "
                f"({len(data)} bytes, type=0x{struct.unpack('!H', data[:2])[0]:04x} "
                f"if parsable)"
            )
            snap.remediation.append(
                "The address is responding but not as a STUN server. Verify "
                "that coturn (NOT some other service) is bound to "
                f"{host}:{port}/udp."
            )
    except socket.timeout:
        snap.last_error = f"STUN binding to {host}:{port}/udp timed out"
        snap.remediation.append(
            f"No UDP response from {host}:{port} within {PROBE_TIMEOUT_SECONDS}s. "
            "Likely causes: (a) coturn isn't running, (b) your router doesn't "
            f"forward UDP {port} to your host's LAN IP, (c) the WAN IP rotated "
            "since DNS was last set. Verify coturn is up and inbound UDP/3478 "
            "and TCP/443 reach the host."
        )
    except OSError as exc:
        snap.last_error = f"STUN probe socket error: {exc}"
        snap.remediation.append(
            f"Socket-level failure while probing {host}:{port}. The probe ran "
            "from inside the host, so DNS or local firewall is the most likely "
            "cause. Check the concord-api container's network config."
        )
    finally:
        sock.close()

    return snap
