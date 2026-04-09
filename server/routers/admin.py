import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from config import (
    MATRIX_HOMESERVER_URL,
    ADMIN_USER_IDS,
    INSTANCE_SETTINGS_FILE,
    INSTANCE_NAME_DEFAULT,
    GITHUB_BUG_REPORT_TOKEN,
    GITHUB_BUG_REPORT_REPO,
)
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
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


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


async def _create_github_issue_for_bug_report(
    title: str, description: str, bug_report_id: int
) -> int | None:
    """Best-effort mirror of a bug report to a GitHub issue (INS-028).

    Returns the created issue number on success, or None on any
    failure. Failure modes — all produce a WARN log and return None:

      - GITHUB_BUG_REPORT_TOKEN env var is unset (the mirror is
        disabled entirely in that case — a single INFO log per call
        noting the skip, not a warning)
      - httpx network error (DNS, connection refused, TLS failure,
        timeout exceeded)
      - GitHub API non-2xx response (401 auth, 403 scope/rate-limit,
        404 repo-not-found, 422 validation, 5xx)
      - JSON parse error on the response body
      - Response body missing or malformed `number` field

    This function is called AFTER the bug_reports DB row has been
    committed, so a GitHub failure at this point never loses the
    user's report — the row persists in the local DB and the admin
    UI still surfaces it. Commercial-scope hygiene: no exception
    escapes this function into the request handler, because partial
    failure of a best-effort mirror must never fail the user-facing
    `POST /api/reports` call.

    Privacy: by design, ONLY the user-supplied title and description
    are sent to GitHub. The `system_info` JSON (userAgent, URL, voice
    state, etc.) is kept local in the `bug_reports` table so it
    never ends up in a public-repo issue body. Admins reviewing
    reports see the full system_info via the admin list endpoint,
    which pulls from the local DB row not the GitHub issue.
    """
    if not GITHUB_BUG_REPORT_TOKEN:
        logger.info(
            "bug report #%d: GITHUB_BUG_REPORT_TOKEN unset — GitHub mirror disabled",
            bug_report_id,
        )
        return None

    # The issue body preserves the user's description verbatim and
    # appends a small footer pointing at the internal report ID so
    # admins can cross-reference the public issue with the
    # system-info-bearing DB row. We deliberately do NOT embed a
    # machine-readable reference to the reporter or their
    # fingerprint here.
    body = (
        f"{description}\n\n"
        f"---\n"
        f"*Filed via Concord bug report pipeline. Internal ID: #{bug_report_id}. "
        f"Admins can view full reporter context (client fingerprint, voice "
        f"state, etc.) in the concord-api admin dashboard — that data is "
        f"never embedded in this public issue.*"
    )
    payload = {
        "title": title,
        "body": body,
        "labels": ["bug", "user-report"],
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.github.com/repos/{GITHUB_BUG_REPORT_REPO}/issues",
                headers={
                    "Authorization": f"Bearer {GITHUB_BUG_REPORT_TOKEN}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                json=payload,
            )
    except httpx.HTTPError as exc:
        # Catches connect, read, timeout, remote protocol, and TLS
        # errors. The DB row is already safe.
        logger.warning(
            "bug report #%d: GitHub API request failed (%s) — DB row kept, mirror skipped",
            bug_report_id,
            type(exc).__name__,
        )
        return None

    if resp.status_code != 201:
        # GitHub returns 201 Created on success for POST /issues.
        # Anything else is a failure. Log the status code and a
        # truncated body so operators can debug, but don't leak a
        # multi-kilobyte error page into the log stream.
        logger.warning(
            "bug report #%d: GitHub API returned %d %s — DB row kept, mirror skipped",
            bug_report_id,
            resp.status_code,
            (resp.text or "").strip()[:200],
        )
        return None

    try:
        data = resp.json()
    except ValueError:
        logger.warning(
            "bug report #%d: GitHub API response was not valid JSON — DB row kept",
            bug_report_id,
        )
        return None

    issue_number = data.get("number")
    if not isinstance(issue_number, int):
        logger.warning(
            "bug report #%d: GitHub API response missing integer 'number' field",
            bug_report_id,
        )
        return None

    logger.info(
        "bug report #%d: mirrored to GitHub issue #%d in %s",
        bug_report_id,
        issue_number,
        GITHUB_BUG_REPORT_REPO,
    )
    return issue_number


@router.post("/api/reports")
async def submit_bug_report(
    body: BugReportCreate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Submit a bug report.

    Two-phase persistence (INS-028):
      1. Write the row to the local DB. This is the source of truth
         and succeeds or fails atomically.
      2. Best-effort mirror to a GitHub issue via
         `_create_github_issue_for_bug_report`. Any failure here is
         logged and swallowed — the user's report is NEVER lost to
         a GitHub outage.
    """
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

    # Phase 2: GitHub mirror. Safe to call unconditionally — the
    # helper handles the "token unset" case internally with an INFO
    # log, and all other failure modes return None without raising.
    issue_number = await _create_github_issue_for_bug_report(
        body.title, body.description, report.id
    )
    if issue_number is not None:
        report.github_issue_number = issue_number
        await db.commit()

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
    name: str | None = Field(default=None, min_length=1, max_length=64)
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
        # Pydantic Field already enforces the 1-64 length range; this
        # extra check is now defensive only.
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
            # INS-028: github_issue_number is NULL for reports that
            # predate the integration, or that were filed while
            # GITHUB_BUG_REPORT_TOKEN was unset, or that failed to
            # mirror (graceful-degradation path). The admin UI
            # surfaces the difference as a "View on GitHub" link on
            # mirrored rows and "(GitHub unavailable)" on the rest.
            "github_issue_number": r.github_issue_number,
            "created_at": r.created_at.isoformat(),
            "updated_at": r.updated_at.isoformat(),
        }
        for r in result.scalars().all()
    ]


class ReportUpdate(BaseModel):
    status: str | None = Field(
        default=None,
        pattern=r"^(open|in_progress|resolved|closed)$",
    )
    admin_notes: str | None = Field(default=None, max_length=10_000)


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
#
# Source of truth for federation keys is `/etc/tuwunel.toml`, bind-mounted
# into both the conduwuit container (RO) and the concord-api container (RW).
# The flow is:
#   1. Admin edits allowlist in the UI.
#   2. PUT /api/admin/federation/allowlist rewrites the TOML file and marks
#      the config as "pending" (dirty vs running).
#   3. Admin confirms in a modal, frontend calls POST /api/admin/federation/apply.
#   4. concord-api asks docker-socket-proxy to restart the conduwuit service,
#      which reads the new tuwunel.toml on startup.
#
# See services/tuwunel_config.py and services/docker_control.py.

from services.tuwunel_config import (
    FederationSettings,
    decode_server_name_patterns,
    is_valid_server_name,
    read_federation,
    server_names_to_regex_patterns,
    write_federation,
)
from services.docker_control import DockerControlError, restart_compose_service


# Backwards-compatible alias. The canonical implementation now lives in
# ``services.tuwunel_config.decode_server_name_patterns`` so both the admin
# router and the explore router can share it; older call sites inside this
# module keep the previous name so their diff stays minimal.
_server_names_from_regex_patterns = decode_server_name_patterns


def _federation_has_pending_changes() -> bool:
    """True when tuwunel.toml has been edited since the last successful apply.

    We compare the file's mtime to ``federation_last_applied_at`` in the
    instance settings JSON. If no apply has ever been recorded, any
    existing file counts as pending so the admin can't forget to hit
    Apply after an install.
    """
    from services.tuwunel_config import TUWUNEL_CONFIG_PATH

    if not TUWUNEL_CONFIG_PATH.exists():
        return False
    last = _read_instance_settings().get("federation_last_applied_at")
    if not last:
        # Never applied — treat as pending.
        return True
    try:
        return TUWUNEL_CONFIG_PATH.stat().st_mtime > float(last)
    except (OSError, TypeError, ValueError):
        return True


@router.get("/api/admin/federation")
async def admin_get_federation(
    user_id: str = Depends(get_user_id),
):
    """Get current federation configuration.

    Returns both the running state (what Tuwunel is currently enforcing)
    and the pending state (what the TOML file will apply on next restart),
    so the UI can show an "unapplied changes" indicator.

    ``pending_apply`` is derived from the TOML file mtime vs. the last
    recorded successful ``/apply`` timestamp in instance settings. This
    survives page reloads and different admin sessions — the indicator
    only clears after a real restart succeeds.
    """
    require_admin(user_id)
    import os as _os

    # ``read_federation`` opens tuwunel.toml under an fcntl exclusive lock —
    # synchronous blocking I/O that stalls the FastAPI event loop. Offload
    # it to the default thread-pool executor, matching the pattern in
    # routers/explore.py:74.
    loop = asyncio.get_event_loop()
    settings = await loop.run_in_executor(None, read_federation)
    return {
        "enabled": settings.allow_federation,
        "server_name": _os.getenv("CONDUWUIT_SERVER_NAME", "unknown"),
        "allowed_servers": _server_names_from_regex_patterns(
            settings.allowed_remote_server_names
        ),
        "raw_allowed_patterns": settings.allowed_remote_server_names,
        "raw_forbidden_patterns": settings.forbidden_remote_server_names,
        "pending_apply": _federation_has_pending_changes(),
    }


class FederationAllowlistUpdate(BaseModel):
    allowed_servers: list[str] = Field(
        min_length=0,
        max_length=1000,
        description="Plain RFC-1123 hostnames — not regex.",
    )


@router.put("/api/admin/federation/allowlist")
async def admin_update_federation_allowlist(
    body: FederationAllowlistUpdate,
    user_id: str = Depends(get_user_id),
):
    """Update the federation allowlist (pending — not applied yet).

    Writes the new allowlist to ``tuwunel.toml`` with anchored regex
    patterns. The change is not visible to Tuwunel until
    ``POST /api/admin/federation/apply`` triggers a container restart.
    """
    require_admin(user_id)

    # Validate: each entry must be a well-formed RFC-1123 hostname.
    # Silent drops would hide mistakes from the admin, so we 400 on bad input.
    cleaned: list[str] = []
    rejected: list[str] = []
    for name in body.allowed_servers:
        name = name.strip().lower()
        if not name:
            continue
        if not is_valid_server_name(name):
            rejected.append(name)
            continue
        cleaned.append(name)

    if rejected:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "Invalid server name(s)",
                "rejected": rejected,
                "message": "Each entry must be a valid hostname (letters, digits, hyphens, dot-separated).",
            },
        )

    # Build anchored regex patterns (^escaped$) — correctness fix over the
    # previous "escape + $" version which allowed unintended substring matches.
    regex_patterns = server_names_to_regex_patterns(cleaned)

    # Read + overlay + write atomically so the conduwuit container never
    # sees a torn config on its next read. Both sides of the round-trip
    # are offloaded to the thread-pool executor to avoid stalling the
    # async event loop while holding the fcntl lock.
    loop = asyncio.get_event_loop()
    current = await loop.run_in_executor(None, read_federation)
    current.allowed_remote_server_names = regex_patterns
    await loop.run_in_executor(None, write_federation, current)

    logger.info(
        "Federation allowlist edited by %s: %s (apply pending — restart required)",
        user_id, cleaned,
    )

    return {
        "allowed_servers": cleaned,
        "raw_allowed_patterns": regex_patterns,
        "pending_apply": True,
        "message": (
            "Allowlist saved. Click 'Apply changes' to restart the Matrix "
            "server and activate the new allowlist."
        ),
    }


@router.post("/api/admin/federation/apply")
async def admin_apply_federation(
    user_id: str = Depends(get_user_id),
):
    """Restart the conduwuit container so Tuwunel picks up the new config.

    This is a blocking operation — returns only after the container is back
    up. Typical runtime is 5-15 seconds. The frontend should show a spinner.

    Raises 502 if the docker-socket-proxy sidecar is unreachable or the
    Docker API rejects the restart.
    """
    require_admin(user_id)

    logger.info("Federation config apply (restart) triggered by %s", user_id)
    try:
        result = await restart_compose_service("conduwuit")
    except DockerControlError as exc:
        logger.error("Federation apply failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={
                "error": "Federation apply failed",
                "message": str(exc),
                "hint": (
                    "Check that the docker-socket-proxy service is running "
                    "and that concord-api can reach it."
                ),
            },
        ) from exc

    # Only record success after the Docker API has confirmed the restart.
    # This timestamp gates the "pending apply" indicator on the GET endpoint.
    import time as _time
    settings_json = _read_instance_settings()
    settings_json["federation_last_applied_at"] = _time.time()
    settings_json["federation_last_applied_by"] = user_id
    _write_instance_settings(settings_json)

    logger.info(
        "Federation apply succeeded: restarted %d container(s) in %.2fs",
        len(result["restarted"]), result["elapsed_seconds"],
    )
    return {
        "applied": True,
        "restarted_containers": result["restarted"],
        "elapsed_seconds": result["elapsed_seconds"],
    }
