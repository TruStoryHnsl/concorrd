"""Tests for the public `/api/explore/servers` endpoint.

Scope:
1. Auth gating — an unauthenticated request must be rejected.
2. Happy path — an authenticated request returns the decoded allowlist
   as a list of ``{domain, name, description}`` objects.

These tests intentionally mirror the fixture patterns used in
``test_admin_federation.py`` (the neighbouring federation router's test
suite): the tmp-path/monkeypatch trick for ``TUWUNEL_CONFIG_PATH`` and
the ``login_as`` / ``logout`` helpers from ``conftest`` for auth.
"""

from __future__ import annotations

import services.tuwunel_config as tuwunel_config
from services.tuwunel_config import (
    FederationSettings,
    decode_server_name_patterns,
    write_federation,
)
from tests.conftest import login_as, logout


async def test_list_servers_requires_auth(client):
    """Unauthenticated callers must be rejected before any allowlist
    state is returned.

    ``get_user_id`` uses ``Header(...)`` (required), so a request with
    no Authorization header is rejected at dependency-resolution time.
    FastAPI's default for a missing required header is 422 (request
    validation); a Bearer-malformed header would produce 401 from the
    router's own check. We accept either here — matching the existing
    convention in ``test_error_handling.py`` — because the important
    contract is "not 200", not the specific 4xx code.
    """
    logout()  # ensure no leftover overrides from earlier tests

    resp = await client.get("/api/explore/servers")
    assert resp.status_code in (401, 422), (
        f"expected auth rejection, got {resp.status_code}: {resp.text}"
    )


async def test_list_servers_returns_decoded_allowlist(client, tmp_path, monkeypatch):
    """Happy path: prime the tuwunel.toml with two allowlisted hostnames,
    authenticate, and assert the endpoint returns them as explore cards
    in the ``{domain, name, description}`` shape the frontend expects.
    """
    # Point the federation reader/writer at a per-test TOML file so this
    # test doesn't stomp on any real on-disk config. Matches the pattern
    # from test_admin_federation.py::test_put_allowlist_accepts_valid_and_writes_config.
    config_path = tmp_path / "tuwunel.toml"
    monkeypatch.setattr(tuwunel_config, "TUWUNEL_CONFIG_PATH", config_path)

    # Seed the file with two anchored regex patterns — the same shape
    # `admin_update_federation_allowlist` would have written.
    write_federation(
        FederationSettings(
            allow_federation=True,
            allowed_remote_server_names=[
                r"^matrix\.org$",
                r"^friend\.example\.com$",
            ],
            forbidden_remote_server_names=[".*"],
        )
    )

    login_as("@test_user:test.local")
    try:
        resp = await client.get("/api/explore/servers")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert isinstance(body, list), f"expected list, got {type(body).__name__}"
        # 3 entries: local instance (test.local) + 2 allowlisted peers.
        # The local instance is prepended by the endpoint as "This instance".
        assert len(body) == 3, f"expected 3 entries, got {len(body)}: {body}"

        # Each entry must have the exact shape the frontend renders.
        for entry in body:
            assert set(entry.keys()) == {"domain", "name", "description"}, (
                f"unexpected keys: {entry.keys()}"
            )
            # domain and name are the same value (see router docstring).
            assert entry["domain"] == entry["name"]

        # First entry is always the local instance.
        assert body[0]["domain"] == "test.local"
        assert body[0]["description"] == "This instance"

        # Remaining entries are the allowlisted peers (order preserved from TOML).
        domains = sorted(e["domain"] for e in body[1:])
        assert domains == ["friend.example.com", "matrix.org"]
    finally:
        logout()


def test_decode_server_name_patterns_handles_regex_metachars():
    """``decode_server_name_patterns`` must not corrupt hand-edited regexes.

    The naive unescape loop (stripping ``\\x`` -> ``x``) mangles genuine
    regex metacharacters: ``^\\d+\\.example\\.com$`` would decode to the
    bogus hostname ``d+.example.com``, which is not a valid RFC-1123 name
    and which should never surface to the explore UI as if it were a real
    domain the admin added.

    Expected behaviour:
    - Our own ``^escaped-hostname$`` format round-trips cleanly to the
      plain hostname (happy path preserved).
    - A pattern that unescapes to something that is NOT a valid hostname
      is returned verbatim — honouring the docstring's contract that
      "patterns we can't decode are returned unchanged", even when the
      pattern merely *looks* like our escape format on the surface.

    This is a unit test on the helper directly (no FastAPI client, no
    auth) — the blast radius is intentionally small so a regression here
    surfaces with a clear stack trace.
    """
    # Happy path: re.escape()-produced patterns still decode normally.
    happy = decode_server_name_patterns(
        [r"^example\.org$", r"^matrix\.org$", r"^friend\.example\.com$"]
    )
    assert happy == ["example.org", "matrix.org", "friend.example.com"]

    # Regex metachar path: ``\d`` would naively become ``d``, turning the
    # pattern into ``d+.example.com`` which fails hostname validation.
    # The helper must fall back to returning the original pattern.
    metachar_pattern = r"^\d+\.example\.com$"
    result = decode_server_name_patterns([metachar_pattern])
    assert result == [metachar_pattern], (
        f"expected verbatim fallback for regex-metachar pattern, got {result!r}"
    )

    # Mixed list: good entries decode, bad entries surrender to verbatim,
    # and the two paths don't interfere with each other.
    mixed = decode_server_name_patterns(
        [r"^matrix\.org$", r"^\w+\.internal$", r"^friend\.example\.com$"]
    )
    assert mixed == [
        "matrix.org",
        r"^\w+\.internal$",  # \w stays escaped — verbatim fallback
        "friend.example.com",
    ]

    # Patterns that don't even match our ``^...$`` shape are untouched
    # (pre-existing behaviour, kept as a regression guard).
    untouched = decode_server_name_patterns([".*", "no-anchors.example.com"])
    assert untouched == [".*", "no-anchors.example.com"]
