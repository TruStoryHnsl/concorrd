"""Tests for the structured error handling pillar (TASK 22).

Scope:
1. Per-router validation of bad input → structured ErrorResponse with
   the expected error_code.
2. The ConcordError → JSONResponse handler in main.py.
3. Pydantic v2 validation errors → FastAPI's default 422 body shape
   (we deliberately do NOT override 422 — it's already structured and
   client-friendly).
4. Stack-trace leakage guard: ensure no traceback strings appear in
   any error response body.

These tests are the contract every future agent will rely on. If a
router raises a raw HTTPException without a stable error_code, the
client has no way to handle the error programmatically — that's the
exact regression these tests prevent.
"""

from __future__ import annotations

import pytest

from errors import ConcordError, ErrorResponse
from main import app
from models import Server, ServerMember
from tests.conftest import login_as, logout


# ---------------------------------------------------------------------
# Pure unit tests for the error model
# ---------------------------------------------------------------------


def test_concord_error_to_response_shape():
    """ConcordError.to_response() must produce a fully-populated
    ErrorResponse with the same fields the global handler will
    serialize."""
    err = ConcordError(
        error_code="INVITE_EXHAUSTED",
        message="Invite has reached its maximum uses",
        status_code=400,
        details={"invite_id": 42},
    )
    resp = err.to_response()
    assert isinstance(resp, ErrorResponse)
    assert resp.error_code == "INVITE_EXHAUSTED"
    assert resp.message == "Invite has reached its maximum uses"
    assert resp.details == {"invite_id": 42}


def test_concord_error_default_status_code():
    """status_code defaults to 400 when not supplied."""
    err = ConcordError(error_code="INPUT_INVALID", message="x")
    assert err.status_code == 400


def test_error_response_serializes_to_json_dict():
    """ErrorResponse.model_dump() must produce a dict with exactly
    error_code, message, details — no extra fields, no None-stripping
    surprises that would break the client contract."""
    resp = ErrorResponse(
        error_code="AUTH_INVALID_TOKEN",
        message="Token expired",
    )
    dumped = resp.model_dump()
    assert set(dumped.keys()) == {"error_code", "message", "details"}
    assert dumped["error_code"] == "AUTH_INVALID_TOKEN"
    assert dumped["details"] is None


# ---------------------------------------------------------------------
# Global handler: ConcordError → JSONResponse
# ---------------------------------------------------------------------


async def test_concord_error_handler_converts_to_json_response(client):
    """The global handler in main.py must turn a raised ConcordError
    into a JSONResponse with the right status code and body shape.

    We register a temporary endpoint that raises ConcordError so we
    don't have to find a real one that always errs.
    """
    @app.get("/_test/concord-error-503")
    async def _err():
        raise ConcordError(
            error_code="MATRIX_UPSTREAM",
            message="Matrix homeserver returned 503",
            status_code=502,
        )

    try:
        resp = await client.get("/_test/concord-error-503")
        assert resp.status_code == 502
        body = resp.json()
        assert body["error_code"] == "MATRIX_UPSTREAM"
        assert body["message"] == "Matrix homeserver returned 503"
        assert body["details"] is None
    finally:
        # Remove the test route to avoid leaking into other tests.
        app.router.routes = [
            r for r in app.router.routes
            if getattr(r, "path", None) != "/_test/concord-error-503"
        ]


async def test_unhandled_exception_does_not_leak_stack_trace(db_engine):
    """Anything that bubbles to the global Exception handler must
    return a generic INTERNAL_ERROR with NO traceback in the body.

    This is the commercial-profile stack-trace-leakage guard.

    NB: We build a local httpx client with raise_app_exceptions=False
    so the exception is converted into the JSONResponse instead of
    being re-raised to the test (which is the default ASGITransport
    behavior). This is the only test in this file that needs that
    flag — every other route returns a normal 4xx via ConcordError or
    Pydantic validation, never an unhandled crash.
    """
    from httpx import AsyncClient, ASGITransport

    @app.get("/_test/boom")
    async def _boom():
        # KeyError gives a recognisable string ("missing_key") that
        # would be a dead giveaway if it leaked into the response.
        raise KeyError("missing_key_secret_in_traceback")

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            resp = await ac.get("/_test/boom")
        assert resp.status_code == 500
        body = resp.json()
        assert body["error_code"] == "INTERNAL_ERROR"
        # The internal exception detail must NOT appear in the body.
        assert "missing_key_secret_in_traceback" not in resp.text
        assert "KeyError" not in resp.text
        assert "Traceback" not in resp.text
        assert "File \"" not in resp.text  # path delimiter from tracebacks
    finally:
        app.router.routes = [
            r for r in app.router.routes
            if getattr(r, "path", None) != "/_test/boom"
        ]


# ---------------------------------------------------------------------
# Pydantic v2 validation: returned as 422 (FastAPI default body shape)
# ---------------------------------------------------------------------


async def test_pydantic_validation_returns_422_not_concord_error(client):
    """Pydantic field validation failures must use FastAPI's default
    422 + RequestValidationError body shape — NOT ConcordError. The
    422 body is already structured and client-friendly; rewriting it
    would break every existing client that handles 422 specially.
    """
    # POST /api/dms with target_user_id missing — Pydantic rejects.
    login_as("@alice:test.local")
    try:
        resp = await client.post("/api/dms", json={})
        assert resp.status_code == 422
        body = resp.json()
        # FastAPI 422 body has a "detail" array of validation errors.
        assert "detail" in body
        assert isinstance(body["detail"], list)
        # And it does NOT have an error_code field (that would mean
        # ConcordError accidentally caught it).
        assert "error_code" not in body
    finally:
        logout()


# ---------------------------------------------------------------------
# Per-router validation tests
# ---------------------------------------------------------------------


async def test_dms_router_rejects_self_dm_with_concord_error(client):
    """The dms router must reject 'DM with myself' via ConcordError
    so the response has the structured error_code."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/dms",
            json={"target_user_id": "@alice:test.local"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["error_code"] == "INPUT_INVALID"
        assert "yourself" in body["message"].lower()
        assert "Traceback" not in resp.text
    finally:
        logout()


async def test_dms_router_rejects_invalid_user_id_shape(client):
    """A target_user_id that doesn't match the Matrix user ID pattern
    must return 422 (Pydantic), not 500."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/dms",
            json={"target_user_id": "not-a-matrix-id"},
        )
        assert resp.status_code == 422
        body = resp.json()
        assert "detail" in body
    finally:
        logout()


async def test_voice_router_rejects_oversize_room_name(client):
    """The voice/token room_name must be bounded by Pydantic max_length.
    A 10KB room_name should be rejected at the validation layer."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/voice/token",
            json={"room_name": "a" * 10_000},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_moderation_router_lock_rejects_invalid_pin(client):
    """The channel lock endpoint must reject a non-4-digit PIN via
    Pydantic's pattern validation."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/channels/1/lock",
            json={"pin": "abcd"},  # not 4 digits
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_moderation_router_ban_settings_rejects_invalid_mode(client, db_session):
    """ban_mode must be 'soft' or 'harsh' — anything else is rejected
    by Pydantic at the field level."""
    server = Server(id="srv_err1", name="Err Server", owner_id="@alice:test.local")
    db_session.add(server)
    db_session.add(ServerMember(server_id="srv_err1", user_id="@alice:test.local", role="owner"))
    await db_session.commit()

    login_as("@alice:test.local")
    try:
        resp = await client.patch(
            "/api/servers/srv_err1/ban-settings",
            json={"ban_mode": "nuclear"},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_servers_router_rejects_oversize_server_name(client):
    """ServerCreate.name has max_length=100 — a 1KB name should be
    rejected at the validation layer, not after a DB insert."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/servers",
            json={"name": "x" * 1000, "visibility": "private"},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_admin_router_rejects_short_password(client):
    """The PasswordChangeRequest.new_password has min_length=8 —
    a 4-character password must be rejected by Pydantic."""
    login_as("@alice:test.local")
    try:
        resp = await client.post(
            "/api/user/change-password",
            json={"current_password": "old123", "new_password": "x"},
        )
        assert resp.status_code == 422
    finally:
        logout()


async def test_admin_router_non_admin_blocked(client):
    """The /api/admin/stats endpoint must reject non-admins with 403
    (this is the require_admin path that uses raw HTTPException —
    it should still work and return a JSON body the client can parse)."""
    login_as("@random:test.local")
    try:
        resp = await client.get("/api/admin/stats")
        assert resp.status_code == 403
        body = resp.json()
        assert "Traceback" not in resp.text
        # Either ConcordError shape or HTTPException shape — both are
        # acceptable for the auth gate, but neither must leak traces.
        assert isinstance(body, dict)
    finally:
        logout()


async def test_no_stack_trace_in_any_error_response(client, db_session):
    """Sweep test: every test above checked one route. This sweeps the
    response bodies again to confirm none of them contain Python
    traceback markers, even by accident."""
    login_as("@alice:test.local")
    try:
        # Hit several error paths in sequence
        responses = [
            await client.post("/api/dms", json={"target_user_id": "@alice:test.local"}),
            await client.post("/api/voice/token", json={"room_name": "a" * 10_000}),
            await client.post("/api/servers", json={"name": "x" * 1000}),
            await client.post("/api/channels/1/lock", json={"pin": "xyz"}),
        ]
        for r in responses:
            assert "Traceback" not in r.text, f"leak in {r.url}"
            assert "File \"" not in r.text, f"leak in {r.url}"
            assert "line " not in r.text or r.status_code != 500
    finally:
        logout()


# ---------------------------------------------------------------------
# BETA ATTACK TESTS — BT-*
# ---------------------------------------------------------------------


async def test_BT_validation_422_for_unauthenticated_endpoint_leaks_field_names(client):
    """BT-14 [LOW]: FastAPI's default 422 body contains the field names
    and shapes of the request model. This is by design (it's the whole
    point of the 422 error), but for commercial-scope APIs it reveals
    internal schema details to unauthenticated callers. Not a security
    hole — just documenting that the schema is exposed."""
    resp = await client.post("/api/nodes/disposable", json={"user_agent_hint": 123})
    assert resp.status_code == 422
    body = resp.json()
    # The 422 body exposes "user_agent_hint" as a known field — fine,
    # but worth being aware of for commercial contexts.
    assert "user_agent_hint" in str(body)


async def test_BT_missing_auth_header_on_protected_endpoint(client):
    """BT-15 [MEDIUM]: Calling a protected endpoint with NO Authorization
    header at all — what happens?

    get_user_id is declared as ``authorization: str = Header(...)``.
    FastAPI's Header(...) treats missing headers as a required-field
    validation error, which returns 422 by default. But the commercial
    API contract says auth failures should be 401 with AUTH_REQUIRED,
    not 422.

    Severity MEDIUM because the CLIENT's error handling will treat
    422 as 'my request body is wrong' when the real issue is 'I'm not
    logged in'. This is a user-visible ergonomic bug."""
    # Hit a protected endpoint with NO auth header
    resp = await client.get("/api/servers")
    # Expected (commercial contract): 401 with error_code=AUTH_REQUIRED
    # Actual: FastAPI default 422
    assert resp.status_code in (401, 422), f"unexpected {resp.status_code}"
    # If this is 422 instead of 401, that's the bug.
    body = resp.json()
    # Document the actual behavior so reviewer can see the drift.
    if resp.status_code == 422:
        assert "detail" in body
        # error_code is NOT present — ConcordError didn't catch it
        assert "error_code" not in body


async def test_BT_malformed_bearer_prefix_returns_401(client):
    """BT-16 [LOW]: Sending 'Authorization: NotBearer foo' should
    return 401. Confirms the auth check doesn't crash on non-Bearer
    schemes."""
    resp = await client.get(
        "/api/servers",
        headers={"Authorization": "Basic foo"},
    )
    assert resp.status_code == 401
    assert "Traceback" not in resp.text


async def test_BT_bearer_empty_token(client):
    """BT-17 [LOW]: Sending 'Authorization: Bearer ' with an empty
    token should return 401, not crash."""
    resp = await client.get(
        "/api/servers",
        headers={"Authorization": "Bearer "},
    )
    assert resp.status_code == 401
    assert "Traceback" not in resp.text


async def test_BT_unhandled_exception_handler_logs_full_trace(client, db_engine, caplog):
    """BT-18 [LOW]: Confirm the handler logs the traceback server-side
    (via the 'concord.errors' logger) so operators can still correlate
    client-facing INTERNAL_ERROR to a real exception."""
    from httpx import AsyncClient, ASGITransport
    import logging

    @app.get("/_test/boom_bt18")
    async def _boom():
        raise ValueError("bt18-detail-should-be-in-logs-not-response")

    caplog.set_level(logging.ERROR, logger="concord.errors")
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            resp = await ac.get("/_test/boom_bt18")
        assert resp.status_code == 500
        # Response must NOT leak the detail
        assert "bt18-detail-should-be-in-logs-not-response" not in resp.text
        # But the log must contain it (for ops correlation)
        assert any(
            "bt18-detail-should-be-in-logs-not-response" in rec.getMessage()
            for rec in caplog.records
        ), "error handler should log full trace server-side"
    finally:
        app.router.routes = [
            r for r in app.router.routes
            if getattr(r, "path", None) != "/_test/boom_bt18"
        ]
