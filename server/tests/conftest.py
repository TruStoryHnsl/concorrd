"""Shared pytest fixtures for the concord server test suite.

## Design notes

### Why env vars are set at MODULE IMPORT time
`server/config.py` raises `RuntimeError` at import time if
`CONDUWUIT_REGISTRATION_TOKEN` is not set, and it `mkdir`s
`CONCORD_DATA_DIR` at import time too. That means we MUST set those
env vars BEFORE the test runner imports anything from `server/`. Doing
it in a fixture (even a session-scoped one) is too late — by the time
the fixture runs, pytest has already collected the test modules, which
transitively imported `config.py` and either crashed or pointed at the
wrong data dir.

Putting the env-var assignment at the top of `conftest.py` works
because pytest imports `conftest.py` BEFORE collecting test files.

### Why one DB per test (function-scoped)
The feedback memory `feedback_tests_gate_pillars.md` says tests are a
cost-saving measure for agents — so they need to be fast AND reliable.
A fresh SQLite file per test eliminates cross-test contamination
entirely: one test can't pollute another, failures are reproducible,
and parallelism (via pytest-xdist) works without careful ordering.
The cost is ~5ms per test for schema creation against a tmpfs sqlite
file, which is invisible at the scale we're operating.

### Why we override get_user_id via dependency_overrides
`routers/servers.get_user_id` makes a real HTTP call to the Matrix
homeserver. We don't want tests making outbound HTTP. FastAPI's
`app.dependency_overrides` mechanism replaces the dependency
in-place — cleaner and more localised than monkeypatching httpx.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------
# Module-level env setup. Must run BEFORE any `from server.* import`.
# ---------------------------------------------------------------------

# Isolated data dir for every test run. Using a module-level tempdir
# (not a fixture) because config.py mkdir's this at import time.
_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="concord-tests-"))

os.environ.setdefault("CONCORD_DATA_DIR", str(_TEST_DATA_DIR))
os.environ.setdefault("CONDUWUIT_REGISTRATION_TOKEN", "test-token-do-not-use-in-prod")
os.environ.setdefault("CONDUWUIT_SERVER_NAME", "test.local")
os.environ.setdefault("MATRIX_HOMESERVER_URL", "http://unused-in-tests.invalid")
os.environ.setdefault("ADMIN_USER_IDS", "@test_admin:test.local")
os.environ.setdefault("TUWUNEL_CONFIG_PATH", str(_TEST_DATA_DIR / "tuwunel.toml"))
os.environ.setdefault("CONCORD_LOG_LEVEL", "WARNING")  # quiet test output

# LiveKit tokens module also raises at import time if these are unset.
# The values don't need to be real — nothing in the tests exercises
# LiveKit signing — they just need to be present and non-empty.
os.environ.setdefault("LIVEKIT_API_KEY", "test-livekit-key")
os.environ.setdefault("LIVEKIT_API_SECRET", "test-livekit-secret-at-least-32-chars")
os.environ.setdefault("LIVEKIT_URL", "ws://livekit.invalid:7880")

# Make the server package importable when pytest is run from the repo
# root (otherwise `from main import app` fails because `server/` isn't
# on sys.path).
import sys
_SERVER_DIR = Path(__file__).resolve().parent.parent
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))

# ---------------------------------------------------------------------
# Now safe to import server code.
# ---------------------------------------------------------------------

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession  # noqa: E402

from main import app  # noqa: E402
import database  # noqa: E402 — we monkey-patch the engine below
from database import Base  # noqa: E402
from dependencies import get_user_id, get_access_token  # noqa: E402


# ---------------------------------------------------------------------
# Per-test database isolation.
# ---------------------------------------------------------------------

@pytest.fixture
async def db_engine(tmp_path):
    """Fresh SQLite DB file per test, schema created, engine disposed after.

    Also swaps `database.engine` and `database.async_session` in-place so
    the production `get_db` dependency uses the test DB. This is
    necessary because many routers do `from database import get_db` and
    we can't easily override per-route — it's simpler to point the
    module-level session factory at the test DB for the duration of the
    test.
    """
    db_path = tmp_path / "test.db"
    test_engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", echo=False)
    test_session_factory = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )

    # Create all tables.
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Swap the module-level engine / session factory so that any code
    # path calling `get_db()` (via FastAPI dep injection) uses our test
    # DB. We keep references to the originals so we can restore after.
    original_engine = database.engine
    original_session = database.async_session
    database.engine = test_engine
    database.async_session = test_session_factory

    try:
        yield test_engine
    finally:
        database.engine = original_engine
        database.async_session = original_session
        await test_engine.dispose()


@pytest.fixture
async def db_session(db_engine) -> AsyncSession:
    """Convenience: a pre-opened AsyncSession for tests that need to
    insert fixtures directly before hitting HTTP endpoints."""
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


# ---------------------------------------------------------------------
# HTTP client against the in-process FastAPI app.
# ---------------------------------------------------------------------

@pytest.fixture
async def client(db_engine) -> AsyncClient:
    """httpx.AsyncClient wired to the FastAPI app via ASGI transport.

    No real sockets, no real Matrix homeserver. Depends on db_engine so
    every request sees the per-test database.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as ac:
        yield ac
    # Clear any per-test dependency overrides once the client is done,
    # so tests that forget to clean up don't leak into the next one.
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------
# Auth helpers.
# ---------------------------------------------------------------------

def login_as(user_id: str) -> None:
    """Override the get_user_id / get_access_token deps for the current
    test so any authenticated endpoint treats the caller as `user_id`.

    Usage:
        async def test_foo(client):
            login_as("@alice:test.local")
            resp = await client.post("/api/some-endpoint", ...)
    """
    app.dependency_overrides[get_user_id] = lambda: user_id
    app.dependency_overrides[get_access_token] = lambda: "fake-token-for-tests"


def logout() -> None:
    """Remove auth overrides so subsequent requests will hit the real
    Matrix-check codepath (and fail, which is what we want for
    401/403 tests)."""
    app.dependency_overrides.pop(get_user_id, None)
    app.dependency_overrides.pop(get_access_token, None)
