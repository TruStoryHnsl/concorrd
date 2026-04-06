"""Read and write the federation section of the Tuwunel runtime config.

The Concord admin UI owns the `[global]` federation keys of
`/etc/tuwunel.toml` (bind-mounted into both the concord-api and conduwuit
containers). This module provides atomic read/write with file locking so
that concurrent admin requests can't leave the file in a torn state.

Only three keys are managed here:
    - allow_federation: bool
    - forbidden_remote_server_names: list[str]
    - allowed_remote_server_names: list[str]

Everything else under `[global]` is preserved on write if present, so a
future change to let admins manage more keys only needs to extend
`FederationSettings` without breaking existing files.
"""
from __future__ import annotations

import fcntl
import logging
import os
import re
import tomllib
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# Path inside the concord-api container. Overridden in tests.
TUWUNEL_CONFIG_PATH = Path(os.getenv("TUWUNEL_CONFIG_PATH", "/etc/tuwunel.toml"))

# RFC 1123 hostname: labels of 1-63 chars, alnum + hyphen (not leading/trailing),
# dot-separated, total length <= 253. Allows IDN-style LDH only.
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


@dataclass
class FederationSettings:
    """Plain-data container for the three federation keys."""

    allow_federation: bool = True
    forbidden_remote_server_names: list[str] = field(default_factory=lambda: [".*"])
    allowed_remote_server_names: list[str] = field(default_factory=list)


def is_valid_server_name(name: str) -> bool:
    """Validate a plain server name (not a regex) as an RFC-1123 hostname."""
    return bool(_HOSTNAME_RE.match(name))


def server_names_to_regex_patterns(names: list[str]) -> list[str]:
    """Convert plain server names to anchored, escaped regex patterns.

    Uses ``^`` + ``re.escape(name)`` + ``$`` so partial matches are impossible
    (e.g. allowlisting ``friend.example.com`` does NOT permit
    ``evil-friend.example.com``). This is a correctness fix over the pre-TOML
    version, which only anchored the end with ``$``.
    """
    return [rf"^{re.escape(n.strip().lower())}$" for n in names if n.strip()]


@contextmanager
def _locked(path: Path, mode: str):
    """Open `path` and hold an exclusive flock for the duration of the block."""
    # Create parent dir if missing (first run).
    path.parent.mkdir(parents=True, exist_ok=True)
    # 'a+' ensures file exists; seek(0) for reads.
    f = open(path, mode)
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yield f
    finally:
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        f.close()


def read_federation() -> FederationSettings:
    """Read the federation section of the config file.

    Returns defaults if the file does not exist or is missing keys — this
    lets fresh deployments survive even if the install.sh migration hasn't
    populated the file yet.
    """
    if not TUWUNEL_CONFIG_PATH.exists():
        logger.info(
            "tuwunel.toml does not exist at %s; returning defaults",
            TUWUNEL_CONFIG_PATH,
        )
        return FederationSettings()

    with _locked(TUWUNEL_CONFIG_PATH, "rb") as f:
        data = tomllib.load(f)

    g = data.get("global", {})
    return FederationSettings(
        allow_federation=bool(g.get("allow_federation", True)),
        forbidden_remote_server_names=list(
            g.get("forbidden_remote_server_names", [".*"])
        ),
        allowed_remote_server_names=list(
            g.get("allowed_remote_server_names", [])
        ),
    )


def write_federation(settings: FederationSettings) -> None:
    """Atomically rewrite the federation section of the config file.

    Preserves any non-federation keys under `[global]` that a Tuwunel admin
    may have added manually. Uses tmp-file + os.replace for atomicity so the
    conduwuit container never reads a partial write.
    """
    TUWUNEL_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Read existing (if present) to preserve other [global] keys.
    existing_global: dict = {}
    if TUWUNEL_CONFIG_PATH.exists():
        try:
            with open(TUWUNEL_CONFIG_PATH, "rb") as f:
                existing_global = tomllib.load(f).get("global", {})
        except (tomllib.TOMLDecodeError, OSError) as exc:
            logger.warning(
                "tuwunel.toml existed but could not be parsed (%s); "
                "will rewrite from scratch",
                exc,
            )

    # Overlay our managed keys.
    existing_global["allow_federation"] = settings.allow_federation
    existing_global["forbidden_remote_server_names"] = (
        settings.forbidden_remote_server_names
    )
    existing_global["allowed_remote_server_names"] = (
        settings.allowed_remote_server_names
    )

    body = _emit_toml(existing_global)

    # Atomic swap: write to a sibling tmp file, fsync, then rename.
    tmp_path = TUWUNEL_CONFIG_PATH.with_suffix(TUWUNEL_CONFIG_PATH.suffix + ".tmp")
    with _locked(TUWUNEL_CONFIG_PATH, "ab"):  # take lock on target
        with open(tmp_path, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, TUWUNEL_CONFIG_PATH)

    logger.info(
        "tuwunel.toml federation section updated (allowed=%d, forbidden=%d, enabled=%s)",
        len(settings.allowed_remote_server_names),
        len(settings.forbidden_remote_server_names),
        settings.allow_federation,
    )


def _emit_toml(global_table: dict) -> str:
    """Emit a minimal TOML file with a single `[global]` table.

    Scope is intentionally narrow: bool, str, and list[str] only. Any value
    outside those types is coerced to its repr (best-effort preservation of
    externally-added keys). The Concord-managed keys are always typed
    correctly before we get here, so this fallback only matters for foreign
    keys the admin may have added manually.
    """
    lines: list[str] = [
        "# Tuwunel runtime configuration — federation settings",
        "# Managed by the Concord admin UI. Hand edits to [global] keys",
        "# will be overwritten on the next federation allowlist update.",
        "",
        "[global]",
    ]

    # Stable key order: managed keys first, then anything else sorted.
    managed_order = (
        "allow_federation",
        "forbidden_remote_server_names",
        "allowed_remote_server_names",
    )
    seen: set[str] = set()
    for key in managed_order:
        if key in global_table:
            lines.append(_emit_kv(key, global_table[key]))
            seen.add(key)
    for key in sorted(global_table):
        if key not in seen:
            lines.append(_emit_kv(key, global_table[key]))

    return "\n".join(lines) + "\n"


def _emit_kv(key: str, value) -> str:
    if isinstance(value, bool):
        return f"{key} = {'true' if value else 'false'}"
    if isinstance(value, str):
        return f'{key} = "{_escape_toml_str(value)}"'
    if isinstance(value, list):
        items = ", ".join(f'"{_escape_toml_str(str(v))}"' for v in value)
        return f"{key} = [{items}]"
    if isinstance(value, int):
        return f"{key} = {value}"
    # Fallback: emit as string repr. Rare; only for foreign keys.
    return f'{key} = "{_escape_toml_str(str(value))}"'


def _escape_toml_str(s: str) -> str:
    """Escape backslashes and quotes for a TOML basic string."""
    return s.replace("\\", "\\\\").replace('"', '\\"')
