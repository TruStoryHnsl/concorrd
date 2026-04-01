import json
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from config import MATRIX_HOMESERVER_URL, ADMIN_USER_IDS, INSTANCE_SETTINGS_FILE, INSTANCE_NAME_DEFAULT
from database import get_db
from models import (
    Server, Channel, ServerMember, InviteToken,
    SoundboardClip, Webhook, BugReport,
)
from routers.servers import get_user_id, get_access_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["admin"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def require_admin(user_id: str) -> None:
    if user_id not in ADMIN_USER_IDS:
        raise HTTPException(403, "Admin access required")


def _read_instance_settings() -> dict:
    if INSTANCE_SETTINGS_FILE.exists():
        return json.loads(INSTANCE_SETTINGS_FILE.read_text())
    return {}


def _write_instance_settings(settings: dict) -> None:
    INSTANCE_SETTINGS_FILE.write_text(json.dumps(settings, indent=2))


# ---------------------------------------------------------------------------
# Instance info (public, no auth)
# ---------------------------------------------------------------------------

@router.get("/api/instance")
async def get_instance():
    """Return public instance metadata (name, etc)."""
    settings = _read_instance_settings()
    return {
        "name": settings.get("name", INSTANCE_NAME_DEFAULT),
        "require_totp": settings.get("require_totp", False),
    }


# ---------------------------------------------------------------------------
# Password change (any authenticated user)
# ---------------------------------------------------------------------------

class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1, max_length=128)


@router.post("/api/user/change-password")
async def change_password(
    body: PasswordChangeRequest,
    user_id: str = Depends(get_user_id),
    access_token: str = Depends(get_access_token),
):
    """Change the user's password via Matrix UIA flow."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: initiate password change to get UIA session
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/account/password",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"new_password": body.new_password},
        )

        if resp.status_code == 200:
            return {"status": "ok"}

        data = resp.json()
        session_id = data.get("session")
        if not session_id:
            raise HTTPException(400, data.get("error", "Password change failed"))

        # Step 2: complete with current password auth
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/account/password",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "auth": {
                    "type": "m.login.password",
                    "identifier": {
                        "type": "m.id.user",
                        "user": user_id,
                    },
                    "password": body.current_password,
                    "session": session_id,
                },
                "new_password": body.new_password,
            },
        )

        if resp.status_code == 200:
            return {"status": "ok"}

        error = resp.json().get("error", "Password change failed")
        if resp.status_code == 401:
            raise HTTPException(401, "Current password is incorrect")
        raise HTTPException(400, error)


# ---------------------------------------------------------------------------
# Bug reports (any authenticated user can submit)
# ---------------------------------------------------------------------------

class BugReportCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=5000)
    system_info: str | None = None  # JSON string from client


@router.post("/api/reports")
async def submit_bug_report(
    body: BugReportCreate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Submit a bug report."""
    report = BugReport(
        reported_by=user_id,
        title=body.title,
        description=body.description,
        system_info=body.system_info,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info("Bug report #%d submitted by %s: %s", report.id, user_id, body.title)
    return {"status": "ok", "id": report.id}


# ---------------------------------------------------------------------------
# Admin: check
# ---------------------------------------------------------------------------

@router.get("/api/admin/check")
async def admin_check(user_id: str = Depends(get_user_id)):
    """Check if the current user is a global admin."""
    return {"is_admin": user_id in ADMIN_USER_IDS}


# ---------------------------------------------------------------------------
# Admin: instance settings
# ---------------------------------------------------------------------------

class InstanceUpdate(BaseModel):
    name: str | None = None
    require_totp: bool | None = None


@router.patch("/api/admin/instance")
async def admin_update_instance(
    body: InstanceUpdate,
    user_id: str = Depends(get_user_id),
):
    """Update instance settings (admin only)."""
    require_admin(user_id)
    settings = _read_instance_settings()
    if body.name is not None:
        if len(body.name) < 1 or len(body.name) > 64:
            from fastapi import HTTPException
            raise HTTPException(400, "Name must be 1-64 characters")
        settings["name"] = body.name
    if body.require_totp is not None:
        settings["require_totp"] = body.require_totp
    _write_instance_settings(settings)
    return {
        "name": settings.get("name", INSTANCE_NAME_DEFAULT),
        "require_totp": settings.get("require_totp", False),
    }


# ---------------------------------------------------------------------------
# Admin: dashboard stats
# ---------------------------------------------------------------------------

@router.get("/api/admin/stats")
async def admin_stats(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Get global stats for the admin dashboard."""
    require_admin(user_id)

    total_servers = (await db.execute(select(func.count(Server.id)))).scalar() or 0
    total_channels = (await db.execute(select(func.count(Channel.id)))).scalar() or 0
    total_members = (await db.execute(
        select(func.count(func.distinct(ServerMember.user_id)))
    )).scalar() or 0
    total_invites = (await db.execute(select(func.count(InviteToken.id)))).scalar() or 0
    total_clips = (await db.execute(select(func.count(SoundboardClip.id)))).scalar() or 0
    total_webhooks = (await db.execute(select(func.count(Webhook.id)))).scalar() or 0
    open_reports = (await db.execute(
        select(func.count(BugReport.id)).where(BugReport.status.in_(["open", "in_progress"]))
    )).scalar() or 0
    total_reports = (await db.execute(select(func.count(BugReport.id)))).scalar() or 0

    return {
        "total_servers": total_servers,
        "total_channels": total_channels,
        "total_users": total_members,
        "total_invites": total_invites,
        "total_soundboard_clips": total_clips,
        "total_webhooks": total_webhooks,
        "open_reports": open_reports,
        "total_reports": total_reports,
    }


# ---------------------------------------------------------------------------
# Admin: servers
# ---------------------------------------------------------------------------

@router.get("/api/admin/servers")
async def admin_list_servers(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """List all servers with member counts."""
    require_admin(user_id)

    result = await db.execute(
        select(
            Server.id,
            Server.name,
            Server.owner_id,
            Server.visibility,
            Server.created_at,
            func.count(ServerMember.id).label("member_count"),
        )
        .outerjoin(ServerMember, ServerMember.server_id == Server.id)
        .group_by(Server.id)
        .order_by(Server.created_at)
        .limit(limit)
        .offset(offset)
    )

    return [
        {
            "id": row.id,
            "name": row.name,
            "owner_id": row.owner_id,
            "visibility": row.visibility,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "member_count": row.member_count,
        }
        for row in result.all()
    ]


# ---------------------------------------------------------------------------
# Admin: users
# ---------------------------------------------------------------------------

@router.get("/api/admin/users")
async def admin_list_users(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """List all unique users with their server memberships."""
    require_admin(user_id)

    result = await db.execute(
        select(
            ServerMember.user_id,
            func.count(ServerMember.server_id).label("server_count"),
            func.min(ServerMember.joined_at).label("first_seen"),
            func.group_concat(ServerMember.role).label("roles"),
        )
        .group_by(ServerMember.user_id)
        .order_by(func.min(ServerMember.joined_at))
        .limit(limit)
        .offset(offset)
    )

    users = []
    for row in result.all():
        roles = set(row.roles.split(",")) if row.roles else set()
        users.append({
            "user_id": row.user_id,
            "server_count": row.server_count,
            "first_seen": row.first_seen.isoformat() if row.first_seen else None,
            "is_admin": row.user_id in ADMIN_USER_IDS,
            "has_owner_role": "owner" in roles,
        })

    return users


# ---------------------------------------------------------------------------
# Admin: bug reports
# ---------------------------------------------------------------------------

@router.get("/api/admin/reports")
async def admin_list_reports(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """List all bug reports."""
    require_admin(user_id)

    result = await db.execute(
        select(BugReport).order_by(BugReport.created_at.desc())
    )

    return [
        {
            "id": r.id,
            "reported_by": r.reported_by,
            "title": r.title,
            "description": r.description,
            "system_info": json.loads(r.system_info) if r.system_info else None,
            "status": r.status,
            "admin_notes": r.admin_notes,
            "created_at": r.created_at.isoformat(),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in result.scalars().all()
    ]


class ReportUpdate(BaseModel):
    status: str | None = None  # open, in_progress, resolved, closed
    admin_notes: str | None = None


@router.patch("/api/admin/reports/{report_id}")
async def admin_update_report(
    report_id: int,
    body: ReportUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Update a bug report's status or add admin notes."""
    require_admin(user_id)

    report = await db.get(BugReport, report_id)
    if not report:
        raise HTTPException(404, "Report not found")

    if body.status is not None:
        if body.status not in ("open", "in_progress", "resolved", "closed"):
            raise HTTPException(400, "Invalid status")
        report.status = body.status

    if body.admin_notes is not None:
        report.admin_notes = body.admin_notes

    report.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "updated"}


# ---------------------------------------------------------------------------
# Admin: federation management
# ---------------------------------------------------------------------------

@router.get("/api/admin/federation")
async def admin_get_federation(
    user_id: str = Depends(get_user_id),
):
    """Get current federation configuration."""
    require_admin(user_id)
    settings = _read_instance_settings()
    import os

    # Read live env config
    allow_federation = os.getenv("CONDUWUIT_ALLOW_FEDERATION", "true").lower() == "true"

    return {
        "enabled": allow_federation,
        "server_name": os.getenv("CONDUWUIT_SERVER_NAME", "unknown"),
        "allowed_servers": settings.get("federation_allowlist", []),
    }


class FederationAllowlistUpdate(BaseModel):
    allowed_servers: list[str]  # server names (not regex — we escape them)


@router.put("/api/admin/federation/allowlist")
async def admin_update_federation_allowlist(
    body: FederationAllowlistUpdate,
    user_id: str = Depends(get_user_id),
):
    """Update the federation allowlist.

    Stores the list in instance settings. The actual Conduwuit env var
    (CONDUWUIT_ALLOWED_REMOTE_SERVER_NAMES) must be regenerated from
    this list on container restart. A future version will hot-reload
    via the Conduwuit admin API.
    """
    require_admin(user_id)

    # Validate: server names should look like domains
    cleaned = []
    for name in body.allowed_servers:
        name = name.strip().lower()
        if not name or len(name) > 253:
            continue
        cleaned.append(name)

    settings = _read_instance_settings()
    settings["federation_allowlist"] = cleaned
    _write_instance_settings(settings)

    # Build the regex patterns for Conduwuit env var
    import re
    regex_patterns = [re.escape(s) + "$" for s in cleaned]

    logger.info(
        "Federation allowlist updated by %s: %s (restart required for Conduwuit to pick up changes)",
        user_id, cleaned,
    )

    return {
        "allowed_servers": cleaned,
        "env_value": json.dumps(regex_patterns),
        "restart_required": True,
    }
