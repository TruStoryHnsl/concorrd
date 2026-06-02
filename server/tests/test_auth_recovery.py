"""INS-071 Phase A — happy-path tests for recovery-email + reset flow.

The privacy-invariant tests live in ``test_recovery_email_admin_blind.py``.
This file exercises the *functional* contract:

  - PUT/GET recovery email round-trip
  - forgot-password sends an email
  - reset-password with valid token flips the Matrix password
  - expired/unknown tokens are rejected
  - anti-enumeration: nonexistent or no-email users still get 200

We mock the SMTP boundary (``aiosmtplib.send``) and the Matrix admin
boundary (the helper ``_reset_matrix_password``) — NOT the recovery
service itself. The whole point is to exercise the real code path so a
typo in the token-hashing flow gets caught.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from models import User
from routers import auth_recovery
from services import email as email_service
from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _smtp_configured(monkeypatch):
    """Pretend SMTP is configured so forgot-password actually fires the
    email path. Each test that needs to assert on the SMTP call patches
    ``aiosmtplib.send`` separately; this fixture only flips
    ``is_configured()`` to True."""
    monkeypatch.setattr(email_service, "SMTP_HOST", "smtp.example.invalid")
    monkeypatch.setattr(email_service, "SMTP_FROM", "noreply@example.invalid")
    monkeypatch.setattr(email_service, "SITE_URL", "https://example.invalid")


@pytest.fixture
async def seeded_user(db_session) -> User:
    """A user with a recovery email already on file."""
    user = User(user_id="@alice:test.local", recovery_email="alice@example.com")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


# ---------------------------------------------------------------------
# Recovery-email round trip
# ---------------------------------------------------------------------


async def test_set_recovery_email_then_status_reports_true(client, db_session):
    login_as("@alice:test.local")
    resp = await client.put(
        "/api/user/recovery-email",
        json={"recovery_email": "alice@example.com"},
    )
    assert resp.status_code == 204

    status = await client.get("/api/user/recovery-email-status")
    assert status.status_code == 200
    assert status.json() == {"has_recovery_email": True}


async def test_clear_recovery_email_then_status_reports_false(client, seeded_user):
    login_as(seeded_user.user_id)
    resp = await client.put("/api/user/recovery-email", json={"recovery_email": None})
    assert resp.status_code == 204

    status = await client.get("/api/user/recovery-email-status")
    assert status.json() == {"has_recovery_email": False}


async def test_set_recovery_email_rejects_invalid_format(client):
    login_as("@alice:test.local")
    resp = await client.put(
        "/api/user/recovery-email",
        json={"recovery_email": "not-an-email"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------
# Forgot-password — email actually fires
# ---------------------------------------------------------------------


async def test_forgot_password_sends_email_when_configured(client, seeded_user):
    """Mock the SMTP boundary, NOT the recovery flow itself."""
    logout()  # forgot-password is unauthenticated
    sent = AsyncMock()
    with patch("services.email.aiosmtplib.send", sent):
        resp = await client.post(
            "/api/auth/forgot-password",
            json={"user_id": seeded_user.user_id},
        )
    assert resp.status_code == 200
    sent.assert_awaited_once()
    # The To: header on the EmailMessage should match the user's
    # recovery email — we verify here that the address routing is
    # correct without our test ever needing to handle the plaintext
    # token from the body.
    msg = sent.await_args.args[0]
    assert msg["To"] == "alice@example.com"


async def test_forgot_password_persists_token_hash_with_expiry(client, db_session, seeded_user):
    logout()
    with patch("services.email.aiosmtplib.send", AsyncMock()):
        await client.post(
            "/api/auth/forgot-password",
            json={"user_id": seeded_user.user_id},
        )

    await db_session.refresh(seeded_user)
    assert seeded_user.recovery_token_hash is not None
    assert seeded_user.recovery_token_expires is not None
    # Expiry is approximately 1h in the future.
    expires = seeded_user.recovery_token_expires
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    delta = expires - datetime.now(timezone.utc)
    assert timedelta(minutes=55) < delta < timedelta(minutes=65)


# ---------------------------------------------------------------------
# Reset-password — valid / expired / unknown
# ---------------------------------------------------------------------


async def test_reset_password_valid_token_clears_token_and_calls_matrix(
    client, db_session, seeded_user
):
    """Issue a token via forgot-password, then redeem it.

    We capture the plaintext token from the patched email-send call so
    the test exercises the real hashing path.
    """
    logout()
    captured: dict = {}

    async def _capture(msg, **_kwargs):
        # The EmailMessage is multipart (text + html). Walk to the
        # text/plain part — ``get_content()`` on a multipart container
        # raises KeyError, so we have to dig.
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                captured["body"] = part.get_content()
                return
        # Fallback: serialize the whole thing as text.
        captured["body"] = msg.as_string()

    with patch("services.email.aiosmtplib.send", new=_capture):
        r = await client.post(
            "/api/auth/forgot-password",
            json={"user_id": seeded_user.user_id},
        )
        assert r.status_code == 200

    body = captured["body"]
    # Extract the token from "...?token=XYZ"
    assert "token=" in body
    token = body.split("token=", 1)[1].split()[0].rstrip(",.\r\n")

    matrix_call = AsyncMock()
    with patch("routers.auth_recovery._reset_matrix_password", matrix_call):
        resp = await client.post(
            "/api/auth/reset-password",
            json={"token": token, "new_password": "newpass-123"},
        )
    assert resp.status_code == 204
    matrix_call.assert_awaited_once()
    args = matrix_call.await_args.args
    assert args[0] == seeded_user.user_id
    assert args[1] == "newpass-123"

    # Token cleared.
    await db_session.refresh(seeded_user)
    assert seeded_user.recovery_token_hash is None
    assert seeded_user.recovery_token_expires is None


async def test_reset_password_unknown_token_returns_400(client):
    logout()
    resp = await client.post(
        "/api/auth/reset-password",
        json={"token": "totally-fake-token", "new_password": "newpass-123"},
    )
    assert resp.status_code == 400


async def test_reset_password_expired_token_returns_400(
    client, db_session, seeded_user
):
    """Force an expired token row and verify rejection."""
    logout()
    # Hash a known token and store with past expiry.
    fake_token = "stale-token-value"
    seeded_user.recovery_token_hash = auth_recovery._hash_token(fake_token)
    seeded_user.recovery_token_expires = datetime.now(timezone.utc) - timedelta(minutes=5)
    await db_session.commit()

    resp = await client.post(
        "/api/auth/reset-password",
        json={"token": fake_token, "new_password": "newpass-123"},
    )
    assert resp.status_code == 400

    # The expired token row should ALSO be cleared as a side effect.
    await db_session.refresh(seeded_user)
    assert seeded_user.recovery_token_hash is None


# ---------------------------------------------------------------------
# Anti-enumeration — three cases must look identical
# ---------------------------------------------------------------------


async def test_forgot_password_nonexistent_user_returns_200(client):
    logout()
    resp = await client.post(
        "/api/auth/forgot-password",
        json={"user_id": "@ghost:test.local"},
    )
    assert resp.status_code == 200
    assert "message" in resp.json()


async def test_forgot_password_user_without_recovery_email_returns_200(
    client, db_session
):
    """User exists but has no recovery email on file — still 200."""
    user = User(user_id="@noemail:test.local", recovery_email=None)
    db_session.add(user)
    await db_session.commit()

    logout()
    resp = await client.post(
        "/api/auth/forgot-password",
        json={"user_id": "@noemail:test.local"},
    )
    assert resp.status_code == 200
    assert "message" in resp.json()
