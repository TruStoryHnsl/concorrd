"""INS-071 Phase A — optional email account recovery (admin-blind).

Privacy invariant (load-bearing): NO API surface returns
``recovery_email``. Only direct DB access reveals it. Admin endpoints
that list users / reports MUST omit it. The UI knows only a boolean
``has_recovery_email``.

Anti-enumeration: the public ``POST /api/auth/forgot-password`` endpoint
ALWAYS returns the same 200 body shape regardless of whether the user
exists, has a recovery email, or whether SMTP is configured. A leak
here would let an unauthenticated peer enumerate which Matrix users
have set up recovery — a privacy regression even more serious than
exposing the email itself.

Phase A stores ``recovery_email`` in plaintext in the DB.
Phase B (INS-071-FUP) adds encryption-at-rest. The contract here is
designed so Phase B is a migration of column storage, not a change to
the API surface.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import MATRIX_HOMESERVER_URL, SITE_URL
from database import get_db
from models import User
from dependencies import get_user_id
from services import email as email_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["auth-recovery"])


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RESET_TOKEN_TTL = timedelta(hours=1)

# Anti-enumeration: every forgot-password response is this exact body.
# Length is deliberately fixed so a side-channel observer can't infer
# user existence from response size.
_FORGOT_PASSWORD_BODY = {
    "message": "If a recovery email is on file, you'll receive a reset link.",
}


# Permissive RFC-5322-ish email regex. We don't validate deliverability —
# that's the SMTP layer's job. We just block obviously malformed values
# at the API boundary so the DB doesn't fill with junk.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _is_email_like(value: str) -> bool:
    return bool(_EMAIL_RE.match(value))


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Request/Response models
# ---------------------------------------------------------------------------


class RecoveryEmailUpdate(BaseModel):
    # Note: deliberately NOT EmailStr — we want a clear validation error
    # the client can surface, not Pydantic's pydantic-core noise. We also
    # accept ``None`` to clear the recovery email.
    recovery_email: str | None = Field(default=None, max_length=320)

    @field_validator("recovery_email")
    @classmethod
    def _validate_email(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if v == "":
            return None
        if not _is_email_like(v):
            raise ValueError("Invalid email format")
        return v


class RecoveryEmailStatus(BaseModel):
    """Response model for ``GET /api/user/recovery-email-status``.

    LOAD-BEARING: this model has EXACTLY one field, ``has_recovery_email``.
    Adding a field that exposes the email value would break the
    admin-blind invariant tested in
    ``tests/test_recovery_email_admin_blind.py``.
    """

    has_recovery_email: bool


class ForgotPasswordRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=256)


class ForgotPasswordResponse(BaseModel):
    message: str


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=8, max_length=512)
    new_password: str = Field(min_length=8, max_length=128)


# ---------------------------------------------------------------------------
# PUT /api/user/recovery-email — set or clear (self only)
# ---------------------------------------------------------------------------


@router.put("/api/user/recovery-email", status_code=204)
async def set_recovery_email(
    body: RecoveryEmailUpdate,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Set or clear the authenticated user's recovery email.

    Returns 204 on success with no body — explicitly NOT echoing the
    submitted email back to preserve the admin-blind invariant even
    when the user was the one who supplied it (defense in depth: a
    proxy that logs response bodies should never see the email).
    """
    user = await db.get(User, user_id)
    if user is None:
        user = User(user_id=user_id, recovery_email=body.recovery_email)
        db.add(user)
    else:
        user.recovery_email = body.recovery_email
        # Setting/clearing the email also invalidates any in-flight token —
        # an attacker who later compromised the email shouldn't be able to
        # use a token issued before the user changed their address.
        user.recovery_token_hash = None
        user.recovery_token_expires = None
    await db.commit()


# ---------------------------------------------------------------------------
# GET /api/user/recovery-email-status — boolean only (self only)
# ---------------------------------------------------------------------------


@router.get(
    "/api/user/recovery-email-status",
    response_model=RecoveryEmailStatus,
)
async def get_recovery_email_status(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
) -> RecoveryEmailStatus:
    """Return whether the authenticated user has a recovery email set.

    Never returns the actual email value. The Pydantic
    :class:`RecoveryEmailStatus` response model has exactly one field;
    the admin-blind tests assert this by reflection.
    """
    user = await db.get(User, user_id)
    has = bool(user is not None and user.recovery_email)
    return RecoveryEmailStatus(has_recovery_email=has)


# ---------------------------------------------------------------------------
# POST /api/auth/forgot-password — anti-enumeration (no auth)
# ---------------------------------------------------------------------------


@router.post(
    "/api/auth/forgot-password",
    response_model=ForgotPasswordResponse,
)
async def forgot_password(
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> ForgotPasswordResponse:
    """Request a password reset link for ``body.user_id``.

    ALWAYS returns 200 with the same body shape, regardless of whether:
      - the user exists,
      - the user has a recovery email on file,
      - SMTP is configured,
      - the email actually delivers.

    This is the anti-enumeration contract. A non-200 here, or a body
    that varies based on those conditions, is a privacy regression.
    """
    # Always do the DB lookup so timing doesn't leak existence either —
    # but this is cooperative-best-effort, not constant-time. SQLite's
    # B-tree lookup on the primary key is roughly O(log N) regardless
    # of hit/miss, which is "close enough" for this threat model.
    user = await db.get(User, body.user_id)

    if user is not None and user.recovery_email and email_service.is_configured():
        # Generate token + hash + expiry. The plaintext token is
        # embedded in the email URL — only the recipient ever sees
        # it. We persist the hash so the DB never contains a
        # usable secret.
        token = secrets.token_urlsafe(32)
        user.recovery_token_hash = _hash_token(token)
        user.recovery_token_expires = datetime.now(timezone.utc) + RESET_TOKEN_TTL
        await db.commit()

        reset_url = f"{SITE_URL}/reset-password?token={token}"
        try:
            await email_service.send_password_reset_email(
                user.recovery_email, reset_url
            )
        except Exception as exc:
            # Email delivery failure — log the *event*, never the
            # token or URL. The user will still see the generic
            # success response (anti-enumeration) and can retry.
            logger.warning(
                "forgot-password: email delivery failed for user_id=%s (%s)",
                body.user_id,
                type(exc).__name__,
            )
    else:
        # Sleep-equivalent placeholder removed deliberately — we
        # accept a small timing oracle in exchange for not adding
        # spurious latency to the success path. The DB lookup is
        # the dominant timing factor either way.
        logger.info(
            "forgot-password: no-op for user_id=%s (existence/email/SMTP unmet)",
            body.user_id,
        )

    return ForgotPasswordResponse(**_FORGOT_PASSWORD_BODY)


# ---------------------------------------------------------------------------
# POST /api/auth/reset-password — redeem token (no auth)
# ---------------------------------------------------------------------------


async def _reset_matrix_password(matrix_user_id: str, new_password: str) -> None:
    """Server-privileged password reset via the Synapse-compatible admin API.

    Tuwunel/Conduwuit expose ``POST /_synapse/admin/v1/reset_password/{userId}``
    which mirrors Synapse's admin API. This path REQUIRES a server admin
    token. In Concord deployments the bot user is the natural carrier:
    when the operator has promoted ``concord-bot`` to admin (via the
    homeserver's CLI or a bootstrap script), the reset succeeds. When it
    has not, this call returns 403 and we raise — the user sees a 400
    "Reset failed" response.

    We deliberately split this into a separate function so tests can
    monkeypatch it without mocking the entire ``httpx`` boundary.
    """
    from services.bot import BOT_ACCESS_TOKEN

    if not BOT_ACCESS_TOKEN:
        raise RuntimeError("Bot access token unavailable — cannot reset password")

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_synapse/admin/v1/reset_password/{matrix_user_id}",
            headers={"Authorization": f"Bearer {BOT_ACCESS_TOKEN}"},
            json={"new_password": new_password, "logout_devices": True},
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Matrix admin reset_password returned {resp.status_code}: "
                f"{(resp.text or '')[:200]}"
            )


@router.post("/api/auth/reset-password", status_code=204)
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Redeem a recovery token and set a new password.

    Looks up the user by ``sha256(token)``, checks the expiry, then
    delegates to the Matrix admin API. On success, clears the token
    fields so the link cannot be reused.

    Returns 204 with no body. The body never echoes the email or any
    user identifier — the admin-blind invariant covers this endpoint
    too.
    """
    token_hash = _hash_token(body.token)

    result = await db.execute(
        select(User).where(User.recovery_token_hash == token_hash)
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(400, "Invalid or expired reset token")

    expires = user.recovery_token_expires
    if expires is None:
        raise HTTPException(400, "Invalid or expired reset token")
    # SQLite returns naive datetimes from a tz-aware column on read;
    # treat them as UTC so the comparison is correct.
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        # Clear stale token before bouncing the request — defense in
        # depth against replay if the attacker only learned the hash.
        user.recovery_token_hash = None
        user.recovery_token_expires = None
        await db.commit()
        raise HTTPException(400, "Invalid or expired reset token")

    try:
        await _reset_matrix_password(user.user_id, body.new_password)
    except Exception as exc:
        logger.warning(
            "reset-password: matrix admin call failed for user_id=%s (%s)",
            user.user_id,
            type(exc).__name__,
        )
        raise HTTPException(400, "Password reset failed") from exc

    user.recovery_token_hash = None
    user.recovery_token_expires = None
    await db.commit()
