"""Tests for the Concord-specific ``/.well-known/concord/client`` endpoint.

Scope:
1. The endpoint returns 200 with JSON matching the
   ``ConcordClientWellKnown`` response model.
2. All four wire-contract fields are present (``api_base``,
   ``livekit_url``, ``instance_name``, ``features``) and carry values
   derived from the mocked env vars.
3. Auth is NOT required — well-known discovery must work before the
   client has any credentials. A request with no Authorization header
   must still return 200.
4. The env-var resolution paths are exercised independently:
   ``PUBLIC_BASE_URL`` override, ``CONDUWUIT_SERVER_NAME`` fallback,
   missing ``CONDUWUIT_SERVER_NAME`` landing on the explicit sentinel.
5. The ``features`` list is the stable hard-coded list from
   ``_advertised_features`` — pinning it here catches accidental
   removals that would break deployed native clients.

These tests intentionally stay hermetic: they mock env via
``monkeypatch`` and do not touch any real container state.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _scrub_env(monkeypatch, tmp_path):
    """Start every test with the wellknown-relevant env vars unset so
    each test explicitly opts in to the values it cares about. Keeps
    tests independent of the developer's shell and of test ordering.

    Also redirects CONCORD_DATA_DIR into a per-test tmp_path so the
    service-node public view call inside the wellknown handler reads
    a fresh default-config file (rather than picking up a stale
    service_node.json from an unrelated test run).
    """
    for var in ("PUBLIC_BASE_URL", "CONDUWUIT_SERVER_NAME", "INSTANCE_NAME", "LIVEKIT_URL"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("CONCORD_DATA_DIR", str(tmp_path))


async def test_returns_200_without_auth(client, monkeypatch):
    """Unauthenticated request must succeed.

    Well-known discovery is designed to run BEFORE the client has any
    credentials — requiring auth here would create a chicken-and-egg
    problem where the client can't discover the auth endpoint without
    auth'ing to the auth endpoint.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200, resp.text


async def test_response_shape_matches_contract(client, monkeypatch):
    """Pin the exact shape of the response body.

    Every field in the ConcordClientWellKnown response model must be
    present and typed correctly. The TypeScript wire-model on the
    client side (``HomeserverConfig`` in
    ``client/src/api/wellKnown.ts``) depends on this exact shape —
    any drift breaks every native build in the wild.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")
    monkeypatch.setenv("INSTANCE_NAME", "Concorrd Test")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    # Exact key set — no extras, no missing.
    assert set(body.keys()) == {
        "api_base",
        "livekit_url",
        "instance_name",
        "features",
        "turn_servers",
        # INS-023 additions — keep the client wire model in sync.
        "node_role",
        "tunnel_anchor",
    }, f"unexpected keys: {set(body.keys())}"

    # Type checks.
    assert isinstance(body["api_base"], str) and len(body["api_base"]) > 0
    assert body["livekit_url"] is None or isinstance(body["livekit_url"], str)
    assert body["instance_name"] is None or isinstance(body["instance_name"], str)
    assert isinstance(body["features"], list)
    for f in body["features"]:
        assert isinstance(f, str) and len(f) > 0
    assert isinstance(body["turn_servers"], list)
    # INS-023 service-node posture fields — default-on-fresh-deploy.
    assert body["node_role"] in (None, "frontend-only", "hybrid", "anchor")
    assert isinstance(body["tunnel_anchor"], bool)

    # Value checks against the mocked env.
    assert body["api_base"] == "https://concorrd.com/api"
    assert body["livekit_url"] == "wss://concorrd.com/livekit/"
    assert body["instance_name"] == "Concorrd Test"


async def test_public_base_url_override_wins(client, monkeypatch):
    """``PUBLIC_BASE_URL`` takes precedence over the
    ``CONDUWUIT_SERVER_NAME`` fallback.

    This lets operators run Concord behind a reverse-proxy path
    (e.g. ``https://homelab.example.net/concord``) where the server
    name alone can't synthesise the right public URL.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://homelab.example.net/concord")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["api_base"] == "https://homelab.example.net/concord/api"
    # LiveKit resolution is still keyed on CONDUWUIT_SERVER_NAME —
    # documented behaviour, pinned here so future refactors that
    # change the resolution source are caught.
    assert body["livekit_url"] == "wss://concorrd.com/livekit/"


async def test_public_base_url_trailing_slash_stripped(client, monkeypatch):
    """Trailing slashes on ``PUBLIC_BASE_URL`` must be normalised away.

    Without this, a ``PUBLIC_BASE_URL=https://x.com/`` env setting
    would synthesise ``https://x.com//api`` — a double slash — which
    passes Pydantic's string validation but breaks the client-side
    ``assertHttpsUrl`` canonicalisation. Catch the footgun server-side.
    """
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://x.example/")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    # Single ``/api``, not ``//api``.
    assert body["api_base"] == "https://x.example/api"


async def test_missing_server_name_sentinel(client, monkeypatch):
    """If CONDUWUIT_SERVER_NAME is missing entirely, the endpoint still
    returns 200 with a sentinel ``localhost`` base URL and a null
    livekit_url.

    The sentinel is explicit (not a 500) because this endpoint must
    NEVER crash during startup discovery — a well-known that 500s
    would block the client from ever reaching the server, including
    the server the operator wants to fix the config on.
    """
    # No CONDUWUIT_SERVER_NAME, no PUBLIC_BASE_URL.
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["api_base"] == "https://localhost/api"
    # livekit can't be synthesised without the server name — returns null.
    assert body["livekit_url"] is None


async def test_instance_name_optional(client, monkeypatch):
    """INSTANCE_NAME is optional; its absence must return ``null``
    rather than an empty string or the hostname.

    The client-side code distinguishes "no instance name provided" vs
    "instance name is the hostname" — surfacing an empty string would
    collapse those into one case and cause the picker UI to display
    the hostname label twice.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")
    # No INSTANCE_NAME set.

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["instance_name"] is None


async def test_features_list_is_stable(client, monkeypatch):
    """Pin the advertised features list.

    Removing an entry from this list WILL break deployed native
    clients that check for the feature before rendering a UI
    affordance. This test is a canary — if you intentionally retire a
    feature, update the assertion AND document the removal in PLAN.md
    so downstream clients know to drop their check.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")

    resp = await client.get("/.well-known/concord/client")
    body = resp.json()

    # The canonical list as of INS-027 Phase 2 + INS-025 (explore)
    # + the later `extensions` addition. Add new entries at the end;
    # do NOT reorder — clients shouldn't care, but diff reviewers
    # benefit from a stable ordering.
    assert body["features"] == [
        "chat",
        "voice",
        "federation",
        "soundboard",
        "explore",
        "extensions",
    ]


# ---------------------------------------------------------------------------
# INS-023 — service-node posture advertised in the discovery document
# ---------------------------------------------------------------------------


async def test_default_service_node_posture(client, monkeypatch):
    """On a fresh deployment with no service_node.json, the well-known
    advertises the default role ("hybrid") and tunnel_anchor=False.

    This path is the boring-happy case — operators who never touch
    the Service Node admin tab should still publish a coherent
    posture. No log-spammy warnings, no missing fields.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["node_role"] == "hybrid"
    assert body["tunnel_anchor"] is False


async def test_anchor_service_node_posture_surfaced(client, monkeypatch):
    """When an admin has flipped the tunnel anchor on and set the role
    to "anchor", both values must reach the public well-known.

    Exercises the integration between the admin-only
    ``services.service_node_config.save_config`` writer and the
    unauthenticated ``public_view`` reader used by the discovery
    route. Keeps the two sides honest.
    """
    # `_scrub_env` redirects CONCORD_DATA_DIR to a per-test tmp_path;
    # write a config file there and the route will pick it up via
    # the lazy import of `public_view` inside the handler.
    from services.service_node_config import ServiceNodeConfig, save_config

    save_config(
        ServiceNodeConfig(
            max_cpu_percent=60,
            max_bandwidth_mbps=1000,
            max_storage_gb=200,
            tunnel_anchor_enabled=True,
            node_role="anchor",
        )
    )

    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "concorrd.com")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["node_role"] == "anchor"
    assert body["tunnel_anchor"] is True
    # Raw caps must NEVER appear in the public well-known document.
    assert "max_cpu_percent" not in body
    assert "max_bandwidth_mbps" not in body
    assert "max_storage_gb" not in body
