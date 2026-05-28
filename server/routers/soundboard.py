import asyncio
import mimetypes
import secrets
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import SOUNDBOARD_DIR, FREESOUND_API_KEY, ADMIN_USER_IDS
from database import get_db
from dependencies import require_server_member
from models import SoundboardClip, Server
from dependencies import get_user_id

router = APIRouter(prefix="/api/soundboard", tags=["soundboard"])

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".ogg", ".webm", ".m4a"}
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB

# Magic bytes for validating audio file types
MAGIC_BYTES = {
    ".mp3": [b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"ID3"],
    ".wav": [b"RIFF"],
    ".ogg": [b"OggS"],
    ".webm": [b"\x1a\x45\xdf\xa3"],
    ".m4a": [b"\x00\x00\x00"],  # ftyp box (offset varies, checked loosely)
}


class ClipOut(BaseModel):
    id: int
    name: str = Field(min_length=1, max_length=100)
    server_id: str  # originating/attribution server (instance-wide visibility)
    uploaded_by: str
    duration: float | None
    keybind: str | None = None
    url: str
    # INS-073: Freesound attribution surfaces in the listing so the UI can
    # display "via freesound.org · CC0 · by <author>" next to the clip.
    source: str | None = None
    license: str | None = None
    license_url: str | None = None
    attribution: str | None = None

    model_config = {"from_attributes": True}


def _clip_to_out(clip: SoundboardClip) -> "ClipOut":
    return ClipOut(
        id=clip.id,
        name=clip.name,
        server_id=clip.server_id,
        uploaded_by=clip.uploaded_by,
        duration=clip.duration,
        keybind=clip.keybind,
        url=f"/api/soundboard/file/{clip.id}",
        source=clip.source,
        license=clip.license,
        license_url=clip.license_url,
        attribution=clip.attribution,
    )


# IMPORTANT: /file/{clip_id} must be declared BEFORE /{server_id}
# because FastAPI uses first-match routing — otherwise "file" is
# captured as a server_id and this endpoint becomes unreachable.
@router.get("/file/{clip_id}")
async def serve_clip(
    clip_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Serve a soundboard clip file.

    INS-073: clips are instance-wide — any authenticated user with access
    to *any* server on the instance can fetch the file. We verify the user
    is a member of at least the originating server (cheap proxy for
    "user is on this instance"). This deliberately drops the previous
    per-server gate so users see the full library no matter which server
    they're currently viewing.
    """
    clip = await db.get(SoundboardClip, clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found")

    # Membership in the originating server is sufficient. Users joined to
    # any server on the instance can access the instance-wide library; the
    # originating-server check is the cheapest existence proof we have
    # without introducing a new "instance member" concept.
    await require_server_member(clip.server_id, user_id, db)

    file_path = SOUNDBOARD_DIR / clip.server_id / clip.filename
    if not file_path.exists():
        raise HTTPException(404, "File not found")

    content_type, _ = mimetypes.guess_type(clip.filename)
    return FileResponse(file_path, media_type=content_type or "application/octet-stream")


# ── Freesound library integration ─────────────────────────────────────

class LibraryResult(BaseModel):
    id: int
    name: str
    duration: float
    preview_url: str
    # INS-073: surface license + attribution to the client so users see
    # what they're importing BEFORE the import call lands them in the
    # instance-wide library with permanent attribution.
    license: str | None = None
    license_url: str | None = None
    username: str | None = None


FREESOUND_SORT_OPTIONS = {
    "relevance": "score",
    "popular": "downloads_desc",
    "rating": "rating_desc",
    "newest": "created_desc",
    "shortest": "duration_asc",
    "longest": "duration_desc",
}


# INS-073: lightweight in-process cache for Freesound search results.
# Their API has a per-token rate limit (60/min last we checked). The UI
# allows users to thrash the search box, so caching identical queries for
# 60s avoids exhausting the budget. Keyed on (q, sort, page); value is
# (expiry_unix_ts, results_list). Capped at 256 entries — when full, the
# oldest expiring entry is evicted lazily on each lookup.
_FREESOUND_CACHE: dict[tuple[str, str, int], tuple[float, list["LibraryResult"]]] = {}
_FREESOUND_CACHE_TTL_SECONDS = 60.0
_FREESOUND_CACHE_MAX_ENTRIES = 256


def _cache_get(key: tuple[str, str, int]) -> list["LibraryResult"] | None:
    entry = _FREESOUND_CACHE.get(key)
    if entry is None:
        return None
    expiry, results = entry
    if expiry <= time.time():
        _FREESOUND_CACHE.pop(key, None)
        return None
    return results


def _cache_put(key: tuple[str, str, int], results: list["LibraryResult"]) -> None:
    if len(_FREESOUND_CACHE) >= _FREESOUND_CACHE_MAX_ENTRIES:
        # Drop the entry with the smallest expiry (closest to expiring).
        # Cheap O(n) sweep — acceptable at n=256 and only on overflow.
        oldest_key = min(_FREESOUND_CACHE, key=lambda k: _FREESOUND_CACHE[k][0])
        _FREESOUND_CACHE.pop(oldest_key, None)
    _FREESOUND_CACHE[key] = (time.time() + _FREESOUND_CACHE_TTL_SECONDS, results)


@router.get("/library/search", response_model=list[LibraryResult])
async def search_library(
    q: str = Query(..., min_length=1, max_length=200),
    sort: str = Query("relevance"),
    page: int = Query(1, ge=1, le=20),
    user_id: str = Depends(get_user_id),
):
    """Search Freesound library for sound effects."""
    if not FREESOUND_API_KEY:
        raise HTTPException(501, "Sound library not configured (missing API key)")

    fs_sort = FREESOUND_SORT_OPTIONS.get(sort, "score")

    cache_key = (q.strip(), fs_sort, page)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            "https://freesound.org/apiv2/search/text/",
            params={
                "query": q,
                # INS-073: also pull license + username so attribution can
                # be persisted on import without a second round-trip.
                "fields": "id,name,duration,previews,license,username",
                "page": page,
                "page_size": 15,
                "filter": "duration:[0.1 TO 30]",
                "sort": fs_sort,
                "token": FREESOUND_API_KEY,
            },
        )
        if resp.status_code != 200:
            raise HTTPException(502, "Freesound API error")

    data = resp.json()
    results: list[LibraryResult] = []
    for item in data.get("results", []):
        previews = item.get("previews", {})
        preview_url = previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3", "")
        if preview_url:
            results.append(LibraryResult(
                id=item["id"],
                name=item["name"],
                duration=item.get("duration", 0),
                preview_url=preview_url,
                license=item.get("license"),
                license_url=item.get("license"),  # Freesound returns the canonical URL in the license field
                username=item.get("username"),
            ))
    _cache_put(cache_key, results)
    return results


class ImportRequest(BaseModel):
    freesound_id: int
    name: str = Field(min_length=1, max_length=100)
    preview_url: str
    # INS-073: client must echo back the license + attribution it saw so
    # the user has *seen* what they're agreeing to before it's persisted.
    # All three default to None for backward-compat with older clients;
    # the server fills "Unknown" / the freesound URL where the field is
    # missing rather than rejecting the import outright.
    license: str | None = None
    license_url: str | None = None
    attribution: str | None = None


@router.post("/library/import/{server_id}", response_model=ClipOut)
async def import_from_library(
    server_id: str,
    body: ImportRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Import a sound from Freesound into the instance-wide soundboard.

    INS-073: server_id in the URL is the *originating* server for
    attribution + file storage path. Once imported the clip is visible to
    every user on the instance via GET /api/soundboard/library.
    """
    if not FREESOUND_API_KEY:
        raise HTTPException(501, "Sound library not configured")

    await require_server_member(server_id, user_id, db)

    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    # Download the preview MP3
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(body.preview_url)
        if resp.status_code != 200:
            raise HTTPException(502, "Failed to download sound from Freesound")

    content = resp.content
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(400, "Sound file too large")

    # Validate it's actually an MP3
    if not any(content.startswith(m) for m in MAGIC_BYTES[".mp3"]):
        raise HTTPException(400, "Downloaded file is not a valid MP3")

    # Save file
    stored_name = f"fs_{body.freesound_id}_{secrets.token_urlsafe(8)}.mp3"
    server_dir = SOUNDBOARD_DIR / server_id
    server_dir.mkdir(parents=True, exist_ok=True)
    file_path = server_dir / stored_name
    await asyncio.to_thread(file_path.write_bytes, content)

    # Create DB record. INS-073: persist license + attribution. We never
    # want a Freesound-sourced clip in the library without these — even
    # if the client omitted them we record sentinel strings so a future
    # operator can audit which rows lack proper provenance.
    clip = SoundboardClip(
        server_id=server_id,
        name=body.name,
        filename=stored_name,
        uploaded_by=user_id,
        source="freesound",
        source_id=str(body.freesound_id),
        license=body.license or "unknown",
        license_url=body.license_url or f"https://freesound.org/s/{body.freesound_id}/",
        attribution=body.attribution or "unknown",
    )
    db.add(clip)
    await db.commit()
    await db.refresh(clip)

    return _clip_to_out(clip)


# INS-073: instance-wide library endpoint. Returns every clip on the
# instance regardless of which server originated it. Auth is verified via
# get_user_id (any logged-in user). Existing per-server endpoint below
# kept for backward compatibility — older clients filter to one server,
# new clients use this one.
@router.get("/library", response_model=list[ClipOut])
async def list_library(
    q: str | None = Query(None, max_length=200),
    user_id: str = Depends(get_user_id),  # noqa: ARG001 — auth gate only
    db: AsyncSession = Depends(get_db),
):
    """List the instance-wide soundboard library.

    Optional `q` does a case-insensitive substring match on the clip name
    so the client can render a search box without paginating. The library
    is small (low thousands at most) so we return everything in one shot.
    """
    stmt = select(SoundboardClip).order_by(SoundboardClip.name)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(SoundboardClip.name.ilike(like))
    result = await db.execute(stmt)
    clips = result.scalars().all()
    return [_clip_to_out(c) for c in clips]


@router.get("/{server_id}", response_model=list[ClipOut])
async def list_clips(
    server_id: str,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List soundboard clips visible from this server.

    INS-073: this endpoint is now an *alias* for the instance-wide library
    — every member of any server on the instance sees every clip. The
    server_id param is retained for URL compatibility (and to verify the
    requester is a member of *something*, not just any authenticated
    Matrix user) but no longer filters the result set. Older clients that
    GET /api/soundboard/{server_id} therefore see the full library
    automatically; newer clients should prefer GET /api/soundboard/library.
    """
    await require_server_member(server_id, user_id, db)
    result = await db.execute(
        select(SoundboardClip).order_by(SoundboardClip.name)
    )
    clips = result.scalars().all()
    return [_clip_to_out(c) for c in clips]


@router.post("/{server_id}", response_model=ClipOut)
async def upload_clip(
    server_id: str,
    name: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Upload a soundboard clip.

    INS-073: the upload endpoint still takes a server_id (used as the
    originating/attribution server and as the file storage subdirectory)
    but the resulting clip is visible instance-wide via the library
    endpoint. There is no per-server scoping anymore.
    """
    await require_server_member(server_id, user_id, db)

    # Verify server exists
    server = await db.get(Server, server_id)
    if not server:
        raise HTTPException(404, "Server not found")

    # Validate file
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported format. Allowed: {', '.join(ALLOWED_EXTENSIONS)}")

    # Stream-read up to MAX_FILE_SIZE + 1 to detect oversized files
    # without buffering unlimited data into RAM
    chunks = []
    total = 0
    while True:
        chunk = await file.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_FILE_SIZE:
            raise HTTPException(400, "File too large (max 5MB)")
        chunks.append(chunk)
    content = b"".join(chunks)

    # Validate magic bytes match the claimed extension
    magic_patterns = MAGIC_BYTES.get(ext, [])
    if magic_patterns and not any(content.startswith(m) for m in magic_patterns):
        raise HTTPException(400, f"File content does not match {ext} format")

    # Save file (async to avoid blocking the event loop)
    stored_name = f"{secrets.token_urlsafe(12)}{ext}"
    server_dir = (SOUNDBOARD_DIR / server_id).resolve()
    if not str(server_dir).startswith(str(SOUNDBOARD_DIR.resolve())):
        raise HTTPException(400, "Invalid server ID")
    server_dir.mkdir(parents=True, exist_ok=True)
    file_path = server_dir / stored_name
    await asyncio.to_thread(file_path.write_bytes, content)

    # Create DB record. INS-073: source/license/attribution stay NULL —
    # this is a user-original upload, no third-party license involved.
    clip = SoundboardClip(
        server_id=server_id,
        name=name,
        filename=stored_name,
        uploaded_by=user_id,
    )
    db.add(clip)
    await db.commit()
    await db.refresh(clip)

    return _clip_to_out(clip)


class ClipUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    keybind: str | None = None  # e.g. "Alt+1", or "" to clear


@router.patch("/{clip_id}")
async def update_clip(
    clip_id: int,
    body: ClipUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Update a soundboard clip (name, keybind). Requires uploader, originating-server owner, or admin."""
    clip = await db.get(SoundboardClip, clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found")

    if clip.uploaded_by != user_id and user_id not in ADMIN_USER_IDS:
        server = await db.get(Server, clip.server_id)
        if not server or server.owner_id != user_id:
            raise HTTPException(403, "Only the uploader, server owner, or admin can edit clips")

    if body.name is not None:
        clip.name = body.name.strip()
    if body.keybind is not None:
        clip.keybind = body.keybind.strip() or None  # empty string clears it
    await db.commit()
    return {"status": "updated", "name": clip.name, "keybind": clip.keybind}


@router.delete("/{clip_id}")
async def delete_clip(
    clip_id: int,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Delete a soundboard clip. Requires uploader, originating-server owner, or admin."""
    clip = await db.get(SoundboardClip, clip_id)
    if not clip:
        raise HTTPException(404, "Clip not found")

    # Allow deletion by the uploader, originating-server owner, or global admin.
    # INS-073: deletion is destructive across the whole instance now —
    # every user on every server loses access to the clip. The
    # uploader/owner/admin gate matches the prior security posture.
    if clip.uploaded_by != user_id and user_id not in ADMIN_USER_IDS:
        server = await db.get(Server, clip.server_id)
        if not server or server.owner_id != user_id:
            raise HTTPException(403, "Only the uploader, server owner, or admin can delete clips")

    # Delete file
    file_path = SOUNDBOARD_DIR / clip.server_id / clip.filename
    if file_path.exists():
        file_path.unlink()

    await db.delete(clip)
    await db.commit()
    return {"status": "deleted"}
