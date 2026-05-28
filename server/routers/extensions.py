"""Server-side extension registry + runtime install pipeline (INS-066).

The legacy static catalog (``installed_extensions.json``) is preserved as
a backward-compatible fallback so pre-INS-066 deployments keep working.
New installs go through ``POST /api/extensions/install``, which:

  1. Fetches the .zip from a remote URL (or `file://` local path).
  2. Validates the embedded manifest.json (id, version, entry,
     permissions — see ALLOWED_PERMISSIONS below).
  3. Unpacks the archive to ``EXTENSIONS_DIR / {id} /`` (path-traversal
     hardened).
  4. Inserts/updates the ``Extension`` DB row.
  5. Mounts a ``StaticFiles`` route at ``/ext/{id}/`` so the bundle is
     served without a process restart.

``DELETE /api/extensions/{id}`` reverses all of the above.

``GET /api/extensions`` merges installed-from-DB rows with the static
catalog. DB rows are authoritative on collision.

Permissions registry (INS-066 W7) — every permission an installed
extension declares MUST be in ``ALLOWED_PERMISSIONS``. Unknown
permissions reject the install with HTTP 422 and the offending name in
the body. No silent permission inflation: install-time is the only place
that gets to decide what an extension can do, and it must be explicit.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import DATA_DIR, EXTENSIONS_DIR
from database import get_db
from models import Extension
from dependencies import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/extensions", tags=["extensions"])

# ── Permissions registry (W7) ────────────────────────────────────
# All permissions an installed extension may declare. Manifests
# requesting permissions outside this set are rejected at install time.
# Every entry MUST be documented in docs/extensions/permissions.md.
ALLOWED_PERMISSIONS: frozenset[str] = frozenset(
    {
        "state_events",      # read+send Matrix room state for the session room
        "matrix.read",       # read-only Matrix room events (subset of state_events)
        "matrix.send",       # send-only Matrix events (subset of state_events)
        "fetch:external",    # use /api/ext-proxy/<id>/* to reach upstream APIs
        "soundboard.play",   # trigger soundboard clips on the server
        "media.read",        # read shared media on the server
    }
)


def is_extension_directory_safe(target: Path, base: Path) -> bool:
    """Return True iff ``target`` resolves inside ``base``.

    Blocks zip-slip / path-traversal: a malicious archive that contains
    entries like ``../../../etc/passwd`` would resolve outside ``base``
    and we refuse to write it.
    """
    try:
        base_real = base.resolve(strict=False)
        target_real = target.resolve(strict=False)
    except OSError:
        return False
    try:
        target_real.relative_to(base_real)
        return True
    except ValueError:
        return False


# ── Config ──────────────────────────────────────────────────────
# Static fallback catalog — preserved so pre-INS-066 deployments that
# never run the install flow still see their old extensions.

_DATA_CONFIG = DATA_DIR / "installed_extensions.json"
_BUNDLED_CONFIG = Path(__file__).resolve().parent.parent / "extensions.json"


def _resolve_config_path() -> Path:
    override = os.getenv("EXTENSIONS_CONFIG")
    if override:
        return Path(override)
    if _DATA_CONFIG.exists():
        return _DATA_CONFIG
    return _BUNDLED_CONFIG


class ExtensionDef(BaseModel):
    """Static catalog entry shape (legacy)."""
    id: str
    name: str
    url: str
    icon: str = "extension"
    description: str = ""
    enabled: bool = True


_catalog: list[ExtensionDef] = []


def _load_catalog() -> list[ExtensionDef]:
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
    global _catalog
    _catalog = _load_catalog()
    logger.info("Loaded %d static extension(s)", len(_catalog))


# ── Static-catalog → DB migration (INS-066-FUP-C) ───────────────
#
# Pre-INS-066 deployments registered extensions via the static JSON
# catalog (server/extensions.json or <DATA_DIR>/installed_extensions.json).
# Those entries have NO DB row, so the W7 fetch:external permission gate
# in ext_proxy short-circuits to "deny" (defensive default) but uniformity
# matters for two reasons:
#
#   1. Operators expect ``GET /api/extensions`` to surface a `permissions`
#      array for every extension, not silently empty for legacy ones.
#   2. The ext_proxy gate checks for the row first; an absent row reads
#      identically to "extension uninstalled" and returns 404, not 403.
#      That's the wrong error code for a still-active legacy extension.
#
# The fix is a one-shot, idempotent on-boot migration: for each static
# entry without a DB row, create a synthetic row with permissions=[].
# Legacy extensions therefore get the most-restrictive policy by default
# — admins must explicitly re-install via POST /api/extensions/install
# to grant `fetch:external` or any other permission. No silent permission
# inflation (W7 invariant preserved).


async def migrate_static_catalog(db: AsyncSession) -> int:
    """Create synthetic DB rows for any static-catalog entry without one.

    Idempotent: rows already in the ``extensions`` table are NEVER
    touched (their permissions/manifest are preserved verbatim). Legacy
    entries are inserted with an empty ``permissions`` list — this is
    the safe default because the static catalog has no permissions
    schema, and W7 (INS-066) prohibits silent permission inflation.

    Returns the number of rows inserted. Logs the count.
    """
    if not _catalog:
        return 0

    # Pull the existing DB ids in one query so we don't N+1 the catalog.
    existing = await db.execute(select(Extension.id))
    existing_ids = {row for (row,) in existing.all()}

    inserted = 0
    now = datetime.now(timezone.utc)
    for entry in _catalog:
        if entry.id in existing_ids:
            continue
        # Derive the entry html from the static `url` field. The static
        # shape is ``/ext/{id}/index.html`` or just ``/ext/{id}/``; we
        # strip the prefix so the DB-side manifest looks like a normal
        # runtime-installed manifest.
        entry_path = "index.html"
        prefix = f"/ext/{entry.id}/"
        if entry.url.startswith(prefix):
            tail = entry.url[len(prefix):].strip()
            entry_path = tail or "index.html"

        synthesized: dict[str, Any] = {
            "id": entry.id,
            "version": "0.0.0",  # static catalog had no version field
            "entry": entry_path,
            "permissions": [],   # legacy → no permissions; re-install to grant
            "name": entry.name,
            "description": entry.description,
            "icon": entry.icon,
            "pricing": "free",
        }
        row = Extension(
            id=entry.id,
            version=synthesized["version"],
            pricing=synthesized["pricing"],
            enabled=True,
            cached_at=now,
            remote_url=None,
            manifest=json.dumps(synthesized),
        )
        db.add(row)
        inserted += 1

    if inserted:
        await db.commit()
        logger.info(
            "migrate_static_catalog: inserted %d synthetic DB row(s) for legacy "
            "static-catalog entries (permissions=[])",
            inserted,
        )
    return inserted


# ── Install pipeline (W2) ───────────────────────────────────────


def _is_valid_extension_id(ext_id: str) -> bool:
    """Reverse-domain ids only. Reject anything that could escape a path
    or smuggle special characters."""
    if not ext_id:
        return False
    if len(ext_id) > 200:
        return False
    if any(c in ext_id for c in ("/", "\\", "\x00")):
        return False
    if ".." in ext_id:
        return False
    parts = ext_id.split(".")
    if len(parts) < 2:
        return False
    for p in parts:
        if not p:
            return False
        if not all(c.isalnum() or c == "-" for c in p):
            return False
    return True


def _validate_manifest(manifest: Any) -> dict[str, Any]:
    """Validate a parsed manifest dict. Returns the canonicalised
    manifest or raises HTTPException(422). Permission validation rejects
    any unknown permission with 422 and lists the offending name(s)."""
    if not isinstance(manifest, dict):
        raise HTTPException(422, "manifest is not an object")
    required = ("id", "version", "entry")
    missing = [k for k in required if k not in manifest]
    if missing:
        raise HTTPException(422, f"manifest missing required keys: {missing}")
    ext_id = manifest["id"]
    if not isinstance(ext_id, str) or not _is_valid_extension_id(ext_id):
        raise HTTPException(422, f"invalid extension id: {ext_id!r}")
    if not isinstance(manifest["version"], str) or not manifest["version"]:
        raise HTTPException(422, "manifest.version must be a non-empty string")
    entry = manifest["entry"]
    if not isinstance(entry, str) or not entry or entry.startswith("/"):
        raise HTTPException(422, f"manifest.entry must be a relative path, got {entry!r}")
    perms = manifest.get("permissions", [])
    if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
        raise HTTPException(422, "manifest.permissions must be a list of strings")
    unknown = [p for p in perms if p not in ALLOWED_PERMISSIONS]
    if unknown:
        # W7: hard-reject. Operator must explicitly extend
        # ALLOWED_PERMISSIONS to admit a new permission. No silent inflation.
        raise HTTPException(
            status_code=422,
            detail={
                "error": "unknown_permissions",
                "permissions": unknown,
                "allowed": sorted(ALLOWED_PERMISSIONS),
            },
        )
    pricing = manifest.get("pricing", "free")
    if not isinstance(pricing, str):
        raise HTTPException(422, "manifest.pricing must be a string")
    return {**manifest, "permissions": perms, "pricing": pricing}


async def _fetch_zip_bytes(remote_url: str) -> bytes:
    """Fetch the bundle as bytes. Supports http(s):// and file://."""
    parsed_url = remote_url.strip()
    if parsed_url.startswith("file://"):
        local = Path(parsed_url[len("file://") :])
        if not local.is_file():
            raise HTTPException(400, f"file not found: {local}")
        return local.read_bytes()
    if not parsed_url.startswith(("http://", "https://")):
        raise HTTPException(400, "remote_url must be http(s):// or file://")
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        try:
            r = await client.get(parsed_url)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"fetch failed: {e}")
    if r.status_code != 200:
        raise HTTPException(502, f"fetch returned {r.status_code}")
    return r.content


def _unpack_zip(zip_bytes: bytes, target_dir: Path) -> dict[str, Any]:
    """Unpack the bundle into ``target_dir`` and return its manifest.

    Path-traversal hardened: each entry must resolve inside
    ``target_dir`` (zip-slip protection). Refuses absolute paths and
    parent-directory escapes.
    """
    import io

    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=False)

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for member in zf.infolist():
                name = member.filename
                if not name:
                    continue
                if name.startswith("/") or name.startswith("\\"):
                    raise HTTPException(400, f"absolute path in zip: {name!r}")
                if ".." in Path(name).parts:
                    raise HTTPException(400, f"traversal in zip: {name!r}")
                dest = target_dir / name
                if not is_extension_directory_safe(dest, target_dir):
                    raise HTTPException(400, f"unsafe zip entry: {name!r}")
                if member.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
    except zipfile.BadZipFile:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(400, "not a valid zip archive")

    manifest_path = target_dir / "manifest.json"
    if not manifest_path.is_file():
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(422, "zip is missing manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(422, f"manifest.json is not valid JSON: {e}")
    return manifest


# ── Static-mount registry (W3) ──────────────────────────────────
#
# Each installed extension is mounted at ``/ext/{id}/`` via a
# FastAPI StaticFiles instance. We track mounted ids so re-installing
# the same id replaces the mount, and uninstall removes it.

_app_ref: FastAPI | None = None
_mounted_ids: set[str] = set()


def _ext_path_for(ext_id: str) -> Path:
    """The on-disk path for an extension. NOT safe to call with
    untrusted ``ext_id`` — call ``_is_valid_extension_id`` first."""
    return EXTENSIONS_DIR / ext_id


def mount_installed(app: FastAPI) -> None:
    """Wire up StaticFiles mounts for every directory under
    ``EXTENSIONS_DIR``. Called once at startup from ``main.lifespan``.

    Stores the FastAPI instance so subsequent ``register_mount`` /
    ``unregister_mount`` calls (from install / uninstall) can attach
    new routes without a restart.
    """
    global _app_ref
    _app_ref = app
    if not EXTENSIONS_DIR.exists():
        return
    for child in EXTENSIONS_DIR.iterdir():
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue  # staging / hidden
        if not _is_valid_extension_id(child.name):
            logger.warning("skipping extension dir with unsafe id: %r", child.name)
            continue
        _do_mount(app, child.name, child)


def _do_mount(app: FastAPI, ext_id: str, target: Path) -> None:
    if ext_id in _mounted_ids:
        return
    if not is_extension_directory_safe(target, EXTENSIONS_DIR):
        logger.warning("refusing to mount unsafe extension path: %s", target)
        return
    app.mount(
        f"/ext/{ext_id}",
        StaticFiles(directory=str(target), html=True),
        name=f"ext-{ext_id}",
    )
    _mounted_ids.add(ext_id)
    logger.info("mounted /ext/%s -> %s", ext_id, target)


def register_mount(ext_id: str) -> None:
    """Mount a freshly-installed extension's StaticFiles route at
    runtime. Used by the install endpoint after unpacking.
    """
    if _app_ref is None:
        logger.warning("register_mount(%s) called before mount_installed", ext_id)
        return
    if ext_id in _mounted_ids:
        # A re-install replaces files in place — Starlette's StaticFiles
        # reads from disk on each request so the existing mount picks
        # up new files automatically. No re-mount needed.
        return
    target = _ext_path_for(ext_id)
    if not target.is_dir():
        return
    _do_mount(_app_ref, ext_id, target)


def unregister_mount(ext_id: str) -> None:
    """Best-effort removal of the StaticFiles route on uninstall.

    FastAPI/Starlette's Mount is a top-level route in
    ``app.router.routes``; we filter it out by ``path``. Idempotent —
    calling for an unknown id is a no-op.
    """
    if _app_ref is None:
        _mounted_ids.discard(ext_id)
        return
    if ext_id not in _mounted_ids:
        return
    prefix = f"/ext/{ext_id}"
    _app_ref.router.routes = [
        r
        for r in _app_ref.router.routes
        if getattr(r, "path", None) != prefix
    ]
    _mounted_ids.discard(ext_id)
    logger.info("unmounted /ext/%s", ext_id)


# ── Endpoints ───────────────────────────────────────────────────


class ExtensionOut(BaseModel):
    id: str
    name: str
    url: str
    icon: str
    description: str
    # INS-066-FUP-A: surface manifest permissions to the client so the
    # ExtensionSurfaceManager can gate concord:state_event delivery and
    # extension:send_state_event acceptance. Always present (empty list
    # for legacy static-catalog rows that have no manifest).
    permissions: list[str] = []


class InstalledExtensionOut(BaseModel):
    """Full shape of an installed (DB-backed) extension."""
    id: str
    version: str
    pricing: str
    enabled: bool
    cached_at: datetime
    remote_url: str | None
    manifest: dict[str, Any]


def _admin_required(user_id: str) -> None:
    admin_ids = {
        uid.strip()
        for uid in os.getenv("ADMIN_USER_IDS", "").split(",")
        if uid.strip()
    }
    if user_id not in admin_ids:
        raise HTTPException(403, "Admin access required")


def _extension_to_listing(row: Extension) -> ExtensionOut:
    """Coerce a DB row into the legacy listing shape so existing clients
    keep working. ``url`` defaults to ``/ext/{id}/`` + manifest.entry."""
    try:
        manifest = json.loads(row.manifest)
    except Exception:
        manifest = {}
    entry = manifest.get("entry", "index.html")
    raw_perms = manifest.get("permissions") or []
    perms = [p for p in raw_perms if isinstance(p, str)]
    return ExtensionOut(
        id=row.id,
        name=manifest.get("name", row.id),
        url=f"/ext/{row.id}/{entry}",
        icon=manifest.get("icon", "extension"),
        description=manifest.get("description", ""),
        permissions=perms,
    )


@router.get("", response_model=list[ExtensionOut])
async def list_extensions(
    _user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> list[ExtensionOut]:
    """Return all visible extensions: DB-backed installs merged with
    the legacy static catalog. DB rows win on id collision."""
    result = await db.execute(select(Extension).where(Extension.enabled.is_(True)))
    db_rows = list(result.scalars().all())
    db_ids = {r.id for r in db_rows}
    out: list[ExtensionOut] = [_extension_to_listing(r) for r in db_rows]
    for ext in _catalog:
        if not ext.enabled or ext.id in db_ids:
            continue
        out.append(
            ExtensionOut(
                id=ext.id,
                name=ext.name,
                url=ext.url,
                icon=ext.icon,
                description=ext.description,
            )
        )
    return out


class InstallRequest(BaseModel):
    remote_url: str


@router.post("/install", status_code=201, response_model=InstalledExtensionOut)
async def install_extension(
    body: InstallRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> InstalledExtensionOut:
    """Fetch, validate, unpack, and register an extension."""
    _admin_required(user_id)

    zip_bytes = await _fetch_zip_bytes(body.remote_url)

    # Use a temp staging directory so manifest validation runs before
    # we commit to a final extension id (read from the manifest itself).
    staging = EXTENSIONS_DIR / f".staging-{datetime.now(timezone.utc).timestamp():.0f}"
    if staging.exists():
        shutil.rmtree(staging)
    raw_manifest = _unpack_zip(zip_bytes, staging)
    try:
        validated = _validate_manifest(raw_manifest)
    except HTTPException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    ext_id = validated["id"]
    final_dir = _ext_path_for(ext_id)
    if not is_extension_directory_safe(final_dir, EXTENSIONS_DIR):
        shutil.rmtree(staging, ignore_errors=True)
        raise HTTPException(400, "resolved extension path escapes EXTENSIONS_DIR")

    # Replace existing install (idempotent re-install).
    if final_dir.exists():
        shutil.rmtree(final_dir)
    staging.rename(final_dir)

    # Persist the row.
    existing = await db.get(Extension, ext_id)
    now = datetime.now(timezone.utc)
    if existing is None:
        row = Extension(
            id=ext_id,
            version=validated["version"],
            pricing=validated.get("pricing", "free"),
            enabled=True,
            cached_at=now,
            remote_url=body.remote_url,
            manifest=json.dumps(validated),
        )
        db.add(row)
    else:
        existing.version = validated["version"]
        existing.pricing = validated.get("pricing", "free")
        existing.cached_at = now
        existing.remote_url = body.remote_url
        existing.manifest = json.dumps(validated)
        row = existing
    await db.commit()
    await db.refresh(row)

    register_mount(ext_id)

    return InstalledExtensionOut(
        id=row.id,
        version=row.version,
        pricing=row.pricing,
        enabled=row.enabled,
        cached_at=row.cached_at,
        remote_url=row.remote_url,
        manifest=validated,
    )


@router.delete("/{ext_id}", status_code=204)
async def uninstall_extension(
    ext_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> None:
    _admin_required(user_id)
    if not _is_valid_extension_id(ext_id):
        raise HTTPException(400, "invalid extension id")
    row = await db.get(Extension, ext_id)
    if row is None:
        raise HTTPException(404, "extension not installed")

    target = _ext_path_for(ext_id)
    if target.exists() and is_extension_directory_safe(target, EXTENSIONS_DIR):
        shutil.rmtree(target, ignore_errors=True)
    unregister_mount(ext_id)
    await db.delete(row)
    await db.commit()


# ── Manifest lookup helper for downstream routers (W7) ──────────


async def get_extension_manifest(ext_id: str, db: AsyncSession) -> dict[str, Any] | None:
    """Return the validated manifest dict for an installed extension,
    or None if not installed. Used by ext_proxy to enforce the
    fetch:external permission.
    """
    if not _is_valid_extension_id(ext_id):
        return None
    row = await db.get(Extension, ext_id)
    if row is None:
        return None
    try:
        return json.loads(row.manifest)
    except Exception:
        return None


def manifest_has_permission(manifest: dict[str, Any], perm: str) -> bool:
    perms = manifest.get("permissions") or []
    return isinstance(perms, list) and perm in perms


# ── Reload (legacy) ─────────────────────────────────────────────


@router.post("/reload", status_code=204)
async def reload_extensions(
    user_id: str = Depends(get_user_id),
) -> None:
    _admin_required(user_id)
    init_catalog()
