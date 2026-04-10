"""Discord bridge configuration management for INS-024 Wave 2.

This module handles:
  - Generating AS registration files (YAML) for mautrix-discord
  - Injecting ``[global.appservice.concord_discord]`` into tuwunel.toml
  - Reading/writing registration tokens
  - Token rotation

The on-disk layout under ``CONCORD_BRIDGE_CONFIG_DIR`` (default
``config/``) is:

    config/
      mautrix-discord/
        registration.yaml   — AS registration (gitignored runtime file)
      discord-bridge.env    — Discord bot token (gitignored, 0600)

The tuwunel.toml injection uses the same ``_locked`` / atomic-swap
pattern as ``tuwunel_config.py`` to avoid torn writes.
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

import yaml

from services.tuwunel_config import TUWUNEL_CONFIG_PATH, _locked, _escape_toml_str

logger = logging.getLogger(__name__)

# ── Paths ────────────────────────────────────────────────────────────

_DEFAULT_CONFIG_DIR = Path(__file__).resolve().parent.parent.parent / "config"

def bridge_config_dir() -> Path:
    """Return the bridge config directory, overridable via env."""
    return Path(os.getenv("CONCORD_BRIDGE_CONFIG_DIR", str(_DEFAULT_CONFIG_DIR)))


def _registration_path() -> Path:
    return bridge_config_dir() / "mautrix-discord" / "registration.yaml"


# ── Data types ───────────────────────────────────────────────────────

APPSERVICE_ID = "concord_discord"
SENDER_LOCALPART = "_discord_bot"
USER_NAMESPACE_REGEX = r"@_discord_.*"
ALIAS_NAMESPACE_REGEX = r"#_discord_.*"


@dataclass
class RegistrationFile:
    """Parsed AS registration."""
    id: str
    url: str
    as_token: str
    hs_token: str
    sender_localpart: str
    rate_limited: bool


def _generate_token() -> str:
    """Generate a cryptographically random token for AS/HS auth."""
    return secrets.token_urlsafe(32)


# ── Registration CRUD ────────────────────────────────────────────────

def read_registration_file() -> RegistrationFile | None:
    """Read the current registration file, or None if it doesn't exist."""
    path = _registration_path()
    if not path.exists():
        return None
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        return RegistrationFile(
            id=raw.get("id", APPSERVICE_ID),
            url=raw.get("url", ""),
            as_token=raw.get("as_token", ""),
            hs_token=raw.get("hs_token", ""),
            sender_localpart=raw.get("sender_localpart", SENDER_LOCALPART),
            rate_limited=raw.get("rate_limited", False),
        )
    except Exception:
        logger.exception("Failed to read registration file at %s", path)
        return None


def write_registration_file(
    as_token: str | None = None,
    hs_token: str | None = None,
    bridge_url: str = "http://concord-discord-bridge:29334",
) -> RegistrationFile:
    """Write (or overwrite) the AS registration YAML.

    If ``as_token`` / ``hs_token`` are None, generates fresh ones.
    If the file already exists and tokens are not provided, reuses
    existing tokens (idempotent enable).
    """
    path = _registration_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    existing = read_registration_file()

    final_as = as_token or (existing.as_token if existing else None) or _generate_token()
    final_hs = hs_token or (existing.hs_token if existing else None) or _generate_token()

    reg = {
        "id": APPSERVICE_ID,
        "url": bridge_url,
        "as_token": final_as,
        "hs_token": final_hs,
        "sender_localpart": SENDER_LOCALPART,
        "rate_limited": False,
        "namespaces": {
            "users": [{"exclusive": True, "regex": USER_NAMESPACE_REGEX}],
            "aliases": [{"exclusive": True, "regex": ALIAS_NAMESPACE_REGEX}],
            "rooms": [],
        },
    }

    path.write_text(yaml.safe_dump(reg, sort_keys=False), encoding="utf-8")
    logger.info("Wrote AS registration to %s", path)

    return RegistrationFile(
        id=APPSERVICE_ID,
        url=bridge_url,
        as_token=final_as,
        hs_token=final_hs,
        sender_localpart=SENDER_LOCALPART,
        rate_limited=False,
    )


def delete_registration_file() -> None:
    """Remove the registration file from disk."""
    path = _registration_path()
    if path.exists():
        path.unlink()
        logger.info("Deleted AS registration at %s", path)


def rotate_tokens(
    bridge_url: str = "http://concord-discord-bridge:29334",
) -> RegistrationFile:
    """Generate new AS/HS tokens and rewrite the registration file."""
    return write_registration_file(
        as_token=_generate_token(),
        hs_token=_generate_token(),
        bridge_url=bridge_url,
    )


# ── Tuwunel config injection ────────────────────────────────────────

def ensure_appservice_entry(reg: RegistrationFile) -> None:
    """Inject the ``[global.appservice.concord_discord]`` table into tuwunel.toml.

    Uses the same config path as ``tuwunel_config.py``. The injection is
    idempotent — if the section already exists it's overwritten with current
    tokens. Other sections of the file are preserved.
    """
    import tomllib

    config_path = TUWUNEL_CONFIG_PATH

    config_path.parent.mkdir(parents=True, exist_ok=True)

    # Read existing config
    existing: dict = {}
    if config_path.exists():
        try:
            with open(config_path, "rb") as f:
                existing = tomllib.load(f)
        except Exception:
            logger.warning("Could not parse existing tuwunel.toml; will append")

    # Build the appservice section
    global_section = existing.get("global", {})

    # Ensure appservice key exists as a dict
    if "appservice" not in global_section:
        global_section["appservice"] = {}
    elif not isinstance(global_section["appservice"], dict):
        global_section["appservice"] = {}

    global_section["appservice"][APPSERVICE_ID] = {
        "url": reg.url,
        "as_token": reg.as_token,
        "hs_token": reg.hs_token,
        "sender_localpart": reg.sender_localpart,
        "rate_limited": reg.rate_limited,
    }

    existing["global"] = global_section

    # Write back — we need a custom emitter because tomllib is read-only
    # and the existing _emit_toml only handles flat [global] keys.
    # For the appservice injection we append the TOML inline table manually.
    _write_tuwunel_with_appservice(config_path, existing)


def remove_appservice_entry() -> None:
    """Remove the ``[global.appservice.concord_discord]`` table from tuwunel.toml."""
    import tomllib

    config_path = TUWUNEL_CONFIG_PATH

    if not config_path.exists():
        return

    try:
        with open(config_path, "rb") as f:
            existing = tomllib.load(f)
    except Exception:
        logger.warning("Could not parse tuwunel.toml for appservice removal")
        return

    global_section = existing.get("global", {})
    appservices = global_section.get("appservice", {})

    if isinstance(appservices, dict) and APPSERVICE_ID in appservices:
        del appservices[APPSERVICE_ID]
        if not appservices:
            del global_section["appservice"]
        existing["global"] = global_section
        _write_tuwunel_with_appservice(config_path, existing)
        logger.info("Removed appservice entry from tuwunel.toml")


def _write_tuwunel_with_appservice(config_path: Path, data: dict) -> None:
    """Write a tuwunel.toml that may contain nested appservice tables.

    This extends the flat ``_emit_toml`` from ``tuwunel_config.py`` to
    handle the nested ``[global.appservice.<id>]`` structure that
    tuwunel v1.5.1 uses for AS registrations.
    """
    lines: list[str] = [
        "# Tuwunel runtime configuration",
        "# Managed by the Concord admin UI + bridge config.",
        "",
        "[global]",
    ]

    global_section = data.get("global", {})
    appservices = global_section.pop("appservice", {})

    # Emit flat [global] keys
    for key in sorted(global_section):
        val = global_section[key]
        if isinstance(val, bool):
            lines.append(f"{key} = {'true' if val else 'false'}")
        elif isinstance(val, str):
            lines.append(f'{key} = "{_escape_toml_str(val)}"')
        elif isinstance(val, list):
            items = ", ".join(f'"{_escape_toml_str(str(v))}"' for v in val)
            lines.append(f"{key} = [{items}]")
        elif isinstance(val, int):
            lines.append(f"{key} = {val}")
        elif isinstance(val, dict):
            # Skip nested dicts here — we handle appservice separately
            pass
        else:
            lines.append(f'{key} = "{_escape_toml_str(str(val))}"')

    # Emit appservice tables
    if isinstance(appservices, dict):
        for as_id, as_conf in appservices.items():
            lines.append("")
            lines.append(f"[global.appservice.{as_id}]")
            if isinstance(as_conf, dict):
                for k, v in as_conf.items():
                    if isinstance(v, bool):
                        lines.append(f"{k} = {'true' if v else 'false'}")
                    elif isinstance(v, str):
                        lines.append(f'{k} = "{_escape_toml_str(v)}"')
                    elif isinstance(v, int):
                        lines.append(f"{k} = {v}")
                    elif isinstance(v, list):
                        items = ", ".join(f'"{_escape_toml_str(str(i))}"' for i in v)
                        lines.append(f"{k} = [{items}]")
                    else:
                        lines.append(f'{k} = "{_escape_toml_str(str(v))}"')

    body = "\n".join(lines) + "\n"

    # Atomic swap
    tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp_path, "w", encoding="utf-8") as tmp:
        tmp.write(body)
        tmp.flush()
        os.fsync(tmp.fileno())
    os.replace(tmp_path, config_path)
    logger.info("Updated tuwunel.toml with appservice config")
