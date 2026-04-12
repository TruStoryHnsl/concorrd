"""Discord bridge (INS-024 Wave 2) configuration pipeline.

This module owns the concord side of the mautrix-discord integration:

* **Fresh AS registration generation** — high-entropy ``as_token`` and
  ``hs_token`` via :func:`secrets.token_urlsafe`, serialised as a YAML
  document whose shape matches ``ruma::api::appservice::Registration``
  (verified in Wave 0 / ``test_tuwunel_asapi.py``).
* **Atomic registration file writes** — tmp-file + ``os.replace`` so
  neither the tuwunel container nor the mautrix-discord container can
  read a partial file during an admin-triggered rotation.
* **Idempotent tuwunel.toml injection** — the bridge needs to live
  under the ``[global.appservice.concord_discord]`` TOML table in
  ``config/tuwunel.toml``. This module writes that table without
  clobbering the federation allowlist keys owned by
  ``services/tuwunel_config.py``. Calling :func:`ensure_appservice_entry`
  twice with the same registration is a no-op (byte-for-byte
  idempotent) so the admin "Enable" flow is safe to retry.
* **Token redaction for logs** — :func:`redact_for_logging` is the
  single sink every logging call at a bridge boundary must go through.
  Structured logs MUST NOT echo raw ``as_token`` / ``hs_token`` /
  ``MAUTRIX_DISCORD_BOT_TOKEN`` values — they are credentials with
  full homeserver authority. The commercial-scope logging policy
  pins this in :doc:`/docs/bridges/discord.md` §4.2.

## Threat model

The bridge's secret trust domain contains three distinct credentials
that MUST NOT leak:

1. ``as_token`` — grants bearer the authority to post as any user
   matching the AS's exclusive namespace (``@_discord_.*:<server>``)
   with ``rate_limited: false``. A leaked ``as_token`` is effectively a
   homeserver admin key for the bridge's namespace.
2. ``hs_token`` — the homeserver signs outgoing txn pushes with this.
   A leaked ``hs_token`` lets an attacker forge events "from the
   homeserver" into the bridge, which in turn would publish them to
   Discord under real-user attribution. Less destructive than
   ``as_token`` but still catastrophic.
3. ``MAUTRIX_DISCORD_BOT_TOKEN`` — the Discord-side credential. Its
   blast radius is whatever Discord permits the bot to do; with
   ``MESSAGE_CONTENT`` + ``MEMBERS_INTENT`` enabled, that includes
   reading every message in every bridged guild. This credential is
   kept in ``config/discord-bridge.env`` (mode 0600) and is NEVER
   handled by this module — only by docker-compose env_file pointing
   the mautrix-discord container at it.

The file permissions this module sets are the second line of defence
after the ``./config`` directory mode which the orrgate operator is
expected to keep at 0750 corr:corr. Nothing in this file trusts the
directory mode; every ``os.chmod`` call is explicit.
"""
from __future__ import annotations

import logging
import os
import re
import secrets
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from services.tuwunel_config import TUWUNEL_CONFIG_PATH, _emit_toml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------

DISCORD_BRIDGE_APPSERVICE_ID = "concord_discord"
"""The ID used for the mautrix-discord bridge inside
``[global.appservice.<ID>]``. Must be stable across rotations so the
TOML injection is truly idempotent — changing this ID would leave an
orphan stale table in ``tuwunel.toml`` that tuwunel would still load."""

DISCORD_BRIDGE_SENDER_LOCALPART = "discordbot"
"""MXID localpart for the bridge's sender user. Must match
``appservice.bot.username`` in ``config/mautrix-discord/config.yaml``
exactly — tuwunel validates the /register username against this value
using the as_token to look up the appservice record. The ``_discord_``
prefix is reserved for virtual users (puppets); the bridge bot itself
uses the plain ``discordbot`` name."""

DISCORD_BRIDGE_USER_NAMESPACE_REGEX = r"@(discordbot|_discord_.*):"
"""Exclusive namespace for bridged virtual users. The leading underscore
is the industry convention that matches mautrix-bridges upstream and
prevents collisions with non-bridge user ids."""

DISCORD_BRIDGE_ALIAS_NAMESPACE_REGEX = r"#_discord_.*"
"""Exclusive namespace for bridged room aliases (DM rooms, guild
channels). Same leading-underscore convention as user namespaces."""

_AS_TOKEN_ENTROPY_BYTES = 32
"""256-bit entropy for as_token / hs_token generation. Matches the
``test_generate_registration_token_length`` assertion in
``test_bridge_config.py`` and the ``secrets.token_urlsafe(32)`` call
used throughout Concord's auth codepaths."""

_REGISTRATION_FILE_MODE = 0o640
"""Registration file mode: owner R/W, group R, world no access. The
tuwunel container runs as the compose-assigned UID and mounts
``./config`` read-only; the group R allows the docker image uid to read
without granting global visibility. See the threat model comment at the
top of this module."""

_BRIDGE_CONTAINER_GID = 1337
"""GID of the mautrix-discord bridge container user (``user: "1337:1337"``
in docker-compose.yml). ``config-runtime.yaml`` must be group-owned by
this GID so the bridge process can read it despite being owned by root
(concord-api runs as root and creates all bridge config files). Only
config-runtime.yaml needs this treatment — registration.yaml is read by
tuwunel (root) and bot-token is only read by concord-api itself."""

_REGISTRATION_FILE_NAME = "registration.yaml"
"""Name of the registration YAML under
``config/mautrix-discord/``. Must NOT be committed to git (enforced in
``.gitignore``) — every rotation generates fresh tokens."""

_BOT_TOKEN_FILE_NAME = "bot-token"
"""Plain-text file storing the operator's Discord bot token.
Mode 0640. Gitignored. Read by write_bridge_runtime_config() to
inject discord.bot_token into config-runtime.yaml."""

_TOKEN_PREFIX_AS = "as_"
_TOKEN_PREFIX_HS = "hs_"


# ---------------------------------------------------------------------
# Typed error hierarchy
# ---------------------------------------------------------------------


class BridgeConfigError(Exception):
    """Base class for all bridge-config failures.

    Every subclass maps to a ``ConcordError`` code on the admin-API
    boundary (see ``routers/admin_bridges.py``). Never raise
    :class:`BridgeConfigError` directly — raise a specific subclass so
    the caller can branch without string matching.
    """


class RegistrationWriteError(BridgeConfigError):
    """Atomic write of ``registration.yaml`` failed.

    Raised when :func:`write_registration_file` cannot complete the
    tmp-file-then-rename sequence — most commonly because the
    containing directory is missing or the filesystem is out of space
    or the target file is locked by another process. The partial tmp
    file is cleaned up before the exception propagates.
    """


class TuwunelTomlInjectionError(BridgeConfigError):
    """Idempotent append to ``tuwunel.toml`` failed.

    Raised when :func:`ensure_appservice_entry` cannot parse, merge, or
    write the existing ``config/tuwunel.toml``. Indicates the file is
    either hand-edited into an unrecognised shape or the backing
    filesystem refused the atomic rename. In either case the original
    file is NEVER overwritten with a partial state — the on-disk file
    is either the unchanged old version or the fully-updated new
    version.
    """


class BridgeRuntimeConfigError(BridgeConfigError):
    """Merge of template config.yaml with generated tokens failed.

    Raised when :func:`write_bridge_runtime_config` cannot read the
    operator-edited ``config.yaml`` template or cannot write the
    resulting ``config-runtime.yaml``.
    """


# ---------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------


def _config_dir() -> Path:
    """Resolve the ``config/`` directory the admin router mounts.

    When concord-api runs inside its compose container the directory is
    bind-mounted at ``/etc/concord-config`` (see ``docker-compose.yml``
    ``concord-api`` volumes). Outside the container (dev loop, tests)
    the default is the repo root's ``config/``. Developers can override
    via ``CONCORD_BRIDGE_CONFIG_DIR`` for sandbox testing.
    """
    override = os.getenv("CONCORD_BRIDGE_CONFIG_DIR", "").strip()
    if override:
        return Path(override)
    # In-container default.
    in_container = Path("/etc/concord-config")
    if in_container.exists():
        return in_container
    # Dev fallback.
    return Path(__file__).resolve().parent.parent.parent / "config"


def bridge_config_dir() -> Path:
    """Return the directory holding the mautrix-discord generated files.

    The directory is created with mode 0750 on first call so there is
    no bootstrap step an operator might miss. Any pre-existing
    directory keeps its mode untouched — we never widen permissions on
    a directory the operator chose to lock down harder.
    """
    d = _config_dir() / "mautrix-discord"
    if not d.exists():
        d.mkdir(parents=True, mode=0o750, exist_ok=True)
    return d


def registration_file_path() -> Path:
    """Full path to the generated ``registration.yaml``.

    Always inside :func:`bridge_config_dir`. Callers must not construct
    alternative paths — the atomic-rename contract only holds when the
    tmp file and the target file share a directory.
    """
    return bridge_config_dir() / _REGISTRATION_FILE_NAME


def runtime_config_file_path() -> Path:
    """Full path to the generated ``config-runtime.yaml``.

    This file is produced by :func:`write_bridge_runtime_config` by
    merging the operator-edited ``config.yaml`` template with the
    freshly-generated ``as_token`` / ``hs_token``. It is gitignored and
    must never be committed — it contains live AS credentials. The bridge
    container reads this file via ``entrypoint + command`` override in
    ``docker-compose.yml``.
    """
    return bridge_config_dir() / "config-runtime.yaml"


def bot_token_file_path() -> Path:
    """Full path to the operator-supplied Discord bot token file.

    The token is stored separately from config.yaml so the committed
    template stays secret-free. write_bridge_runtime_config() reads
    from here, with config.yaml's discord.bot_token as a fallback for
    operators who configured it manually before this flow existed.
    """
    return bridge_config_dir() / _BOT_TOKEN_FILE_NAME


def write_discord_bot_token(token: str, *, path: Path | None = None) -> Path:
    """Atomically write the Discord bot token to disk (mode 0640).

    Validates that token is non-empty and printable. Does NOT call
    write_bridge_runtime_config — the caller must do that explicitly
    (the Enable flow does it as step 3).

    Raises ValueError on a blank/invalid token.
    Raises RegistrationWriteError on filesystem failure.
    """
    token = token.strip()
    if not token:
        raise ValueError("Bot token must not be empty")
    if len(token) > 512:
        raise ValueError("Bot token exceeds maximum length")

    target = path or bot_token_file_path()
    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        tmp_fd, tmp_path_str = tempfile.mkstemp(
            prefix=".bot-token-",
            suffix=".tmp",
            dir=str(target.parent),
        )
    except OSError as exc:
        raise RegistrationWriteError(
            f"Cannot create tmp file in {target.parent}: {exc}"
        ) from exc
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp:
            tmp.write(token)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.chmod(tmp_path, _REGISTRATION_FILE_MODE)
        os.replace(tmp_path, target)
    except Exception as exc:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise RegistrationWriteError(
            f"Failed to write bot token file at {target}: {exc}"
        ) from exc

    logger.info("discord bot token written to %s", target)
    return target


def read_discord_bot_token(*, path: Path | None = None) -> str | None:
    """Read the stored Discord bot token, or None if not yet configured.

    Reads from the bot-token file first. Falls back to
    config.yaml's discord.bot_token field for operators who configured
    it manually before this feature existed.
    Returns None (not raises) when neither source has a token.
    """
    target = path or bot_token_file_path()
    if target.exists():
        try:
            token = target.read_text(encoding="utf-8").strip()
            if token:
                return token
        except OSError:
            pass

    # Fallback: read from config.yaml template
    config_path = bridge_config_dir() / "config.yaml"
    if config_path.exists():
        try:
            doc = yaml.safe_load(config_path.read_text(encoding="utf-8"))
            if isinstance(doc, dict):
                discord_section = doc.get("discord", {})
                if isinstance(discord_section, dict):
                    token = str(discord_section.get("bot_token", "")).strip()
                    if token:
                        return token
        except (yaml.YAMLError, OSError):
            pass

    return None


# ---------------------------------------------------------------------
# Redaction for logs
# ---------------------------------------------------------------------


_SECRET_KEY_PATTERN = re.compile(
    r"(?i)(as_token|hs_token|bot_token|access_token|password|secret)"
)
"""Case-insensitive pattern for keys whose values must be redacted in
structured logs. Matches as a substring so variants like
``MAUTRIX_DISCORD_BOT_TOKEN`` and ``discord_access_token`` are both
caught. A dedicated regex keeps the redaction policy in one place; do
NOT inline string comparisons in individual logging calls."""


def redact_for_logging(value: Any) -> Any:
    """Replace secret values inside a log-shape object with ``"<redacted>"``.

    Usage::

        logger.info(
            "bridge state: %s",
            redact_for_logging({
                "enabled": True,
                "as_token": reg.as_token,
                "sender": reg.sender_mxid,
            }),
        )

    The function recurses into dicts and lists (and tuples) without
    mutating the input — structured log handlers that receive Python
    objects get a clean shallow clone with secrets masked. Strings that
    look like tokens but aren't inside a recognised key are passed
    through unchanged; log ``value: <token>`` will NOT be redacted
    because there's no structural way to detect it. Callers that log
    secrets as free-form strings are violating the commercial-scope
    logging policy and the redaction module can't save them — that's
    what the grep test in ``test_discord_bridge.py`` catches.

    Accepted inputs: ``str``, ``int``, ``float``, ``bool``, ``None``,
    ``dict``, ``list``, ``tuple``, and dataclasses (converted via
    :func:`dataclasses.asdict`). Unknown types are returned unchanged
    so a broken caller at least produces readable logs.
    """
    if isinstance(value, dict):
        return {k: _redact_kv(k, v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        # Recurse but keep the original container type so downstream
        # code that branches on ``isinstance(x, list)`` still works.
        cloned = [redact_for_logging(item) for item in value]
        return cloned if isinstance(value, list) else tuple(cloned)
    return value


def _redact_kv(key: str, value: Any) -> Any:
    """Key-aware inner redactor. If the key matches
    :data:`_SECRET_KEY_PATTERN`, the value becomes ``"<redacted>"``
    regardless of its actual type. Otherwise the value is recursively
    redacted so nested dicts with secret keys are still caught.
    """
    if isinstance(key, str) and _SECRET_KEY_PATTERN.search(key):
        return "<redacted>"
    return redact_for_logging(value)


# ---------------------------------------------------------------------
# Registration generation
# ---------------------------------------------------------------------


@dataclass
class DiscordBridgeRegistration:
    """Materialised AS registration for the mautrix-discord bridge.

    Intentionally NOT tied to any ruma Python binding (there isn't a
    first-class Python port of ruma) — the dataclass mirrors the shape
    verified in Wave 0 against the upstream Rust source and serialises
    to a YAML document mautrix-discord and tuwunel can both parse.
    """

    as_token: str
    hs_token: str
    id: str = DISCORD_BRIDGE_APPSERVICE_ID
    url: str = "http://concord-discord-bridge:29334"
    sender_localpart: str = DISCORD_BRIDGE_SENDER_LOCALPART
    user_namespace_regex: str = DISCORD_BRIDGE_USER_NAMESPACE_REGEX
    alias_namespace_regex: str = DISCORD_BRIDGE_ALIAS_NAMESPACE_REGEX
    rate_limited: bool = False
    protocols: list[str] = field(default_factory=lambda: ["discord"])

    def to_yaml_doc(self) -> dict[str, Any]:
        """Produce the dict that YAML-dumps into a valid ruma Registration.

        Every top-level key is present in the output (including empty
        namespaces) because ruma's ``#[serde(default)]`` tolerance is
        version-dependent and we would rather produce a slightly more
        verbose YAML than risk a Wave 2 bump of mautrix-discord
        choking on a missing ``protocols: []``.
        """
        return {
            "id": self.id,
            "url": self.url,
            "as_token": self.as_token,
            "hs_token": self.hs_token,
            "sender_localpart": self.sender_localpart,
            "namespaces": {
                "users": [
                    {"exclusive": True, "regex": self.user_namespace_regex}
                ],
                "aliases": [
                    {"exclusive": True, "regex": self.alias_namespace_regex}
                ],
                "rooms": [],
            },
            "rate_limited": self.rate_limited,
            "protocols": list(self.protocols),
        }

    def to_tuwunel_global_appservice_table(self) -> dict[str, Any]:
        """Produce the dict that merges into ``[global.appservice.<id>]``.

        Tuwunel's TOML shape is slightly different from ruma's YAML:
        users / aliases / rooms are TOML array-of-tables under the same
        section path, and there is no ``namespaces`` nesting. We build
        both at the same time so a future Wave-2 regression can never
        produce a YAML and TOML that disagree about the bridge's
        identity.
        """
        return {
            "id": self.id,  # tuwunel 1.5+ validates id field matches section key
            "url": self.url,
            "as_token": self.as_token,
            "hs_token": self.hs_token,
            "sender_localpart": self.sender_localpart,
            "rate_limited": self.rate_limited,
            "protocols": list(self.protocols),
            "users": [
                {"exclusive": True, "regex": self.user_namespace_regex}
            ],
            "aliases": [
                {"exclusive": True, "regex": self.alias_namespace_regex}
            ],
        }


def generate_registration() -> DiscordBridgeRegistration:
    """Generate a brand-new registration with fresh tokens.

    Tokens are generated via :func:`secrets.token_urlsafe` with
    :data:`_AS_TOKEN_ENTROPY_BYTES` bytes of underlying randomness.
    Each call produces a distinct pair, so rotation is just "call this
    again and persist the result".
    """
    return DiscordBridgeRegistration(
        as_token=_TOKEN_PREFIX_AS + secrets.token_urlsafe(_AS_TOKEN_ENTROPY_BYTES),
        hs_token=_TOKEN_PREFIX_HS + secrets.token_urlsafe(_AS_TOKEN_ENTROPY_BYTES),
    )


# ---------------------------------------------------------------------
# Atomic write of registration.yaml
# ---------------------------------------------------------------------


def write_registration_file(
    registration: DiscordBridgeRegistration,
    *,
    path: Path | None = None,
) -> Path:
    """Atomically (re)write the registration YAML file.

    Target is :func:`registration_file_path` by default; pass
    ``path=`` in tests to redirect into a tmp dir.

    Sequence:

    1. ``yaml.safe_dump`` the registration doc into a sibling tmp file
       inside the same directory (so the final ``os.replace`` is an
       atomic rename on the same filesystem, not a cross-device copy).
    2. ``os.fsync`` the tmp file before rename so a power loss
       immediately after rename still sees the complete payload.
    3. ``os.chmod`` the final path to :data:`_REGISTRATION_FILE_MODE`.
    4. ``os.replace`` to swap. The old file (if any) is garbage
       collected by the kernel once no process has it open.

    If any step fails, the tmp file is cleaned up and a
    :class:`RegistrationWriteError` is raised. The on-disk target is
    ALWAYS either the pre-call contents or the new contents, never a
    partial write — callers can rely on this when coordinating with
    the tuwunel restart inside ``admin_bridges.py``.
    """
    try:
        target = path or registration_file_path()
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RegistrationWriteError(
            f"Cannot prepare registration target directory: {exc}"
        ) from exc

    doc = registration.to_yaml_doc()
    body = yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)

    try:
        tmp_fd, tmp_path_str = tempfile.mkstemp(
            prefix=".registration-",
            suffix=".yaml.tmp",
            dir=str(target.parent),
        )
    except OSError as exc:
        raise RegistrationWriteError(
            f"Cannot create tmp file in {target.parent}: {exc}"
        ) from exc
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.chmod(tmp_path, _REGISTRATION_FILE_MODE)
        os.replace(tmp_path, target)
    except Exception as exc:  # noqa: BLE001 — we reclassify and reraise
        # Best-effort tmp cleanup; the exception below is the user-facing
        # error. Swallowing the unlink failure keeps the reraise clean.
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise RegistrationWriteError(
            f"Failed to write registration file at {target}: {exc}"
        ) from exc

    logger.info(
        "bridge registration written: %s",
        redact_for_logging({
            "path": str(target),
            "mode": oct(_REGISTRATION_FILE_MODE),
            "as_token": registration.as_token,
            "hs_token": registration.hs_token,
            "id": registration.id,
        }),
    )
    return target


def read_registration_file(
    path: Path | None = None,
) -> DiscordBridgeRegistration | None:
    """Read an existing registration file or return None if absent.

    The admin "Status" endpoint uses this to surface whether the
    bridge is currently configured without leaking the tokens. Returns
    None (not a raised exception) when the file doesn't exist — the
    absence of a registration is a legitimate "bridge disabled" state,
    not an error condition.
    """
    target = path or registration_file_path()
    if not target.exists():
        return None
    try:
        doc = yaml.safe_load(target.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise RegistrationWriteError(
            f"Registration file at {target} is not valid YAML: {exc}"
        ) from exc
    if not isinstance(doc, dict):
        raise RegistrationWriteError(
            f"Registration file at {target} does not contain a YAML mapping"
        )
    try:
        users_ns = doc.get("namespaces", {}).get("users", [{}])
        user_regex = users_ns[0].get("regex", DISCORD_BRIDGE_USER_NAMESPACE_REGEX)
        aliases_ns = doc.get("namespaces", {}).get("aliases", [{}])
        alias_regex = aliases_ns[0].get("regex", DISCORD_BRIDGE_ALIAS_NAMESPACE_REGEX)
        return DiscordBridgeRegistration(
            as_token=str(doc["as_token"]),
            hs_token=str(doc["hs_token"]),
            id=str(doc.get("id", DISCORD_BRIDGE_APPSERVICE_ID)),
            url=str(doc.get("url", "http://concord-discord-bridge:29334")),
            sender_localpart=str(
                doc.get("sender_localpart", DISCORD_BRIDGE_SENDER_LOCALPART)
            ),
            user_namespace_regex=str(user_regex),
            alias_namespace_regex=str(alias_regex),
            rate_limited=bool(doc.get("rate_limited", False)),
            protocols=list(doc.get("protocols", ["discord"])),
        )
    except (KeyError, IndexError, TypeError) as exc:
        raise RegistrationWriteError(
            f"Registration file at {target} is missing a required field: {exc}"
        ) from exc


def delete_registration_file(path: Path | None = None) -> bool:
    """Remove the registration file if present. Returns True when a
    file was actually removed, False when it was already absent.

    Used by the admin "Disable" flow to wipe the on-disk tokens before
    asking the bridge container to stop. The function does NOT delete
    the ``config/mautrix-discord/`` directory itself — the directory
    is part of the committed config tree and persists across enable
    cycles.
    """
    target = path or registration_file_path()
    if not target.exists():
        return False
    target.unlink()
    logger.info("bridge registration file removed: %s", target)
    return True


# ---------------------------------------------------------------------
# Runtime config generation (template + tokens → config-runtime.yaml)
# ---------------------------------------------------------------------


def write_bridge_runtime_config(
    registration: DiscordBridgeRegistration,
    *,
    template_path: Path | None = None,
    output_path: Path | None = None,
) -> Path:
    """Merge the operator config template with generated tokens.

    The operator edits ``config/mautrix-discord/config.yaml`` (the
    template) to set ``homeserver.domain``, ``discord.bot_token``, etc.
    The bridge binary (v0.7.2) requires ``appservice.as_token`` and
    ``appservice.hs_token`` in the config it reads on startup — these
    cannot be absent or placeholder strings.

    This function:
    1. Reads the template (``config.yaml``) as YAML.
    2. Injects ``appservice.as_token`` and ``appservice.hs_token`` from
       the generated registration.
    3. Writes the result atomically to ``config-runtime.yaml`` (gitignored).

    The template is never mutated — the output file is always the
    merged result. Calling this twice with the same registration is
    idempotent (same output, same atomic swap). The bridge container
    reads ``config-runtime.yaml`` via the ``entrypoint``/``command``
    override in ``docker-compose.yml``; it never sees the template
    directly.

    Raises :class:`BridgeRuntimeConfigError` if the template is missing
    or malformed, or if the output write fails.
    """
    config_dir = bridge_config_dir()
    src = template_path or (config_dir / "config.yaml")
    dst = output_path or runtime_config_file_path()

    if not src.exists():
        raise BridgeRuntimeConfigError(
            f"Bridge config template not found at {src}. "
            "Create config/mautrix-discord/config.yaml from the committed example."
        )
    try:
        doc = yaml.safe_load(src.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise BridgeRuntimeConfigError(
            f"Bridge config template at {src} is not valid YAML: {exc}"
        ) from exc
    if not isinstance(doc, dict):
        raise BridgeRuntimeConfigError(
            f"Bridge config template at {src} must be a YAML mapping."
        )

    # Inject appservice tokens.
    if "appservice" not in doc or not isinstance(doc["appservice"], dict):
        doc["appservice"] = {}
    doc["appservice"]["as_token"] = registration.as_token
    doc["appservice"]["hs_token"] = registration.hs_token

    # Inject bot token from the dedicated file (preferred) or leave
    # the config.yaml value in place if the operator set it manually.
    bot_token = read_discord_bot_token()
    if bot_token:
        if "discord" not in doc or not isinstance(doc["discord"], dict):
            doc["discord"] = {}
        doc["discord"]["bot_token"] = bot_token

    body = yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, allow_unicode=True)

    try:
        tmp_fd, tmp_path_str = tempfile.mkstemp(
            prefix=".config-runtime-",
            suffix=".yaml.tmp",
            dir=str(dst.parent),
        )
    except OSError as exc:
        raise BridgeRuntimeConfigError(
            f"Cannot create tmp file in {dst.parent}: {exc}"
        ) from exc
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.chmod(tmp_path, _REGISTRATION_FILE_MODE)  # 0640
        # Group-own by the bridge container GID so UID 1337 can read
        # the file. concord-api runs as root and creates files as
        # root:root; without this chown the bridge (1337:1337) gets
        # EACCES on its own config. Registration.yaml is intentionally
        # NOT chowned here — tuwunel reads it as root.
        os.chown(tmp_path, -1, _BRIDGE_CONTAINER_GID)
        os.replace(tmp_path, dst)
    except Exception as exc:  # noqa: BLE001
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise BridgeRuntimeConfigError(
            f"Failed to write runtime config at {dst}: {exc}"
        ) from exc

    logger.info(
        "bridge runtime config written: %s",
        redact_for_logging({"path": str(dst), "as_token": registration.as_token}),
    )
    return dst


# ---------------------------------------------------------------------
# Idempotent tuwunel.toml appservice entry
# ---------------------------------------------------------------------


def ensure_appservice_entry(
    registration: DiscordBridgeRegistration,
    *,
    tuwunel_toml_path: Path | None = None,
) -> Path:
    """Inject the ``[global.appservice.concord_discord]`` entry idempotently.

    Reads ``config/tuwunel.toml`` (the one
    ``services.tuwunel_config`` already manages), merges in the bridge
    appservice table, and atomically rewrites the file. Every other
    ``[global]`` key — ``allow_federation``, ``allowed_remote_server_names``,
    ``forbidden_remote_server_names``, plus any hand-edited extras — is
    preserved byte-for-byte when possible and byte-equivalent otherwise.

    Called twice in a row with the same registration, this is a byte-
    level no-op after the first call: same ``_emit_toml`` output, same
    file contents, ``os.replace`` swaps the tmp file over an identical
    target. Callers can safely retry without worrying about drift.

    On any failure the original file is left untouched — no partial
    writes, no tmp file left behind.
    """
    path = tuwunel_toml_path or TUWUNEL_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    # Load the existing file (if any) so we can preserve its [global]
    # content. If the file is missing, start from an empty global table.
    if path.exists():
        try:
            existing = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise TuwunelTomlInjectionError(
                f"Cannot parse existing {path}: {exc}"
            ) from exc
    else:
        existing = {}

    global_table = dict(existing.get("global", {}))
    appservice_table = dict(global_table.get("appservice", {}))
    appservice_table[registration.id] = registration.to_tuwunel_global_appservice_table()
    global_table["appservice"] = appservice_table

    body = _emit_bridge_tuwunel_toml(global_table)

    tmp_fd, tmp_path_str = tempfile.mkstemp(
        prefix=".tuwunel-",
        suffix=".toml.tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
    except Exception as exc:  # noqa: BLE001 — reraise as typed error
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise TuwunelTomlInjectionError(
            f"Failed to write tuwunel.toml at {path}: {exc}"
        ) from exc

    logger.info(
        "tuwunel.toml updated with bridge appservice entry: %s",
        redact_for_logging({
            "path": str(path),
            "bridge_id": registration.id,
            "as_token": registration.as_token,
            "hs_token": registration.hs_token,
        }),
    )
    return path


def remove_appservice_entry(
    bridge_id: str = DISCORD_BRIDGE_APPSERVICE_ID,
    *,
    tuwunel_toml_path: Path | None = None,
) -> bool:
    """Drop the bridge's ``[global.appservice.<id>]`` table.

    Used by the "Disable" admin flow to clean up the tuwunel-side
    registration. Preserves every other key. Returns True when the
    entry was actually removed, False when it was already absent.
    Never errors on "already missing" — disable must be idempotent.
    """
    path = tuwunel_toml_path or TUWUNEL_CONFIG_PATH
    if not path.exists():
        return False
    try:
        existing = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise TuwunelTomlInjectionError(
            f"Cannot parse existing {path}: {exc}"
        ) from exc

    global_table = dict(existing.get("global", {}))
    appservice_table = dict(global_table.get("appservice", {}))
    if bridge_id not in appservice_table:
        return False
    del appservice_table[bridge_id]
    if appservice_table:
        global_table["appservice"] = appservice_table
    else:
        global_table.pop("appservice", None)

    body = _emit_bridge_tuwunel_toml(global_table)

    tmp_fd, tmp_path_str = tempfile.mkstemp(
        prefix=".tuwunel-",
        suffix=".toml.tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_path_str)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_path, path)
    except Exception as exc:  # noqa: BLE001
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise TuwunelTomlInjectionError(
            f"Failed to write tuwunel.toml at {path}: {exc}"
        ) from exc

    logger.info("removed bridge appservice entry %s from %s", bridge_id, path)
    return True


def _emit_bridge_tuwunel_toml(global_table: dict[str, Any]) -> str:
    """Serialise a ``{[global]: ...}`` table including appservice subtables.

    Extends the narrow ``_emit_toml`` helper in
    ``services.tuwunel_config`` (which only knows about bool, str,
    int, list-of-str) with the additional shape we need:
    ``appservice`` is a dict whose values are themselves dicts with
    arrays of namespace tables. The narrow helper cannot handle that,
    so we generate the ``[global.appservice.<id>]`` and
    ``[[global.appservice.<id>.users]]`` subtables manually while still
    delegating the scalar keys back to the shared emitter.
    """
    from services.tuwunel_config import _emit_kv as _emit_scalar_kv  # noqa: PLC0415

    header = [
        "# Tuwunel runtime configuration — Concord-managed.",
        "# Federation keys are owned by server/services/tuwunel_config.py.",
        "# Appservice tables are owned by server/services/bridge_config.py.",
        "# Hand edits to managed keys will be overwritten on the next update.",
        "",
        "[global]",
    ]

    # Copy scalar + list-of-str keys first, preserving the order
    # services/tuwunel_config.py uses so a clean concord install produces
    # a stable diff on the existing federation bits.
    appservice = global_table.pop("appservice", None)

    # Emit federation-managed scalars in the established order, then any
    # remaining plain scalars the admin may have added by hand.
    managed_order = (
        "allow_federation",
        "forbidden_remote_server_names",
        "allowed_remote_server_names",
    )
    seen: set[str] = set()
    body: list[str] = list(header)
    for key in managed_order:
        if key in global_table:
            body.append(_emit_scalar_kv(key, global_table[key]))
            seen.add(key)
    for key in sorted(global_table):
        if key in seen:
            continue
        value = global_table[key]
        # Our narrow emitter only handles bool/str/int/list[str] — skip
        # dict/list[dict] entries we don't understand. In practice
        # tuwunel.toml doesn't carry any such entries in this table.
        if isinstance(value, (bool, str, int)) or (
            isinstance(value, list) and all(isinstance(v, (str, int)) for v in value)
        ):
            body.append(_emit_scalar_kv(key, value))

    # Now emit each [global.appservice.<id>] subtable and its nested
    # [[global.appservice.<id>.users/aliases/rooms]] arrays-of-tables.
    if appservice:
        for bridge_id in sorted(appservice):
            entry = dict(appservice[bridge_id])
            users = entry.pop("users", []) or []
            aliases = entry.pop("aliases", []) or []
            rooms = entry.pop("rooms", []) or []
            body.append("")
            body.append(f"[global.appservice.{bridge_id}]")
            for key in sorted(entry):
                value = entry[key]
                if isinstance(value, (bool, str, int)):
                    body.append(_emit_scalar_kv(key, value))
                elif isinstance(value, list) and all(
                    isinstance(v, str) for v in value
                ):
                    body.append(_emit_scalar_kv(key, value))
            for namespace_key, namespace_values in (
                ("users", users),
                ("aliases", aliases),
                ("rooms", rooms),
            ):
                for ns in namespace_values:
                    body.append("")
                    body.append(f"[[global.appservice.{bridge_id}.{namespace_key}]]")
                    for inner_key in sorted(ns):
                        inner_value = ns[inner_key]
                        if isinstance(inner_value, (bool, str, int)):
                            body.append(_emit_scalar_kv(inner_key, inner_value))

    return "\n".join(body) + "\n"
