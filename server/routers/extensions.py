"""Server-side extension registry.

Extensions are defined in EXTENSIONS_CONFIG (a JSON file path, defaulting to
extensions.json next to main.py). Any authenticated user can list them;
the catalog is the same for everyone. Admin users can reload the config
at runtime via POST /api/extensions/reload.

Each extension entry:
  id          — unique slug (e.g. "worldview")
  name        — display name
  url         — URL the client embeds in an iframe
  icon        — Material Symbols icon name
  description — one-liner shown in the menu
  enabled     — false to hide without removing the entry
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import DATA_DIR
from routers.servers import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/extensions", tags=["extensions"])

# ── Config ──────────────────────────────────────────────────────
# The registry is persisted on the data volume (installed_extensions.json)
# so the admin install flow survives image rebuilds. The legacy
# server/extensions.json (inside the code bundle) is honoured as a
# fallback only if the data-volume file is missing, which keeps
# fresh-install deployments that haven't hit the install flow yet
# behaving the same as before — with one key difference: the shipped
# file is now empty ([]), so the fallback returns no extensions.

_DATA_CONFIG = DATA_DIR / "installed_extensions.json"
_BUNDLED_CONFIG = Path(__file__).resolve().parent.parent / "extensions.json"


def _resolve_config_path() -> Path:
    """Prefer the data-volume registry when it exists; otherwise use
    the bundled fallback. Resolved at every read so an install flow
    that creates the data file at runtime is picked up without a
    process restart.
    """
    override = os.getenv("EXTENSIONS_CONFIG")
    if override:
        return Path(override)
    if _DATA_CONFIG.exists():
        return _DATA_CONFIG
    return _BUNDLED_CONFIG


class ExtensionDef(BaseModel):
    id: str
    name: str
    url: str
    icon: str = "extension"
    description: str = ""
    enabled: bool = True


_catalog: list[ExtensionDef] = []


def _load_catalog() -> list[ExtensionDef]:
    """Read and parse the extensions config file."""
    if not _resolve_config_path().exists():
        logger.info("No extensions config at %s — catalog empty", _resolve_config_path())
        return []
    try:
        raw = json.loads(_resolve_config_path().read_text())
        if isinstance(raw, list):
            return [ExtensionDef(**entry) for entry in raw]
        logger.warning("extensions.json is not a JSON array")
        return []
    except Exception:
        logger.exception("Failed to parse %s", _resolve_config_path())
        return []


def init_catalog() -> None:
    """Load the catalog on startup. Called from main.py lifespan."""
    global _catalog
    _catalog = _load_catalog()
    logger.info("Loaded %d extension(s)", len(_catalog))


# ── Endpoints ───────────────────────────────────────────────────


class ExtensionOut(BaseModel):
    id: str
    name: str
    url: str
    icon: str
    description: str


@router.get("", response_model=list[ExtensionOut])
async def list_extensions(
    _user_id: str = Depends(get_user_id),
) -> list[ExtensionOut]:
    """Return enabled extensions available to any authenticated user."""
    return [
        ExtensionOut(
            id=ext.id,
            name=ext.name,
            url=ext.url,
            icon=ext.icon,
            description=ext.description,
        )
        for ext in _catalog
        if ext.enabled
    ]


@router.post("/reload", status_code=204)
async def reload_extensions(
    user_id: str = Depends(get_user_id),
) -> None:
    """Reload the extensions catalog from disk. Admin only."""
    # Lightweight admin check — reuses the ADMIN_USER_IDS env var
    admin_ids = {
        uid.strip()
        for uid in os.getenv("ADMIN_USER_IDS", "").split(",")
        if uid.strip()
    }
    if user_id not in admin_ids:
        raise HTTPException(403, "Admin access required")
    init_catalog()
