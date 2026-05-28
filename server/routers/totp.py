import io
import base64
import logging

import pyotp
import qrcode
import qrcode.constants
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import INSTANCE_SETTINGS_FILE, INSTANCE_NAME_DEFAULT
from database import get_db
from models import UserTOTP
from dependencies import get_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/user/totp", tags=["totp"])


def _instance_name() -> str:
    import json
    if INSTANCE_SETTINGS_FILE.exists():
        try:
            return json.loads(INSTANCE_SETTINGS_FILE.read_text()).get("name", INSTANCE_NAME_DEFAULT)
        except Exception:
            pass
    return INSTANCE_NAME_DEFAULT


# --- Status ---

@router.get("/status")
async def totp_status(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(UserTOTP).where(UserTOTP.user_id == user_id, UserTOTP.enabled == True)
    )
    totp = result.scalar_one_or_none()
    return {"enabled": totp is not None}


# --- Setup (generate secret + QR) ---

@router.post("/setup")
async def totp_setup(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Generate a TOTP secret and return QR code data URI."""
    # Check if already enabled
    result = await db.execute(
        select(UserTOTP).where(UserTOTP.user_id == user_id)
    )
    existing = result.scalar_one_or_none()
    if existing and existing.enabled:
        raise HTTPException(400, "TOTP is already enabled. Disable it first to re-setup.")

    secret = pyotp.random_base32()
    username = user_id.split(":")[0].lstrip("@")
    issuer = _instance_name()
    totp = pyotp.TOTP(secret)
    provisioning_uri = totp.provisioning_uri(name=username, issuer_name=issuer)

    # Generate QR code as base64 data URI
    qr = qrcode.make(provisioning_uri, error_correction=qrcode.constants.ERROR_CORRECT_L)
    buf = io.BytesIO()
    qr.save(buf, format="PNG")
    qr_data_uri = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"

    # Store the secret (upsert)
    if existing:
        existing.secret = secret
        existing.enabled = False
    else:
        db.add(UserTOTP(user_id=user_id, secret=secret, enabled=False))
    await db.commit()

    return {
        "secret": secret,
        "qr_code": qr_data_uri,
        "provisioning_uri": provisioning_uri,
    }


# --- Verify (enable TOTP after confirming with a code) ---

class TOTPVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


@router.post("/verify")
async def totp_verify(
    body: TOTPVerifyRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Verify a TOTP code and enable 2FA for the user."""
    result = await db.execute(
        select(UserTOTP).where(UserTOTP.user_id == user_id)
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(400, "No TOTP setup in progress. Call /setup first.")

    totp = pyotp.TOTP(record.secret)
    if not totp.verify(body.code):
        raise HTTPException(400, "Invalid code. Please try again.")

    record.enabled = True
    await db.commit()
    logger.info("TOTP enabled for user %s", user_id)
    return {"status": "enabled"}


# --- Disable ---

class TOTPDisableRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


@router.post("/disable")
async def totp_disable(
    body: TOTPDisableRequest,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Disable TOTP 2FA (requires current code)."""
    result = await db.execute(
        select(UserTOTP).where(UserTOTP.user_id == user_id, UserTOTP.enabled == True)
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(400, "TOTP is not enabled")

    totp = pyotp.TOTP(record.secret)
    if not totp.verify(body.code):
        raise HTTPException(400, "Invalid code")

    record.enabled = False
    await db.commit()
    logger.info("TOTP disabled for user %s", user_id)
    return {"status": "disabled"}


# --- Login verification (called after Matrix auth) ---

class TOTPLoginVerify(BaseModel):
    code: str = Field(min_length=6, max_length=6)


@router.post("/login-verify")
async def totp_login_verify(
    body: TOTPLoginVerify,
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Verify TOTP code during login flow."""
    result = await db.execute(
        select(UserTOTP).where(UserTOTP.user_id == user_id, UserTOTP.enabled == True)
    )
    record = result.scalar_one_or_none()
    if not record:
        return {"status": "not_required"}

    totp = pyotp.TOTP(record.secret)
    if not totp.verify(body.code):
        raise HTTPException(400, "Invalid code")

    return {"status": "verified"}


# --- Check if any user has TOTP (for avatar rendering) ---

@router.get("/users-with-totp")
async def users_with_totp(
    user_id: str = Depends(get_user_id),
    db: AsyncSession = Depends(get_db),
):
    """Return list of user IDs that have TOTP enabled (for presence dot positioning)."""
    result = await db.execute(
        select(UserTOTP.user_id).where(UserTOTP.enabled == True)
    )
    return {"user_ids": [row[0] for row in result.all()]}
