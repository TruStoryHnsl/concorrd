"""INS-028 GitHub bug report integration — test suite.

Covers the two-phase persistence model introduced by the
`docs/donation-model-decision` crash-reporting resolution:

    1. Local DB row is the source of truth — bug reports must be
       atomically persisted to `bug_reports` regardless of what
       happens on the GitHub side.

    2. The GitHub mirror is BEST-EFFORT — any failure (token unset,
       network error, non-201 response, malformed JSON, missing
       `number` field) must degrade gracefully: the helper returns
       None, the handler keeps the DB row, the user still sees
       "Report submitted". No exception must escape
       `_create_github_issue_for_bug_report` into the request
       handler — partial failure of a background mirror must not
       fail the user-facing POST.

The tests are split in two halves:

  - **Unit tests** against the helper function directly, covering
    every documented failure mode plus the happy path. These use a
    monkeypatched `httpx.AsyncClient` via a tiny fake so we can
    exercise the helper's branch logic without hitting the network.

  - **Integration tests** against the full `POST /api/reports`
    handler via the in-process ASGI client, which verify that the
    helper's return value is correctly wired into the DB row and
    the admin list endpoint.

Privacy invariant tested: the GitHub issue body must NOT contain
`system_info` data (userAgent, URL, voice state, etc.) — only the
user-supplied title and description. This protects against leaking
client fingerprinting metadata to a public GitHub repo.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import pytest
from sqlalchemy import select

import routers.admin as admin_module
from models import BugReport

from .conftest import login_as


# ---------------------------------------------------------------------
# Fake httpx transport for unit tests of _create_github_issue_*
# ---------------------------------------------------------------------


class _FakeResponse:
    """Minimal stand-in for `httpx.Response` exposing only the
    surface our code path touches (`status_code`, `text`, `json()`)."""

    def __init__(
        self,
        status_code: int,
        json_data: Any | None = None,
        text: str = "",
        raise_on_json: bool = False,
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.text = text
        self._raise_on_json = raise_on_json

    def json(self) -> Any:
        if self._raise_on_json:
            raise ValueError("response is not valid JSON")
        return self._json_data


class _FakeAsyncClient:
    """Drop-in async context manager mimicking `httpx.AsyncClient`.

    Accepts either a `_FakeResponse` to return from `.post()` or an
    `Exception` instance to raise from `.post()`. Ignores constructor
    arguments (timeout etc.) so the test can monkeypatch
    `httpx.AsyncClient` directly.
    """

    # Module-level slot that tests set before each run. Tuple of
    # (response_or_exception, captured_calls_list). Using a class
    # attribute rather than an instance arg so the monkeypatched
    # constructor can be a bare `lambda **kw: _FakeAsyncClient()`.
    _next_response: _FakeResponse | Exception | None = None
    _captured_calls: list[dict[str, Any]] = []

    def __init__(self, **_kwargs: Any) -> None:
        # Discard constructor kwargs (timeout=10.0 etc.).
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        return None

    async def post(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: Any = None,
    ) -> _FakeResponse:
        _FakeAsyncClient._captured_calls.append(
            {"url": url, "headers": headers or {}, "json": json}
        )
        resp = _FakeAsyncClient._next_response
        if isinstance(resp, Exception):
            raise resp
        assert resp is not None, "test forgot to set _FakeAsyncClient._next_response"
        return resp


@pytest.fixture
def fake_httpx(monkeypatch: pytest.MonkeyPatch) -> type[_FakeAsyncClient]:
    """Monkeypatch `routers.admin.httpx.AsyncClient` with a fake.

    Returns the fake class so tests can set its `_next_response`
    directly and inspect `_captured_calls` after the handler runs.
    Every test starts with a fresh captured-calls list.
    """
    _FakeAsyncClient._next_response = None
    _FakeAsyncClient._captured_calls = []
    monkeypatch.setattr(admin_module.httpx, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


# ---------------------------------------------------------------------
# Unit tests — _create_github_issue_for_bug_report helper
# ---------------------------------------------------------------------


async def test_helper_skips_when_token_unset(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """With GITHUB_BUG_REPORT_TOKEN empty, the helper returns None
    immediately and never touches httpx. Logs at INFO level (not
    WARN) because "token unset" is a deliberate disabled-state, not
    a failure."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "")
    caplog.set_level(logging.INFO, logger="routers.admin")

    result = await admin_module._create_github_issue_for_bug_report(
        "Test", "Body", 42
    )

    assert result is None
    assert fake_httpx._captured_calls == []
    assert any(
        "GITHUB_BUG_REPORT_TOKEN unset" in record.message for record in caplog.records
    )


async def test_helper_success_returns_issue_number(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
) -> None:
    """Happy path: httpx returns 201 with a JSON body containing
    `number: 1234`. Helper returns 1234 and logs the success."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake_token")
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_REPO", "Test/repo")
    fake_httpx._next_response = _FakeResponse(
        status_code=201,
        json_data={"number": 1234, "html_url": "https://example"},
    )

    result = await admin_module._create_github_issue_for_bug_report(
        "Voice breaks on iOS", "Audio cuts out when backgrounding", 7
    )

    assert result == 1234
    assert len(fake_httpx._captured_calls) == 1
    call = fake_httpx._captured_calls[0]
    assert call["url"] == "https://api.github.com/repos/Test/repo/issues"
    assert call["headers"]["Authorization"] == "Bearer ghp_fake_token"
    assert call["headers"]["X-GitHub-Api-Version"] == "2022-11-28"
    # Architectural privacy invariant: the helper's signature does not
    # accept system_info as an argument, so by construction it cannot
    # appear in the issue body. The test for "no PII leak" belongs in
    # the integration test below (where system_info IS submitted to
    # the handler, and we verify it doesn't reach the captured POST).
    # Here we only verify the body preserves what was passed in.
    assert "Audio cuts out when backgrounding" in call["json"]["body"]
    assert call["json"]["title"] == "Voice breaks on iOS"
    assert "bug" in call["json"]["labels"]
    assert "user-report" in call["json"]["labels"]


async def test_helper_returns_none_on_non_201(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 401 Unauthorized (or any non-201) response must yield None
    and a WARN log, not an exception. Simulates a revoked PAT."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_revoked")
    fake_httpx._next_response = _FakeResponse(
        status_code=401,
        text='{"message":"Bad credentials"}',
    )
    caplog.set_level(logging.WARNING, logger="routers.admin")

    result = await admin_module._create_github_issue_for_bug_report(
        "Test", "Body", 9
    )

    assert result is None
    assert any(
        "returned 401" in record.message and record.levelname == "WARNING"
        for record in caplog.records
    )


async def test_helper_returns_none_on_network_error(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """httpx.ConnectError (e.g. GitHub unreachable, DNS failure) must
    be caught and turned into a None return with a WARN log. No
    exception may escape into the handler."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = httpx.ConnectError("connection refused")
    caplog.set_level(logging.WARNING, logger="routers.admin")

    result = await admin_module._create_github_issue_for_bug_report(
        "Test", "Body", 11
    )

    assert result is None
    assert any(
        "request failed (ConnectError)" in record.message
        for record in caplog.records
    )


async def test_helper_returns_none_on_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """201 with a body that fails to parse as JSON returns None."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = _FakeResponse(
        status_code=201, raise_on_json=True
    )
    caplog.set_level(logging.WARNING, logger="routers.admin")

    result = await admin_module._create_github_issue_for_bug_report(
        "Test", "Body", 12
    )

    assert result is None
    assert any("not valid JSON" in record.message for record in caplog.records)


async def test_helper_returns_none_on_missing_number_field(
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """201 with a well-formed but unexpected JSON shape (no `number`
    field, or a string where an integer is expected) must return
    None rather than persist a nonsense value."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = _FakeResponse(
        status_code=201,
        json_data={"html_url": "https://example", "number": "not-an-int"},
    )
    caplog.set_level(logging.WARNING, logger="routers.admin")

    result = await admin_module._create_github_issue_for_bug_report(
        "Test", "Body", 13
    )

    assert result is None
    assert any(
        "missing integer 'number' field" in record.message
        for record in caplog.records
    )


# ---------------------------------------------------------------------
# Integration tests — full POST /api/reports handler
# ---------------------------------------------------------------------


async def test_submit_persists_db_row_without_github_token(
    client: httpx.AsyncClient,
    db_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
) -> None:
    """End-to-end: POST /api/reports with no GitHub token writes the
    DB row and returns 200 with no github_issue_number persisted."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "")
    login_as("@alice:test.local")

    resp = await client.post(
        "/api/reports",
        json={
            "title": "Offline test",
            "description": "GitHub mirror disabled in this env",
        },
    )
    assert resp.status_code == 200
    report_id = resp.json()["id"]

    row = (
        await db_session.execute(select(BugReport).where(BugReport.id == report_id))
    ).scalar_one()
    assert row.title == "Offline test"
    assert row.github_issue_number is None
    assert fake_httpx._captured_calls == []


async def test_submit_persists_issue_number_on_github_success(
    client: httpx.AsyncClient,
    db_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
) -> None:
    """POST /api/reports with a token and a 201 GitHub response
    persists the returned issue number onto the DB row."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = _FakeResponse(
        status_code=201, json_data={"number": 777}
    )
    login_as("@alice:test.local")

    resp = await client.post(
        "/api/reports",
        json={
            "title": "Charts break on mobile",
            "description": "Pie chart renders as blank on iOS Safari",
            "system_info": '{"userAgent":"Safari/iPhone","url":"/chat"}',
        },
    )
    assert resp.status_code == 200
    report_id = resp.json()["id"]

    row = (
        await db_session.execute(select(BugReport).where(BugReport.id == report_id))
    ).scalar_one()
    assert row.github_issue_number == 777
    # system_info survived to the local DB...
    assert row.system_info == '{"userAgent":"Safari/iPhone","url":"/chat"}'
    # ...but did NOT leak into the GitHub issue body.
    body_sent = fake_httpx._captured_calls[0]["json"]["body"]
    assert "Safari/iPhone" not in body_sent
    assert "userAgent" not in body_sent


async def test_submit_succeeds_when_github_fails(
    client: httpx.AsyncClient,
    db_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
) -> None:
    """A GitHub API failure MUST NOT fail the user-facing POST.
    The DB row is written, the handler returns 200, and
    github_issue_number remains None."""
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = httpx.ConnectError("github.com unreachable")
    login_as("@alice:test.local")

    resp = await client.post(
        "/api/reports",
        json={
            "title": "Network test",
            "description": "GitHub API unreachable",
        },
    )
    assert resp.status_code == 200  # <-- critical: user-facing success
    report_id = resp.json()["id"]

    row = (
        await db_session.execute(select(BugReport).where(BugReport.id == report_id))
    ).scalar_one()
    assert row.github_issue_number is None  # mirror failed, row kept


async def test_admin_list_surfaces_github_issue_number(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    fake_httpx: type[_FakeAsyncClient],
) -> None:
    """The admin reports list response includes `github_issue_number`
    for rows that have it, and None for rows that don't. The admin
    UI depends on this field to render the 'View on GitHub' link."""
    # First submit without token → row with None
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "")
    login_as("@alice:test.local")
    await client.post(
        "/api/reports",
        json={"title": "Pre-token", "description": "Before token was set"},
    )

    # Now submit with token + successful mirror → row with number
    monkeypatch.setattr(admin_module, "GITHUB_BUG_REPORT_TOKEN", "ghp_fake")
    fake_httpx._next_response = _FakeResponse(
        status_code=201, json_data={"number": 9001}
    )
    await client.post(
        "/api/reports",
        json={"title": "Post-token", "description": "After token was set"},
    )

    # Switch to an admin account and fetch the list.
    login_as("@test_admin:test.local")
    resp = await client.get("/api/admin/reports")
    assert resp.status_code == 200
    reports = resp.json()
    assert len(reports) == 2

    by_title = {r["title"]: r for r in reports}
    assert by_title["Pre-token"]["github_issue_number"] is None
    assert by_title["Post-token"]["github_issue_number"] == 9001
