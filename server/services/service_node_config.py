"""Service node resource contribution + role configuration (INS-023).

This module is the single source of truth for a Concord instance's
self-declared **service node posture** — the knobs an operator adjusts
in the admin panel to tell peers and the embedded servitude how much
CPU, bandwidth and storage the node is willing to contribute, and
which of the structural service-node *roles* the instance plays in
the wider Concord mesh.

The config lives in ``service_node.json`` next to ``instance.json``
inside ``CONCORD_DATA_DIR`` and is written atomically (tmp + fsync +
os.replace) so a crash mid-write cannot leave a torn file on disk.
The atomic-write pattern mirrors ``services.tuwunel_config._write_toml``
and ``services.bridge_config._write_tuwunel_with_appservice`` so the
whole config layer has one consistent durability story.

### Public vs admin surface

Two separate reads exist on purpose:

* :func:`load_config` returns the full :class:`ServiceNodeConfig`
  and is the admin-only surface. CPU / bandwidth / storage caps are
  deliberately kept OUT of any unauthenticated endpoint — they leak
  hardware capacity information that an attacker could use to
  fingerprint the deployment or plan a resource-exhaustion attack.

* :func:`public_view` returns a stripped :class:`ServiceNodePublicView`
  containing ONLY the structural role flags (``node_role`` and
  ``tunnel_anchor_enabled``) and is safe to inline into the
  unauthenticated ``/.well-known/concord/client`` discovery document
  (:mod:`routers.wellknown`) so peers can see *what* the node is
  without learning *how much* of it they'd be connecting to.

### Default on first run

``load_config`` returns :meth:`ServiceNodeConfig.defaults` when the
file is absent or empty, so the admin endpoints always have something
sane to render on a fresh deployment.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: JSON file name persisted alongside ``instance.json`` in ``CONCORD_DATA_DIR``.
SERVICE_NODE_FILE_NAME = "service_node.json"

#: Allowed values for the ``node_role`` field. Kept in sync with the
#: TypeScript ``NodeRole`` union in ``client/src/api/wellKnown.ts``.
NodeRole = Literal["frontend-only", "hybrid", "anchor"]
ALLOWED_ROLES: tuple[str, ...] = ("frontend-only", "hybrid", "anchor")

#: Hard maxima. Chosen large enough to never get in the way of real
#: deployments and small enough to catch typos before they land on disk.
MAX_CPU_PERCENT = 100
MAX_BANDWIDTH_MBPS = 100_000  # 100 Gbps — well above any expected hardware
MAX_STORAGE_GB = 100_000      # 100 TB — same sanity rationale


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ServiceNodeConfig:
    """Full service-node contribution + role config (admin surface).

    The contribution caps (``max_cpu_percent``, ``max_bandwidth_mbps``,
    ``max_storage_gb``) are policy knobs — the runtime isn't yet
    enforcing them, but persisting them lets the admin UI surface the
    operator's intent today and gives future scheduler code something
    concrete to honor later.

    Attributes:
        max_cpu_percent: Ceiling on CPU the node will contribute,
            expressed as a whole percent 1..100 (inclusive). Default
            ``80`` leaves 20% of the machine for the OS + admin tasks.
        max_bandwidth_mbps: Outbound bandwidth cap in megabits/sec.
            ``0`` means "unlimited". Range 0..100_000.
        max_storage_gb: On-disk storage cap for cached/relay data in
            gigabytes. ``0`` means "unlimited". Range 0..100_000.
        tunnel_anchor_enabled: Whether this node advertises itself as
            a persistent tunnel anchor (stable mesh point other nodes
            can dial into). Defaults to ``False`` — must be
            opt-in because it implies the operator commits to uptime.
        node_role: Structural role the node plays in the mesh. One of
            ``"frontend-only"`` (UI only, no hosting), ``"hybrid"``
            (default — UI + opportunistic hosting) or ``"anchor"``
            (always-on infrastructure node, requires
            ``tunnel_anchor_enabled=True`` to be coherent).
    """

    max_cpu_percent: int = 80
    max_bandwidth_mbps: int = 0
    max_storage_gb: int = 0
    tunnel_anchor_enabled: bool = False
    node_role: NodeRole = "hybrid"

    @classmethod
    def defaults(cls) -> "ServiceNodeConfig":
        """Return the default config used on first run / missing file."""
        return cls()

    def validate(self) -> None:
        """Raise :class:`ServiceNodeConfigError` on any invalid field.

        Called from :func:`load_config` after parsing JSON and from
        :func:`save_config` before writing to disk, so an invalid value
        can never land on disk and a corrupted file is caught at load.
        """
        if not isinstance(self.max_cpu_percent, int) or isinstance(
            self.max_cpu_percent, bool
        ):
            raise ServiceNodeConfigError(
                f"max_cpu_percent must be an int, got {type(self.max_cpu_percent).__name__}"
            )
        if not 1 <= self.max_cpu_percent <= MAX_CPU_PERCENT:
            raise ServiceNodeConfigError(
                f"max_cpu_percent must be between 1 and {MAX_CPU_PERCENT}, "
                f"got {self.max_cpu_percent}"
            )

        if not isinstance(self.max_bandwidth_mbps, int) or isinstance(
            self.max_bandwidth_mbps, bool
        ):
            raise ServiceNodeConfigError(
                f"max_bandwidth_mbps must be an int, got {type(self.max_bandwidth_mbps).__name__}"
            )
        if not 0 <= self.max_bandwidth_mbps <= MAX_BANDWIDTH_MBPS:
            raise ServiceNodeConfigError(
                f"max_bandwidth_mbps must be between 0 and {MAX_BANDWIDTH_MBPS}, "
                f"got {self.max_bandwidth_mbps}"
            )

        if not isinstance(self.max_storage_gb, int) or isinstance(
            self.max_storage_gb, bool
        ):
            raise ServiceNodeConfigError(
                f"max_storage_gb must be an int, got {type(self.max_storage_gb).__name__}"
            )
        if not 0 <= self.max_storage_gb <= MAX_STORAGE_GB:
            raise ServiceNodeConfigError(
                f"max_storage_gb must be between 0 and {MAX_STORAGE_GB}, "
                f"got {self.max_storage_gb}"
            )

        if not isinstance(self.tunnel_anchor_enabled, bool):
            raise ServiceNodeConfigError(
                f"tunnel_anchor_enabled must be a bool, got "
                f"{type(self.tunnel_anchor_enabled).__name__}"
            )

        if self.node_role not in ALLOWED_ROLES:
            raise ServiceNodeConfigError(
                f"node_role must be one of {ALLOWED_ROLES}, got {self.node_role!r}"
            )

        # Coherence check: an "anchor" role without the tunnel anchor
        # flag is self-contradictory. We upgrade-warn instead of
        # raising so operators can toggle fields independently, but the
        # public view still advertises the flag faithfully.
        if self.node_role == "anchor" and not self.tunnel_anchor_enabled:
            logger.warning(
                "service_node_config: node_role='anchor' but "
                "tunnel_anchor_enabled=False — the advertised role will "
                "look inconsistent to peers. Consider enabling the "
                "anchor flag or picking role='hybrid'."
            )


@dataclass
class ServiceNodePublicView:
    """Safe-to-publish subset of :class:`ServiceNodeConfig`.

    This is what gets embedded in the unauthenticated
    ``/.well-known/concord/client`` document. Contains ONLY the
    structural role flags — no raw caps, no hardware numbers.
    """

    node_role: NodeRole = "hybrid"
    tunnel_anchor_enabled: bool = False


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class ServiceNodeConfigError(ValueError):
    """Raised when the service_node.json file is invalid or unsafe to save.

    Subclasses :class:`ValueError` so existing FastAPI error handlers
    already log it as a client-facing bad-input condition. The message
    is intended to be safe to return verbatim to an authenticated admin
    (no secrets, no paths).
    """


# ---------------------------------------------------------------------------
# Disk I/O
# ---------------------------------------------------------------------------

def _resolve_path() -> Path:
    """Return the absolute path to ``service_node.json``.

    Reads :envvar:`CONCORD_DATA_DIR` lazily (at call time, not import
    time) so tests that monkey-patch ``os.environ`` between imports
    still see the right directory. Falls back to the default
    ``/data`` location used by ``config.DATA_DIR``.
    """
    env_dir = os.environ.get("CONCORD_DATA_DIR") or os.environ.get(
        "CONCORRD_DATA_DIR"
    )
    data_dir = Path(env_dir) if env_dir else Path("/data")
    return data_dir / SERVICE_NODE_FILE_NAME


def load_config() -> ServiceNodeConfig:
    """Load and validate the service node config.

    Returns :meth:`ServiceNodeConfig.defaults` when the file does not
    exist or is empty — a fresh deployment should not have to write the
    file before hitting the admin endpoints.

    Raises:
        ServiceNodeConfigError: The file exists but contains invalid JSON,
            an unexpected top-level shape, or values that fail
            :meth:`ServiceNodeConfig.validate`.
    """
    path = _resolve_path()
    if not path.exists():
        return ServiceNodeConfig.defaults()

    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ServiceNodeConfigError(
            f"service_node.json could not be read: {exc.strerror or exc}"
        ) from exc

    if not raw:
        return ServiceNodeConfig.defaults()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ServiceNodeConfigError(
            f"service_node.json is not valid JSON: {exc.msg} "
            f"(line {exc.lineno}, column {exc.colno})"
        ) from exc

    if not isinstance(data, dict):
        raise ServiceNodeConfigError(
            f"service_node.json must contain a JSON object, "
            f"got {type(data).__name__}"
        )

    # Use .get() with defaults so a partially-written file upgrades
    # cleanly — fields added in future versions fall through to the
    # dataclass defaults instead of raising.
    defaults = ServiceNodeConfig.defaults()
    cfg = ServiceNodeConfig(
        max_cpu_percent=data.get("max_cpu_percent", defaults.max_cpu_percent),
        max_bandwidth_mbps=data.get(
            "max_bandwidth_mbps", defaults.max_bandwidth_mbps
        ),
        max_storage_gb=data.get("max_storage_gb", defaults.max_storage_gb),
        tunnel_anchor_enabled=data.get(
            "tunnel_anchor_enabled", defaults.tunnel_anchor_enabled
        ),
        node_role=data.get("node_role", defaults.node_role),
    )
    cfg.validate()
    return cfg


def save_config(cfg: ServiceNodeConfig) -> ServiceNodeConfig:
    """Atomically persist ``cfg`` to ``service_node.json``.

    Validates first, writes to a sibling tempfile under the same dir,
    fsyncs, then ``os.replace`` swaps it into place. If any step fails
    the original file is left untouched.

    Returns the validated config so callers can one-line the save +
    response payload pattern: ``return save_config(cfg)``.
    """
    cfg.validate()
    path = _resolve_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    body = json.dumps(asdict(cfg), indent=2, sort_keys=True) + "\n"

    # NamedTemporaryFile with delete=False so we control the lifecycle
    # across the fsync + replace sequence. Placing the tempfile in the
    # same directory as the target is critical — os.replace() is atomic
    # only within a single filesystem, so a cross-fs tempfile would
    # silently fall back to copy-and-unlink.
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{SERVICE_NODE_FILE_NAME}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_name, path)
    except Exception:
        # Best-effort tempfile cleanup on any failure so we don't leave
        # orphans sitting in the data dir.
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    logger.info(
        "service_node_config: saved (role=%s, anchor=%s, cpu=%d%%, "
        "bw=%dMbps, storage=%dGB)",
        cfg.node_role,
        cfg.tunnel_anchor_enabled,
        cfg.max_cpu_percent,
        cfg.max_bandwidth_mbps,
        cfg.max_storage_gb,
    )
    return cfg


def public_view() -> ServiceNodePublicView:
    """Return the :class:`ServiceNodePublicView` for discovery endpoints.

    Calls :func:`load_config` and projects down to the safe subset.
    If loading raises, returns defaults rather than propagating — the
    well-known document must always respond, even if the admin saved a
    bad config that we then catch on the next load.
    """
    try:
        cfg = load_config()
    except ServiceNodeConfigError as exc:
        logger.warning(
            "service_node_config: load failed for public view (%s) — "
            "falling back to defaults",
            exc,
        )
        cfg = ServiceNodeConfig.defaults()
    return ServiceNodePublicView(
        node_role=cfg.node_role,
        tunnel_anchor_enabled=cfg.tunnel_anchor_enabled,
    )
