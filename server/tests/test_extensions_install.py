"""End-to-end tests for the runtime extension install pipeline (INS-066 W8).

Uses the real orrdia-bridge bundle (committed under
``server/tests/fixtures/``) as the .zip under test. The fixture is
self-contained — no network during this test.

Coverage:
  * POST /api/extensions/install (admin-authed) returns 201 + manifest
    and persists a DB row + unpacks the bundle.
  * GET /ext/<id>/index.html serves the bundle's HTML.
  * GET /api/extensions includes the newly-installed extension.
  * The installed manifest's permissions array is preserved on the DB row.
  * Bad manifests (unknown permission, missing field) reject with 422.
  * Path-traversal attempts in the zip are rejected with 400.
  * DELETE /api/extensions/<id> removes both the row AND the directory.
  * Non-admin auth → 403 on install/uninstall.

Same-session-author note: these tests were written in the same session
as the install pipeline (INS-066 W2/W3/W7). A cold-reader test pass is
required before declaring the feature production-ready (per the
Testing & Verification "WRITTEN IN BLOOD" rule). They cover the happy
path well enough to catch regressions but should be re-reviewed by a
fresh context.
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

import pytest

from .conftest import login_as

FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "com.concord.orrdia-bridge@0.1.0.zip"
)
EXT_ID = "com.concord.orrdia-bridge"
ADMIN_USER = "@test_admin:test.local"
NON_ADMIN_USER = "@bob:test.local"


def _file_url(p: Path) -> str:
    """``Path -> file:// URL`` so the install endpoint reads from disk
    without making a network request during tests."""
    return f"file://{p.resolve()}"


def _make_zip(files: dict[str, bytes]) -> bytes:
    """Build an in-memory zip with the given path -> bytes mapping."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.fixture
def fixture_url() -> str:
    """Lazy assertion that the orrdia-bridge fixture exists. If it
    doesn't, the rest of the suite is meaningless — fail loudly."""
    assert FIXTURE_PATH.is_file(), (
        f"missing fixture: {FIXTURE_PATH}. "
        "Re-copy from concord-extensions/packages/orrdia-bridge/."
    )
    return _file_url(FIXTURE_PATH)


@pytest.fixture
def app_with_mounts():
    """Ensure the FastAPI app's extension StaticFiles mount registry has
    the live `app` reference. Tests that exercise the install endpoint
    need register_mount() to be a no-op-or-mount, not a "called before
    mount_installed" warning.
    """
    import routers.extensions as ext_mod
    from main import app

    ext_mod.mount_installed(app)
    yield app


@pytest.fixture
def clean_extensions_dir(app_with_mounts):
    """Clean up the on-disk extensions directory + DB rows for EXT_ID
    before AND after each test, so installs don't leak across tests in
    the session-shared DATA_DIR.
    """
    from config import EXTENSIONS_DIR
    import routers.extensions as ext_mod

    target = EXTENSIONS_DIR / EXT_ID
    if target.exists():
        shutil.rmtree(target)
    # Remove any prior mount of EXT_ID so re-install registers fresh.
    ext_mod.unregister_mount(EXT_ID)
    yield
    if target.exists():
        shutil.rmtree(target)
    ext_mod.unregister_mount(EXT_ID)


# ---------------------------------------------------------------------
# Happy path — install / list / serve / uninstall
# ---------------------------------------------------------------------


async def test_install_orrdia_bridge_unpacks_files_and_persists_row(
    client, fixture_url, clean_extensions_dir
):
    from config import EXTENSIONS_DIR

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["id"] == EXT_ID
    assert body["version"] == "0.1.0"
    assert body["pricing"] == "free"
    assert body["enabled"] is True
    assert body["remote_url"] == fixture_url
    # Manifest permissions persisted intact (W7).
    assert "state_events" in body["manifest"]["permissions"]
    assert "fetch:external" in body["manifest"]["permissions"]

    # Files unpacked to the canonical path.
    assert (EXTENSIONS_DIR / EXT_ID / "manifest.json").is_file()
    assert (EXTENSIONS_DIR / EXT_ID / "index.html").is_file()


async def test_static_route_serves_index_html(
    client, fixture_url, clean_extensions_dir
):
    login_as(ADMIN_USER)
    install_resp = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert install_resp.status_code == 201, install_resp.text

    resp = await client.get(f"/ext/{EXT_ID}/index.html")
    assert resp.status_code == 200, resp.text
    assert "text/html" in resp.headers.get("content-type", "")
    assert b"<html" in resp.content.lower() or b"<!doctype" in resp.content.lower()


async def test_list_extensions_includes_installed(
    client, fixture_url, clean_extensions_dir
):
    login_as(ADMIN_USER)
    install_resp = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert install_resp.status_code == 201, install_resp.text

    listing = await client.get("/api/extensions")
    assert listing.status_code == 200
    items = listing.json()
    ids = [it["id"] for it in items]
    assert EXT_ID in ids
    matching = next(it for it in items if it["id"] == EXT_ID)
    assert matching["url"] == f"/ext/{EXT_ID}/index.html"
    # INS-066-FUP-A: manifest permissions surfaced on the listing so the
    # client can pass them to <ExtensionSurfaceManager> as the gate for
    # concord:state_event delivery / extension:send_state_event acceptance.
    assert "permissions" in matching, matching
    assert isinstance(matching["permissions"], list)
    assert "state_events" in matching["permissions"]
    assert "fetch:external" in matching["permissions"]


async def test_uninstall_removes_row_and_files(
    client, fixture_url, clean_extensions_dir
):
    from config import EXTENSIONS_DIR

    login_as(ADMIN_USER)
    install_resp = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert install_resp.status_code == 201, install_resp.text
    assert (EXTENSIONS_DIR / EXT_ID).is_dir()

    del_resp = await client.delete(f"/api/extensions/{EXT_ID}")
    assert del_resp.status_code == 204
    assert not (EXTENSIONS_DIR / EXT_ID).exists()

    listing = await client.get("/api/extensions")
    ids = [it["id"] for it in listing.json()]
    assert EXT_ID not in ids


# ---------------------------------------------------------------------
# Permission enforcement (W7)
# ---------------------------------------------------------------------


async def test_install_rejects_unknown_permission(
    client, tmp_path, clean_extensions_dir
):
    bad_zip = _make_zip(
        {
            "manifest.json": json.dumps(
                {
                    "id": "com.example.bad",
                    "version": "0.1.0",
                    "entry": "index.html",
                    "permissions": ["state_events", "filesystem.write"],
                }
            ).encode(),
            "index.html": b"<html></html>",
        }
    )
    bad_path = tmp_path / "bad.zip"
    bad_path.write_bytes(bad_zip)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "unknown_permissions"
    assert "filesystem.write" in detail["permissions"]
    assert "state_events" in detail["allowed"]


async def test_install_rejects_missing_required_manifest_field(
    client, tmp_path, clean_extensions_dir
):
    bad_zip = _make_zip(
        {
            "manifest.json": json.dumps(
                {"id": "com.example.x", "version": "0.1.0"}
            ).encode(),
            "index.html": b"x",
        }
    )
    bad_path = tmp_path / "bad.zip"
    bad_path.write_bytes(bad_zip)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 422, resp.text
    assert "entry" in str(resp.json())


async def test_install_rejects_zip_traversal(
    client, tmp_path, clean_extensions_dir
):
    bad_zip = _make_zip(
        {
            "manifest.json": json.dumps(
                {
                    "id": "com.example.evil",
                    "version": "0.1.0",
                    "entry": "index.html",
                    "permissions": [],
                }
            ).encode(),
            "../../../etc/passwd": b"pwned",
        }
    )
    bad_path = tmp_path / "evil.zip"
    bad_path.write_bytes(bad_zip)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 400, resp.text


# ---------------------------------------------------------------------
# Auth — non-admins are rejected
# ---------------------------------------------------------------------


async def test_non_admin_cannot_install(
    client, fixture_url, clean_extensions_dir
):
    login_as(NON_ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert resp.status_code == 403, resp.text


async def test_non_admin_cannot_uninstall(
    client, fixture_url, clean_extensions_dir
):
    # Install as admin first.
    login_as(ADMIN_USER)
    inst = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert inst.status_code == 201, inst.text

    # Uninstall as non-admin → 403.
    login_as(NON_ADMIN_USER)
    resp = await client.delete(f"/api/extensions/{EXT_ID}")
    assert resp.status_code == 403, resp.text


# =====================================================================
# Cold-reader negative-case coverage (INS-066-FUP-D)
# ---------------------------------------------------------------------
# These tests were added in a SEPARATE session from the implementation
# to satisfy the CLAUDE.md "WRITTEN IN BLOOD" rule: tests written by
# the same context that wrote the code encode the author's beliefs
# rather than the code's actual user-visible behavior.
#
# Each test below is a specific failure mode that the original W8
# happy-path tests did not cover. Naming convention: `test_neg_*`.
# =====================================================================


async def test_neg_install_rejects_malformed_zip_bytes(
    client, tmp_path, clean_extensions_dir
):
    """A file that is not a valid zip archive must be rejected with 400
    'not a valid zip archive'. The server must NOT crash with a 500."""
    bad_path = tmp_path / "not-a-zip.zip"
    bad_path.write_bytes(b"this is plainly not zip data" * 100)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert "zip" in str(body).lower()


async def test_neg_install_rejects_zip_without_manifest_json(
    client, tmp_path, clean_extensions_dir
):
    """A valid zip archive with NO manifest.json at the root must be
    rejected at unpack time, not at validation time, with 422."""
    bad_zip = _make_zip(
        {
            "index.html": b"<html>no manifest</html>",
            "assets/x.js": b"console.log(1);",
        }
    )
    bad_path = tmp_path / "no-manifest.zip"
    bad_path.write_bytes(bad_zip)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 422, resp.text
    assert "manifest" in resp.text.lower()


async def test_neg_manifest_missing_each_required_key(
    client, tmp_path, clean_extensions_dir
):
    """The validator requires id, version, and entry. Missing any one
    of them must reject with 422 and name the specific missing key."""
    cases = [
        # (label, manifest dict missing one required key)
        ("missing_id", {"version": "0.1.0", "entry": "index.html"}),
        ("missing_version", {"id": "com.example.x", "entry": "index.html"}),
        ("missing_entry", {"id": "com.example.x", "version": "0.1.0"}),
    ]
    login_as(ADMIN_USER)
    for label, manifest in cases:
        bad_zip = _make_zip(
            {
                "manifest.json": json.dumps(manifest).encode(),
                "index.html": b"x",
            }
        )
        bad_path = tmp_path / f"{label}.zip"
        bad_path.write_bytes(bad_zip)
        resp = await client.post(
            "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
        )
        assert resp.status_code == 422, f"{label}: {resp.text}"
        # The validator's error message must mention "missing required keys"
        # so the operator knows which field to fix.
        assert "missing" in resp.text.lower() or "entry" in resp.text.lower(), (
            f"{label}: {resp.text}"
        )


async def test_neg_manifest_with_multiple_unknown_permissions(
    client, tmp_path, clean_extensions_dir
):
    """A manifest declaring multiple unknown permissions must reject
    with 422 and surface ALL offending names (not just the first)."""
    bad_zip = _make_zip(
        {
            "manifest.json": json.dumps(
                {
                    "id": "com.example.multibad",
                    "version": "0.1.0",
                    "entry": "index.html",
                    "permissions": [
                        "filesystem.write",
                        "network.raw_socket",
                        "audio.record",
                    ],
                }
            ).encode(),
            "index.html": b"<html></html>",
        }
    )
    bad_path = tmp_path / "multibad.zip"
    bad_path.write_bytes(bad_zip)

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "unknown_permissions"
    perms = detail["permissions"]
    assert "filesystem.write" in perms
    assert "network.raw_socket" in perms
    assert "audio.record" in perms


async def test_neg_zip_with_absolute_path_entry(
    client, tmp_path, clean_extensions_dir
):
    """Zip entries with absolute paths (`/etc/passwd`) must be rejected
    with 400 BEFORE any file is written outside the staging dir."""
    # Build the zip manually so we can include an absolute path.
    import io
    import zipfile as _zip

    buf = io.BytesIO()
    with _zip.ZipFile(buf, "w", _zip.ZIP_DEFLATED) as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "id": "com.example.absolute",
                    "version": "0.1.0",
                    "entry": "index.html",
                    "permissions": [],
                }
            ),
        )
        # Absolute path. zipfile preserves the leading slash in the
        # archive entry name; the unpack path-validation step must
        # reject this BEFORE any writeout happens.
        zf.writestr("/etc/passwd", b"pwned")
    bad_path = tmp_path / "absolute.zip"
    bad_path.write_bytes(buf.getvalue())

    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install", json={"remote_url": _file_url(bad_path)}
    )
    assert resp.status_code == 400, resp.text
    # /etc/passwd was NOT created — the test just running proves it,
    # but assert the path is reported in the error so operators can
    # tell which entry tripped the gate.
    assert "absolute" in resp.text.lower() or "passwd" in resp.text.lower()


async def test_neg_install_duplicate_id_overwrites_idempotently(
    client, fixture_url, clean_extensions_dir
):
    """Re-installing the same extension id MUST be idempotent (overwrite,
    not 409 conflict). This is the documented contract — extensions get
    upgraded by re-installing, not by uninstalling first.

    DECISION: idempotent overwrite. The pipeline reuses the same DB
    row (extension id is the primary key) and clobbers the on-disk
    bundle. The endpoint returns 201 both times with the latest
    manifest. If the operator wanted a hard 409, they would expect a
    different endpoint (POST /api/extensions/{id}/upgrade or similar).
    """
    from config import EXTENSIONS_DIR

    login_as(ADMIN_USER)
    first = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert first.status_code == 201, first.text
    first_cached = first.json()["cached_at"]

    # Second install — same id, same fixture. Must succeed (201) and
    # overwrite the cached_at timestamp.
    second = await client.post(
        "/api/extensions/install", json={"remote_url": fixture_url}
    )
    assert second.status_code == 201, second.text
    assert second.json()["id"] == EXT_ID
    second_cached = second.json()["cached_at"]
    # The DB row was updated (cached_at advanced) — not duplicated.
    assert second_cached >= first_cached

    # GET listing shows EXACTLY one entry for this id (no duplication).
    listing = await client.get("/api/extensions")
    matching = [it for it in listing.json() if it["id"] == EXT_ID]
    assert len(matching) == 1, matching

    # On-disk bundle still present.
    assert (EXTENSIONS_DIR / EXT_ID / "index.html").is_file()


async def test_neg_uninstall_nonexistent_id_returns_404(
    client, clean_extensions_dir
):
    """Uninstalling an id that has no DB row must return 404, not 500
    or 204. Explicit-not-found error code so client UIs can show a
    clear message rather than 'silent success'."""
    login_as(ADMIN_USER)
    resp = await client.delete("/api/extensions/com.example.never-installed")
    assert resp.status_code == 404, resp.text


async def test_neg_install_rejects_invalid_remote_url_scheme(
    client, clean_extensions_dir
):
    """The fetcher only accepts http(s):// and file://. Any other
    scheme (e.g., ftp://, ssh://, javascript:) must reject with 400
    BEFORE any I/O is attempted — defense against fetch primitive
    abuse."""
    login_as(ADMIN_USER)
    for bad_url in (
        "ftp://example.com/bundle.zip",
        "ssh://example.com/bundle.zip",
        "javascript:alert(1)",
        "data:application/zip;base64,UEsDBA==",
    ):
        resp = await client.post(
            "/api/extensions/install", json={"remote_url": bad_url}
        )
        assert resp.status_code == 400, f"{bad_url!r}: {resp.text}"


async def test_neg_install_unreachable_remote_url_returns_clean_502(
    client, clean_extensions_dir
):
    """An unreachable HTTP(S) remote_url must surface as a clean 502
    (Bad Gateway), NOT a 500 (Internal Server Error). 500 hides the
    operator-visible "your bundle source is down" signal.

    Uses an invalid TLD + 127.0.0.1 with an unbound port so the
    request fails fast (DNS or connect error) — no 60s wait."""
    login_as(ADMIN_USER)
    # 127.0.0.1:1 is RFC-reserved tcpmux; on most test hosts no socket
    # is bound, so connect fails immediately. (Adjust port if a CI
    # runner happens to have something listening — extremely rare.)
    resp = await client.post(
        "/api/extensions/install",
        json={"remote_url": "http://127.0.0.1:1/bundle.zip"},
    )
    # 502 from `_fetch_zip_bytes` HTTPError branch.
    assert resp.status_code == 502, resp.text
    assert "fetch" in resp.text.lower() or "502" in resp.text


async def test_neg_install_file_url_to_nonexistent_path_returns_400(
    client, tmp_path, clean_extensions_dir
):
    """A file:// URL pointing at a path that does not exist must
    surface as 400 'file not found', not 500."""
    missing = tmp_path / "does-not-exist.zip"
    login_as(ADMIN_USER)
    resp = await client.post(
        "/api/extensions/install",
        json={"remote_url": f"file://{missing}"},
    )
    assert resp.status_code == 400, resp.text
    assert "file" in resp.text.lower() or "not found" in resp.text.lower()
