"""INS-071 Phase A — admin-blind privacy invariants (LOAD-BEARING).

Every test here is part of the privacy contract for INS-071. They MUST
all pass for the feature to be considered shippable. A regression in any
one of them means the recovery_email column has leaked through an API
surface and a code reviewer has to find where.

The contract:
  - NO API endpoint returns the ``recovery_email`` column.
  - The status endpoint returns ONLY a boolean, never the value.
  - Admin endpoints (users / reports / search) do not even contain the
    string ``"recovery_email"`` in their response bodies.
  - No Pydantic response model in the entire ``server/routers/`` package
    has a field named exactly ``recovery_email``.
  - The forgot-password / reset-password bodies do not echo the email.
  - The forgot-password endpoint is anti-enumeration (identical body
    shape across all three: real user with email, real user without
    email, nonexistent user).
  - Only the self-service ``PUT /api/user/recovery-email`` endpoint can
    write the column — no admin endpoint accepts it.
"""
from __future__ import annotations

import importlib
import inspect
import pkgutil
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import BaseModel

from models import BugReport, ServerMember, User
from services import email as email_service
from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _smtp_configured(monkeypatch):
    monkeypatch.setattr(email_service, "SMTP_HOST", "smtp.example.invalid")
    monkeypatch.setattr(email_service, "SMTP_FROM", "noreply@example.invalid")
    monkeypatch.setattr(email_service, "SITE_URL", "https://example.invalid")


@pytest.fixture
async def admin_with_recovery_users(db_session) -> str:
    """Create:
      - a global admin user (matches conftest.py ADMIN_USER_IDS),
      - two regular users with recovery emails set,
      - matching ServerMember rows so they show up in /api/admin/users.

    Returns the admin's user_id so tests can ``login_as`` them.
    """
    admin_id = "@test_admin:test.local"
    # ServerMember rows make the users visible in /api/admin/users.
    # We need a server row first, but the simplest route is to insert a
    # ServerMember tied to a fake server_id and accept the orphan FK —
    # SQLite without FK enforcement permits it.
    db_session.add(ServerMember(server_id="srv_fake", user_id=admin_id, role="admin"))
    db_session.add(
        ServerMember(server_id="srv_fake", user_id="@victim1:test.local", role="member")
    )
    db_session.add(
        ServerMember(server_id="srv_fake", user_id="@victim2:test.local", role="member")
    )
    db_session.add(
        User(user_id="@victim1:test.local", recovery_email="leaky1@example.com")
    )
    db_session.add(
        User(user_id="@victim2:test.local", recovery_email="leaky2@example.com")
    )
    await db_session.commit()
    return admin_id


# ---------------------------------------------------------------------
# 1. /api/admin/users omits recovery_email
# ---------------------------------------------------------------------


async def test_admin_users_endpoint_omits_recovery_email(
    client, admin_with_recovery_users
):
    login_as(admin_with_recovery_users)
    resp = await client.get("/api/admin/users")
    assert resp.status_code == 200
    body_text = resp.text
    # The literal column name MUST NOT appear.
    assert "recovery_email" not in body_text
    # Neither should any of the actual email values.
    assert "leaky1@example.com" not in body_text
    assert "leaky2@example.com" not in body_text


# ---------------------------------------------------------------------
# 2. /api/user/recovery-email-status omits the actual email
# ---------------------------------------------------------------------


async def test_user_recovery_email_status_omits_actual_email(client, db_session):
    user_id = "@alice:test.local"
    db_session.add(User(user_id=user_id, recovery_email="alice@super-secret.invalid"))
    await db_session.commit()

    login_as(user_id)
    resp = await client.get("/api/user/recovery-email-status")
    assert resp.status_code == 200
    body_text = resp.text
    assert "has_recovery_email" in body_text
    # Hard invariant: zero @ characters in the response body. The
    # boolean shape never legitimately contains one.
    assert "@" not in body_text
    assert "super-secret" not in body_text
    assert "recovery_email\":" in body_text  # the JSON key prefix is present
    # But the value-shape `recovery_email":"<addr>` MUST NOT be.
    assert '"recovery_email":"' not in body_text


# ---------------------------------------------------------------------
# 3. /api/admin/reports omits recovery_email
# ---------------------------------------------------------------------


async def test_admin_reports_omits_recovery_email(client, db_session, admin_with_recovery_users):
    # Drop in a bug report so the response isn't empty.
    db_session.add(
        BugReport(
            reported_by="@victim1:test.local",
            title="t",
            description="d",
        )
    )
    await db_session.commit()

    login_as(admin_with_recovery_users)
    resp = await client.get("/api/admin/reports")
    assert resp.status_code == 200
    body_text = resp.text
    assert "recovery_email" not in body_text
    assert "leaky1@example.com" not in body_text


# ---------------------------------------------------------------------
# 4. User search — N/A (no /api/users/search endpoint exists)
# ---------------------------------------------------------------------


async def test_user_search_omits_recovery_email(client, admin_with_recovery_users):
    """If a user-search endpoint exists, its body must not contain
    ``recovery_email``. If not, this test is vacuously true.

    As of INS-071 Phase A there is no ``/api/users/search`` endpoint in
    the concord server. We probe and skip-or-pass accordingly so the
    test fails the moment such an endpoint is introduced *without* the
    invariant being checked at the same time.
    """
    login_as(admin_with_recovery_users)
    resp = await client.get("/api/users/search", params={"q": "victim"})
    if resp.status_code == 404:
        pytest.skip("No /api/users/search endpoint (vacuous N/A)")
    body_text = resp.text
    assert "recovery_email" not in body_text
    assert "leaky" not in body_text


# ---------------------------------------------------------------------
# 5. Reflection: no Pydantic response model has a recovery_email field
# ---------------------------------------------------------------------


def _all_router_pydantic_models():
    """Walk every module under ``routers/`` and yield each Pydantic model.

    Importing a router module side-effects-includes its dependencies, so
    by the end of the walk we have every router-declared response model
    in the registry. We deliberately reach into ``BaseModel.model_fields``
    rather than ``__fields__`` because pydantic v2 deprecated the latter.
    """
    import routers as routers_pkg

    for mod_info in pkgutil.iter_modules(routers_pkg.__path__):
        full_name = f"routers.{mod_info.name}"
        try:
            mod = importlib.import_module(full_name)
        except Exception:
            # A module that fails to import here would already have
            # failed at app startup — nothing for us to do but skip.
            continue
        for _, obj in inspect.getmembers(mod):
            if (
                inspect.isclass(obj)
                and issubclass(obj, BaseModel)
                and obj is not BaseModel
            ):
                yield full_name, obj


def test_pydantic_response_models_have_no_recovery_email_field():
    """No Pydantic model used as a *response* shape may have a field
    named ``recovery_email``.

    Identification of "response model" is by route inspection: we walk
    the FastAPI app's routes and collect every model declared as
    ``response_model=`` or that the endpoint's return-type annotation
    points to. Request-body models (``BaseModel`` subclasses passed
    *as parameters*) are explicitly OUT OF SCOPE — there has to be
    SOME way for the user to PUT their own recovery email, and that
    write surface is the one legitimate carrier of the field name.
    The contract being tested is "the column never travels back out
    of the server in a response."
    """
    from main import app

    response_models: set[type[BaseModel]] = set()

    def _collect(ann):
        # Recurse into Optional / Union / list[…] generics.
        if ann is None:
            return
        if inspect.isclass(ann) and issubclass(ann, BaseModel):
            response_models.add(ann)
            return
        for arg in getattr(ann, "__args__", ()) or ():
            _collect(arg)

    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        if endpoint is None:
            continue
        # Explicit response_model wins over the return annotation.
        rm = getattr(route, "response_model", None)
        if rm is not None:
            _collect(rm)
            continue
        try:
            sig = inspect.signature(endpoint)
        except (TypeError, ValueError):
            continue
        if sig.return_annotation is not inspect.Signature.empty:
            _collect(sig.return_annotation)

    offenders = [
        f"{cls.__module__}.{cls.__name__}"
        for cls in response_models
        if "recovery_email" in getattr(cls, "model_fields", {})
    ]
    assert not offenders, (
        "Pydantic response models exposing a recovery_email field break "
        f"the INS-071 admin-blind invariant: {offenders}"
    )


# ---------------------------------------------------------------------
# 6. Forgot-password response does NOT echo the email
# ---------------------------------------------------------------------


async def test_forgot_password_response_does_not_leak_email(client, db_session):
    db_session.add(
        User(user_id="@alice:test.local", recovery_email="alice@confidential.invalid")
    )
    await db_session.commit()

    logout()
    with patch("services.email.aiosmtplib.send", AsyncMock()):
        resp = await client.post(
            "/api/auth/forgot-password",
            json={"user_id": "@alice:test.local"},
        )
    assert resp.status_code == 200
    body_text = resp.text
    assert "alice@confidential.invalid" not in body_text
    assert "confidential" not in body_text
    assert "recovery_email" not in body_text


# ---------------------------------------------------------------------
# 7. Forgot-password anti-enumeration: identical body across 3 cases
# ---------------------------------------------------------------------


async def test_forgot_password_anti_enumeration(client, db_session):
    """Three cases must produce identical body shape and ~identical length:
      a) real user WITH recovery email
      b) real user WITHOUT recovery email
      c) nonexistent user
    """
    db_session.add(User(user_id="@withemail:test.local", recovery_email="x@y.z"))
    db_session.add(User(user_id="@noemail:test.local", recovery_email=None))
    await db_session.commit()

    logout()
    with patch("services.email.aiosmtplib.send", AsyncMock()):
        a = await client.post(
            "/api/auth/forgot-password", json={"user_id": "@withemail:test.local"}
        )
        b = await client.post(
            "/api/auth/forgot-password", json={"user_id": "@noemail:test.local"}
        )
        c = await client.post(
            "/api/auth/forgot-password", json={"user_id": "@nonexistent:test.local"}
        )

    for r in (a, b, c):
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"message"}

    # Identical body length across all three (within ±2 chars to allow
    # for, e.g., a future i18n hook that picks a localised string —
    # the spec says "within ±2 chars").
    lengths = [len(r.text) for r in (a, b, c)]
    assert max(lengths) - min(lengths) <= 2, lengths


# ---------------------------------------------------------------------
# 8. Reset-password endpoint does NOT echo the email
# ---------------------------------------------------------------------


async def test_reset_password_endpoint_does_not_echo_email(client, db_session):
    """Even the error path on /api/auth/reset-password must not contain
    a recovery email or recovery_email key.
    """
    db_session.add(
        User(
            user_id="@alice:test.local",
            recovery_email="alice@hidden.invalid",
        )
    )
    await db_session.commit()

    logout()
    # Unknown token → 400 with a generic error.
    resp = await client.post(
        "/api/auth/reset-password",
        json={"token": "no-such-token-value", "new_password": "newpass-123"},
    )
    assert resp.status_code == 400
    body_text = resp.text
    assert "alice@hidden.invalid" not in body_text
    assert "hidden.invalid" not in body_text
    assert "recovery_email" not in body_text


# ---------------------------------------------------------------------
# 9. Recovery email may only be set via the self-service endpoint
# ---------------------------------------------------------------------


def test_recovery_email_only_set_via_self_endpoint():
    """Reflection-only check: walk every registered route on the FastAPI
    app and assert that NO admin endpoint accepts a ``recovery_email``
    body field. Only ``PUT /api/user/recovery-email`` may.
    """
    from main import app

    # Map: (path, method) -> route. We're looking for any non-self route
    # whose declared body model includes a recovery_email field.
    self_route = ("/api/user/recovery-email", "PUT")
    offenders = []

    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None) or set()
        endpoint = getattr(route, "endpoint", None)
        if path is None or endpoint is None:
            continue
        # Inspect the endpoint signature for any Pydantic body parameter
        # that declares a recovery_email field.
        try:
            sig = inspect.signature(endpoint)
        except (TypeError, ValueError):
            continue
        for param in sig.parameters.values():
            ann = param.annotation
            if (
                inspect.isclass(ann)
                and issubclass(ann, BaseModel)
                and "recovery_email" in getattr(ann, "model_fields", {})
            ):
                for m in methods:
                    if (path, m) != self_route:
                        offenders.append(f"{m} {path} via {ann.__name__}")

    assert not offenders, (
        "Only PUT /api/user/recovery-email may accept a recovery_email "
        f"body field. Offending routes: {offenders}"
    )
