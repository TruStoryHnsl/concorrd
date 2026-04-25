"""Admin endpoints for the extension catalog + install flow.

Three pieces cooperate:

  1. Remote catalog: a JSON index hosted under concord-extensions that
     lists every available extension with its bundle_url (zip). Default
     URL is the main-branch raw file; operators who fork the library
     override via ``CONCORD_EXTENSION_CATALOG_URL``.

  2. Installed registry: ``installed_extensions.json`` on the data
     volume. This replaces the legacy ``server/extensions.json`` (which
     lived inside the code bundle and couldn't persist across image
     rebuilds). Each entry is the shape the existing
     ``routers/extensions.py`` consumes: id, name, url, icon, description,
     enabled.

  3. On-disk bundles: ``<DATA_DIR>/extensions/<extension_id>/`` holds
     the extracted Vite output (index.html + assets/). Serving is
     delegated to the public ``/ext/<id>/<path>`` endpoint further
     down so iframes resolve their relative ``./assets/`` requests
     without a round-trip through Caddy.

Only instance admins (per ``require_admin``) can mutate state. The
endpoints are deliberately narrow: no arbitrary URL installs, no
arbitrary file writes — the bundle_url must come out of the catalog,
and the extracted path is clamped under the extensions data dir.
"""

from __future__ import annotations

import io
import json
import logging
import os
import shutil
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import DATA_DIR
from routers.admin import require_admin
from routers.servers import get_user_id
from routers import extensions as extensions_router

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/extensions", tags=["admin-extensions"])

# ---------------------------------------------------------------------------
# Paths + constants
# ---------------------------------------------------------------------------

DEFAULT_CATALOG_URL = (
    "https://raw.githubusercontent.com/TruStoryHnsl/"
    "concord-extensions/main/catalog.json"
)

# Headers that bypass intermediate HTTP caches (raw.githubusercontent.com
# is fronted by Fastly with a 5-minute TTL). Without these the install
# pipeline can fetch a stale catalog after a version bump and ask for a
# bundle_url that no longer exists, surfacing as "Could not download
# bundle: 404" with the OLD version in the URL.
_CATALOG_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, max-age=0",
    "Pragma": "no-cache",
}


def _catalog_url() -> str:
    return os.getenv("CONCORD_EXTENSION_CATALOG_URL", DEFAULT_CATALOG_URL)


def _catalog_fetch_url() -> str:
    """Catalog URL with a per-request cache-buster query param. Combined
    with `_CATALOG_NO_CACHE_HEADERS`, this guarantees the install path
    never hits a cached catalog response — Fastly varies on URL, so the
    nonce forces a fresh origin fetch."""
    base = _catalog_url()
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}_t={int(time.time() * 1000)}"


def _extensions_root() -> Path:
    """Root directory under which each extension's bundle lives at
    ``<root>/<extension_id>/``. Created on demand.
    """
    root = DATA_DIR / "extensions"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _registry_path() -> Path:
    """Persistent list of installed extensions. Lives on the data
    volume rather than inside the code bundle so image rebuilds don't
    wipe the admin's install choices.
    """
    return DATA_DIR / "installed_extensions.json"


def _read_registry() -> list[dict[str, Any]]:
    p = _registry_path()
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text())
        return raw if isinstance(raw, list) else []
    except Exception:
        logger.exception("Failed to parse %s", p)
        return []


def _write_registry(entries: list[dict[str, Any]]) -> None:
    # Atomic write via tmp-file-then-rename so concurrent readers don't
    # observe a truncated file.
    p = _registry_path()
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, indent=2))
    os.replace(tmp, p)


def _sanitize_id(extension_id: str) -> str:
    """Reject anything that would let an attacker escape the data dir.

    Valid ids are the ones the concord-extensions catalog actually
    emits: reverse-DNS ASCII with dots/dashes/underscores. No slashes,
    no traversal dots, no absolute paths.
    """
    if not extension_id:
        raise HTTPException(400, "Missing extension_id")
    if any(ch in extension_id for ch in ("/", "\\", "\x00")):
        raise HTTPException(400, "Invalid extension_id")
    if extension_id in ("", ".", "..") or extension_id.startswith("."):
        raise HTTPException(400, "Invalid extension_id")
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789.-_")
    if not set(extension_id.lower()).issubset(allowed):
        raise HTTPException(400, "Invalid extension_id")
    return extension_id


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


@router.get("/catalog")
async def admin_get_catalog(user_id: str = Depends(get_user_id)) -> dict[str, Any]:
    """Fetch the remote extension catalog and return it verbatim alongside
    the set of already-installed extension ids, so the UI can render
    Install vs Installed without a second round-trip.
    """
    require_admin(user_id)
    url = _catalog_url()
    fetch_url = _catalog_fetch_url()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(fetch_url, headers=_CATALOG_NO_CACHE_HEADERS)
            resp.raise_for_status()
            catalog = resp.json()
    except httpx.HTTPError as exc:
        logger.warning("Catalog fetch failed from %s: %s", fetch_url, exc)
        raise HTTPException(502, f"Could not fetch catalog: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(502, f"Catalog is not valid JSON: {exc}") from exc

    registry = _read_registry()
    installed_ids = {e.get("id") for e in registry if e.get("id")}
    # Surface the installed version per-id so the UI can show "Update"
    # when catalog.version != installed_versions[id]. Missing/unknown
    # versions in the registry (legacy installs predating the version
    # field) come through as empty strings, which the UI treats as
    # "version unknown — offer to update unconditionally".
    installed_versions = {
        e.get("id"): e.get("version") or ""
        for e in registry
        if isinstance(e.get("id"), str)
    }
    return {
        "catalog_url": url,
        "catalog": catalog,
        "installed_ids": sorted(i for i in installed_ids if isinstance(i, str)),
        "installed_versions": installed_versions,
    }


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


class InstallRequest(BaseModel):
    extension_id: str


@router.post("/install")
async def admin_install_extension(
    body: InstallRequest,
    user_id: str = Depends(get_user_id),
) -> dict[str, Any]:
    """Install an extension by id. The bundle_url is read FROM THE
    CATALOG, never from the client, so an authenticated admin can't
    point concord at an arbitrary zip they typed in.
    """
    require_admin(user_id)
    ext_id = _sanitize_id(body.extension_id)

    # Look up bundle_url in the catalog. Cache-bust the fetch so a stale
    # CDN response can't point install at a deleted bundle version.
    fetch_url = _catalog_fetch_url()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(fetch_url, headers=_CATALOG_NO_CACHE_HEADERS)
            resp.raise_for_status()
            catalog = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, f"Could not fetch catalog: {exc}") from exc

    entries = catalog.get("extensions") or []
    match = next((e for e in entries if e.get("id") == ext_id), None)
    if not match:
        raise HTTPException(404, f"Extension {ext_id} not listed in catalog")

    bundle_url = match.get("bundle_url")
    if not bundle_url:
        raise HTTPException(400, f"Catalog entry for {ext_id} has no bundle_url")

    # Download the zip. Cap size so a runaway catalog can't fill the disk.
    max_bytes = 50 * 1024 * 1024
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(bundle_url)
            resp.raise_for_status()
            data = resp.content
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Could not download bundle: {exc}") from exc

    if len(data) > max_bytes:
        raise HTTPException(400, "Bundle exceeds size limit")

    # Extract into data/extensions/<id>/, clobbering any prior install.
    # Paths inside the zip are validated so a hostile archive can't
    # write outside the extension's own directory via ../ traversal.
    dest = _extensions_root() / ext_id
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    dest_resolved = dest.resolve()

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                target = (dest / info.filename).resolve()
                if dest_resolved not in target.parents and target != dest_resolved:
                    raise HTTPException(
                        400,
                        f"Bundle contains unsafe path: {info.filename!r}",
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
    except zipfile.BadZipFile as exc:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(400, f"Bundle is not a valid zip: {exc}") from exc

    # Locate the entry html. Catalog manifest says "entry": "index.html"
    # but be defensive in case a future package ships something else.
    entry = match.get("entry") or "index.html"
    if not (dest / entry).exists():
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(
            400,
            f"Bundle is missing its entry file {entry!r}",
        )

    # Register in installed_extensions.json so /api/extensions and the
    # sidebar picker surface it. url is the path the client iframes.
    registry = _read_registry()
    registry = [e for e in registry if e.get("id") != ext_id]
    registry.append(
        {
            "id": ext_id,
            "name": match.get("name") or ext_id,
            "url": f"/ext/{ext_id}/",
            "icon": "extension",
            "description": match.get("description") or "",
            "version": match.get("version") or "",
            "enabled": True,
        }
    )
    _write_registry(registry)
    extensions_router.init_catalog()
    logger.info("admin_install_extension: installed %s by %s", ext_id, user_id)
    return {"status": "installed", "extension_id": ext_id}


# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------


@router.delete("/{extension_id}", status_code=204)
async def admin_uninstall_extension(
    extension_id: str,
    user_id: str = Depends(get_user_id),
) -> None:
    require_admin(user_id)
    ext_id = _sanitize_id(extension_id)

    dest = _extensions_root() / ext_id
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)

    registry = [e for e in _read_registry() if e.get("id") != ext_id]
    _write_registry(registry)
    extensions_router.init_catalog()
    logger.info("admin_uninstall_extension: removed %s by %s", ext_id, user_id)


# ---------------------------------------------------------------------------
# Public static serving for installed extension bundles
# ---------------------------------------------------------------------------
#
# The concord-extensions build output references assets relatively
# (``./assets/foo.js``), so an iframe loaded at ``/ext/<id>/`` will
# resolve subresources to ``/ext/<id>/assets/foo.js`` — exactly what
# this handler serves. Keeping the static-serve in-process (rather
# than via Caddy) means the admin install flow is completely self-
# contained: no host config edits required.

public_router = APIRouter(tags=["extensions-static"])

import mimetypes

_SAFE_MIMES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
    ".map": "application/json",
}


def _mimetype_for(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _SAFE_MIMES:
        return _SAFE_MIMES[ext]
    guess, _ = mimetypes.guess_type(path.name)
    return guess or "application/octet-stream"


@public_router.get("/ext/{extension_id}/")
async def serve_extension_index(extension_id: str):
    return await _serve_extension_file(extension_id, "index.html")


@public_router.get("/ext/{extension_id}/{subpath:path}")
async def serve_extension_path(extension_id: str, subpath: str):
    return await _serve_extension_file(extension_id, subpath or "index.html")


async def _serve_extension_file(extension_id: str, subpath: str):
    from fastapi.responses import FileResponse

    ext_id = _sanitize_id(extension_id)
    root = (_extensions_root() / ext_id).resolve()
    if not root.exists():
        raise HTTPException(404, "Extension not installed")

    # Clamp the resolved path under the extension's own directory so a
    # request like /ext/foo/../../etc/passwd falls back to 404 rather
    # than succeeding.
    target = (root / subpath).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(404, "Not found")
    if not target.is_file():
        raise HTTPException(404, "Not found")

    return FileResponse(target, media_type=_mimetype_for(target))
