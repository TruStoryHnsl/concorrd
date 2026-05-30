#!/usr/bin/env python3
"""Static config-coherence linter for Concord's voice ports (INS-067 W2).

Voice flow correctness depends on FOUR config files agreeing on the
same UDP port range. The 2026-05-01 incident traced to a single edit
in `config/livekit.yaml` that drifted away from `docker-compose.yml`'s
published port mapping — the LiveKit container then bound an internal
range that was never exposed externally, breaking voice without any
HTTP-level signal.

This linter runs in CI (fast pre-test step) and asserts:

  1. `config/livekit.yaml` `rtc.port_range_start` and `rtc.port_range_end`
     equal the **container-side** port range in `docker-compose.yml`'s
     `livekit.ports[]` mapping (the right-hand side of `host:container`).

  2. `LIVEKIT_UDP_START` / `LIVEKIT_UDP_END` defaults in
     `docker-compose.yml` (`${LIVEKIT_UDP_START:-50000}-${LIVEKIT_UDP_END:-50100}`)
     match `livekit.yaml`'s container-side range.

  3. coturn `min-port` / `max-port` in `config/turnserver.conf` and
     `allowed-peer-ip` are consistent with the LiveKit host-port range
     (the relay must be permitted to forward to those ports on
     loopback).

  4. `.env.example` contains advisory comments matching all three.

On failure, prints WHICH-FILE / WHICH-KEY / EXPECTED vs ACTUAL and
exits non-zero. Stable text format so CI logs are diff-greppable.

Usage:
    python3 scripts/lint_config_coherence.py [--repo-root <path>]
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CoherenceResult:
    file: str
    key: str
    expected: object
    actual: object
    severity: str  # "error" | "warning"

    def render(self) -> str:
        return (
            f"[{self.severity.upper()}] {self.file} :: {self.key} :: "
            f"expected={self.expected!r} actual={self.actual!r}"
        )


# ---------------------------------------------------------------------
# Parsers — minimal-dependency. We deliberately avoid pulling in PyYAML
# so the linter can run on a bare Python 3.10+ install with no pip step.
# ---------------------------------------------------------------------


def parse_livekit_yaml(text: str) -> tuple[int | None, int | None]:
    """Extract `rtc.port_range_start` and `rtc.port_range_end` from a
    YAML file by simple regex. Sufficient for our flat top-level rtc
    block; do not use against arbitrarily-nested YAML.
    """
    start = end = None
    in_rtc = False
    for raw in text.splitlines():
        stripped = raw.rstrip()
        if not stripped:
            continue
        # Top-level key: leftmost column non-whitespace.
        if not raw.startswith((" ", "\t")):
            in_rtc = stripped.startswith("rtc:")
            continue
        if not in_rtc:
            continue
        m = re.match(r"\s+port_range_start:\s*(\d+)", raw)
        if m:
            start = int(m.group(1))
            continue
        m = re.match(r"\s+port_range_end:\s*(\d+)", raw)
        if m:
            end = int(m.group(1))
            continue
    return start, end


def parse_compose_livekit_ports(text: str) -> tuple[int | None, int | None, int | None, int | None, int | None, int | None]:
    """Return (host_start, host_end, container_start, container_end,
    udp_start_default, udp_end_default).

    Looks for the livekit service block:
      livekit:
        ...
        ports:
          - "${LIVEKIT_TCP_PORT:-7881}:7881"
          - "${LIVEKIT_UDP_START:-50000}-${LIVEKIT_UDP_END:-50100}:50000-50100/udp"
    """
    in_livekit = False
    in_ports = False
    udp_line = None
    for raw in text.splitlines():
        if re.match(r"^  livekit:\s*$", raw):
            in_livekit = True
            in_ports = False
            continue
        if in_livekit and re.match(r"^  [a-z_-]+:\s*$", raw) and not raw.startswith("    "):
            in_livekit = False
        if not in_livekit:
            continue
        if re.match(r"^    ports:\s*$", raw):
            in_ports = True
            continue
        if in_ports:
            m = re.match(r'^\s*-\s+"([^"]+)"\s*$', raw)
            if not m:
                # exit ports block on first non-list-item line at <= 4 indent
                if re.match(r"^    [a-z_]+:", raw):
                    in_ports = False
                continue
            entry = m.group(1)
            if entry.endswith("/udp"):
                udp_line = entry
                break

    if not udp_line:
        return (None, None, None, None, None, None)

    # Format example:
    # ${LIVEKIT_UDP_START:-50000}-${LIVEKIT_UDP_END:-50100}:50000-50100/udp
    m = re.match(
        r"^\$\{LIVEKIT_UDP_START:-(\d+)\}-\$\{LIVEKIT_UDP_END:-(\d+)\}:(\d+)-(\d+)/udp$",
        udp_line,
    )
    if m:
        return (
            int(m.group(1)),  # host_start (default)
            int(m.group(2)),  # host_end (default)
            int(m.group(3)),  # container_start
            int(m.group(4)),  # container_end
            int(m.group(1)),  # udp_start_default
            int(m.group(2)),  # udp_end_default
        )
    # Plain numeric variant: 50000-50100:50000-50100/udp
    m2 = re.match(r"^(\d+)-(\d+):(\d+)-(\d+)/udp$", udp_line)
    if m2:
        return (
            int(m2.group(1)),
            int(m2.group(2)),
            int(m2.group(3)),
            int(m2.group(4)),
            int(m2.group(1)),
            int(m2.group(2)),
        )
    return (None, None, None, None, None, None)


def parse_turnserver_conf(text: str) -> tuple[int | None, int | None, list[str]]:
    """Return (min_port, max_port, allowed_peer_ips)."""
    min_port = max_port = None
    allowed: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^min-port=(\d+)$", line)
        if m:
            min_port = int(m.group(1))
            continue
        m = re.match(r"^max-port=(\d+)$", line)
        if m:
            max_port = int(m.group(1))
            continue
        m = re.match(r"^allowed-peer-ip=(.+)$", line)
        if m:
            allowed.append(m.group(1).strip())
    return min_port, max_port, allowed


def parse_env_example(text: str) -> dict[str, int | None]:
    """Extract advisory comment values for LIVEKIT_UDP_START / END /
    LIVEKIT_TCP_PORT / LIVEKIT_TURN_PORT, even when commented out
    (the file ships them commented as the default-value advisory)."""
    result: dict[str, int | None] = {
        "LIVEKIT_UDP_START": None,
        "LIVEKIT_UDP_END": None,
        "LIVEKIT_TCP_PORT": None,
        "LIVEKIT_TURN_PORT": None,
    }
    for raw in text.splitlines():
        line = raw.strip().lstrip("#").strip()
        for key in result:
            m = re.match(rf"^{re.escape(key)}=(\d+)$", line)
            if m:
                result[key] = int(m.group(1))
    return result


# ---------------------------------------------------------------------
# Coherence checks
# ---------------------------------------------------------------------


def check_coherence(repo_root: Path) -> list[CoherenceResult]:
    findings: list[CoherenceResult] = []

    livekit_yaml = repo_root / "config" / "livekit.yaml"
    compose_yml = repo_root / "docker-compose.yml"
    turnserver_conf = repo_root / "config" / "turnserver.conf"
    env_example = repo_root / ".env.example"

    for p in (livekit_yaml, compose_yml, turnserver_conf, env_example):
        if not p.is_file():
            findings.append(
                CoherenceResult(
                    file=str(p.relative_to(repo_root)),
                    key="<file>",
                    expected="present",
                    actual="missing",
                    severity="error",
                )
            )
    if findings:
        return findings

    lk_start, lk_end = parse_livekit_yaml(livekit_yaml.read_text())
    (
        host_start,
        host_end,
        ctr_start,
        ctr_end,
        udp_default_start,
        udp_default_end,
    ) = parse_compose_livekit_ports(compose_yml.read_text())
    coturn_min, coturn_max, coturn_allowed = parse_turnserver_conf(turnserver_conf.read_text())
    env_advisory = parse_env_example(env_example.read_text())

    # ── 1) livekit.yaml ↔ compose container-side range ─────────────
    if lk_start != ctr_start:
        findings.append(
            CoherenceResult(
                file="config/livekit.yaml",
                key="rtc.port_range_start",
                expected=ctr_start,
                actual=lk_start,
                severity="error",
            )
        )
    if lk_end != ctr_end:
        findings.append(
            CoherenceResult(
                file="config/livekit.yaml",
                key="rtc.port_range_end",
                expected=ctr_end,
                actual=lk_end,
                severity="error",
            )
        )

    # ── 2) compose UDP defaults ↔ container-side range ──────────────
    if udp_default_start != ctr_start:
        findings.append(
            CoherenceResult(
                file="docker-compose.yml",
                key="livekit.ports[].LIVEKIT_UDP_START default",
                expected=ctr_start,
                actual=udp_default_start,
                severity="error",
            )
        )
    if udp_default_end != ctr_end:
        findings.append(
            CoherenceResult(
                file="docker-compose.yml",
                key="livekit.ports[].LIVEKIT_UDP_END default",
                expected=ctr_end,
                actual=udp_default_end,
                severity="error",
            )
        )

    # ── 3) coturn relay range + allowlist ───────────────────────────
    # The relay range need not equal LiveKit's range — coturn relays
    # client → relay-port → loopback-LiveKit-port. But the relay range
    # MUST disjoint from the LiveKit range to avoid bind conflicts on
    # the same host (network_mode: host).
    if coturn_min is None or coturn_max is None:
        findings.append(
            CoherenceResult(
                file="config/turnserver.conf",
                key="min-port/max-port",
                expected="numeric",
                actual=(coturn_min, coturn_max),
                severity="error",
            )
        )
    elif host_start is not None and host_end is not None:
        # Detect overlap.
        if not (coturn_max < host_start or coturn_min > host_end):
            findings.append(
                CoherenceResult(
                    file="config/turnserver.conf",
                    key="min-port..max-port (overlaps LiveKit host range)",
                    expected=f"disjoint from {host_start}-{host_end}",
                    actual=f"{coturn_min}-{coturn_max}",
                    severity="error",
                )
            )

    if "127.0.0.1" not in coturn_allowed:
        findings.append(
            CoherenceResult(
                file="config/turnserver.conf",
                key="allowed-peer-ip",
                expected="includes 127.0.0.1 (for loopback relay to LiveKit)",
                actual=coturn_allowed,
                severity="error",
            )
        )

    # ── 4) .env.example advisory comments ───────────────────────────
    if env_advisory.get("LIVEKIT_UDP_START") not in (None, ctr_start):
        findings.append(
            CoherenceResult(
                file=".env.example",
                key="LIVEKIT_UDP_START advisory",
                expected=ctr_start,
                actual=env_advisory.get("LIVEKIT_UDP_START"),
                severity="error",
            )
        )
    if env_advisory.get("LIVEKIT_UDP_END") not in (None, ctr_end):
        findings.append(
            CoherenceResult(
                file=".env.example",
                key="LIVEKIT_UDP_END advisory",
                expected=ctr_end,
                actual=env_advisory.get("LIVEKIT_UDP_END"),
                severity="error",
            )
        )

    # ── 5) TLS_MODE matrix coherence ────────────────────────────────
    # The three TLS_MODE values (internal_longlived, letsencrypt_http01,
    # letsencrypt_dns01_cloudflare) must each have a matching
    # `(tls_mode_<value>)` snippet in BOTH Caddyfile and Caddyfile.dev,
    # and the ENV var must be documented in .env.example. Drift here
    # surfaces as "snippet not found" at Caddy startup — too late.
    findings.extend(_check_tls_mode_coherence(repo_root))

    return findings


_TLS_MODE_VALUES = (
    "internal_longlived",
    "letsencrypt_http01",
    "letsencrypt_dns01_cloudflare",
)


def _check_tls_mode_coherence(repo_root: Path) -> list[CoherenceResult]:
    """Verify TLS_MODE snippets exist in both Caddyfiles and that the
    env var is documented + plumbed.
    """
    findings: list[CoherenceResult] = []

    caddyfile_prod = repo_root / "config" / "Caddyfile"
    caddyfile_dev = repo_root / "config" / "Caddyfile.dev"
    env_example = repo_root / ".env.example"
    compose_yml = repo_root / "docker-compose.yml"

    for path in (caddyfile_prod, caddyfile_dev):
        if not path.is_file():
            continue
        text = path.read_text()
        for mode in _TLS_MODE_VALUES:
            snippet_marker = f"(tls_mode_{mode})"
            if snippet_marker not in text:
                findings.append(
                    CoherenceResult(
                        file=str(path.relative_to(repo_root)),
                        key=f"snippet {snippet_marker}",
                        expected="defined",
                        actual="missing",
                        severity="error",
                    )
                )
        # Every Caddyfile must import a TLS_MODE snippet.
        if "import tls_mode_" not in text:
            findings.append(
                CoherenceResult(
                    file=str(path.relative_to(repo_root)),
                    key="import tls_mode_{$TLS_MODE:...}",
                    expected="present",
                    actual="missing",
                    severity="error",
                )
            )

    if env_example.is_file():
        env_text = env_example.read_text()
        for marker in ("TLS_MODE=", "ACME_EMAIL=", "CLOUDFLARE_API_TOKEN="):
            if marker not in env_text:
                findings.append(
                    CoherenceResult(
                        file=".env.example",
                        key=marker.rstrip("="),
                        expected="documented",
                        actual="missing",
                        severity="error",
                    )
                )
        # Each TLS_MODE value should appear at least once in the operator-
        # facing documentation block so the matrix is self-documenting.
        for mode in _TLS_MODE_VALUES:
            if mode not in env_text:
                findings.append(
                    CoherenceResult(
                        file=".env.example",
                        key=f"TLS_MODE value '{mode}'",
                        expected="documented",
                        actual="missing",
                        severity="error",
                    )
                )

    if compose_yml.is_file():
        compose_text = compose_yml.read_text()
        for marker in ("TLS_MODE:", "ACME_EMAIL:", "CLOUDFLARE_API_TOKEN:"):
            if marker not in compose_text:
                findings.append(
                    CoherenceResult(
                        file="docker-compose.yml",
                        key=marker.rstrip(":"),
                        expected="passed through to web service",
                        actual="missing",
                        severity="error",
                    )
                )

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Concord voice port-coherence linter (INS-067 W2)"
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Path to repo root (default: parent of this script)",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="Only print on failure"
    )
    args = parser.parse_args()

    findings = check_coherence(args.repo_root)
    if not findings:
        if not args.quiet:
            print("OK config coherence: livekit.yaml ↔ docker-compose.yml ↔ turnserver.conf ↔ .env.example all agree")
        return 0

    print("FAIL config coherence:")
    for f in findings:
        print(f"  {f.render()}")
    print(
        "\nSee docs/voice/port-coherence.md for the contract and the "
        "2026-05-01 incident worked example."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
