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
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")

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
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")
    monkeypatch.setenv("INSTANCE_NAME", "Example Instance")

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
        # INS-069 — per-instance branding.
        "branding",
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
    assert body["api_base"] == "https://chat.example.com/api"
    assert body["livekit_url"] == "wss://chat.example.com/livekit/"
    assert body["instance_name"] == "Example Instance"


async def test_public_base_url_override_wins(client, monkeypatch):
    """``PUBLIC_BASE_URL`` takes precedence over the
    ``CONDUWUIT_SERVER_NAME`` fallback.

    This lets operators run Concord behind a reverse-proxy path
    (e.g. ``https://homelab.example.net/concord``) where the server
    name alone can't synthesise the right public URL.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://homelab.example.net/concord")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["api_base"] == "https://homelab.example.net/concord/api"
    # LiveKit resolution prefers PUBLIC_BASE_URL too — historically it
    # was keyed only on CONDUWUIT_SERVER_NAME, which silently advertised
    # the homeserver name (often a stale bootstrap value like a LAN IP)
    # to every off-LAN peer. The well-known doc must reflect the same
    # public host the api_base does, so both fields agree on what the
    # client should dial.
    assert body["livekit_url"] == "wss://homelab.example.net/livekit/"


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


async def test_bare_slug_server_name_expands_to_concordchat_net(client, monkeypatch):
    """INS-051: a bare-slug CONDUWUIT_SERVER_NAME (no dots) is advertised
    as <slug>.concordchat.net via the canonical default domain root."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "alpha")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_base"] == "https://alpha.concordchat.net/api"
    assert body["livekit_url"] == "wss://alpha.concordchat.net/livekit/"


async def test_fully_qualified_server_name_is_unchanged(client, monkeypatch):
    """A server name that already contains a dot is treated as an FQDN
    and NOT re-expanded under concordchat.net — operators with their
    own domain must keep working unchanged."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.org")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_base"] == "https://chat.example.org/api"
    assert body["livekit_url"] == "wss://chat.example.org/livekit/"


async def test_default_domain_root_overridable(client, monkeypatch):
    """Forks who maintain a different generic domain can override the
    default via CONCORD_DEFAULT_DOMAIN_ROOT.

    Setup note: config.CONCORD_DEFAULT_DOMAIN_ROOT is read at module
    load time. We monkeypatch the resolved attribute directly to
    simulate a fresh process with the override env var set.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "alpha")
    import config as concord_config
    monkeypatch.setattr(concord_config, "CONCORD_DEFAULT_DOMAIN_ROOT", "alt-concord.io")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_base"] == "https://alpha.alt-concord.io/api"


async def test_localhost_server_name_is_sentinel_not_expanded(client, monkeypatch):
    """The literal `localhost` sentinel must NOT be expanded — it's
    reserved for "configuration error, do not advertise a real domain"."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "localhost")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_base"] == "https://localhost/api"
    assert body["livekit_url"] == "wss://localhost/livekit/"


async def test_instance_name_optional(client, monkeypatch):
    """INSTANCE_NAME is optional; its absence must return ``null``
    rather than an empty string or the hostname.

    The client-side code distinguishes "no instance name provided" vs
    "instance name is the hostname" — surfacing an empty string would
    collapse those into one case and cause the picker UI to display
    the hostname label twice.
    """
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")
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
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")

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
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "example.concordchat.net")

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

    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "example.concordchat.net")
    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["node_role"] == "anchor"
    assert body["tunnel_anchor"] is True
    # Raw caps must NEVER appear in the public well-known document.
    assert "max_cpu_percent" not in body
    assert "max_bandwidth_mbps" not in body
    assert "max_storage_gb" not in body


# ---------------------------------------------------------------------------
# INS-069 — per-instance branding surfaced in the well-known document
# ---------------------------------------------------------------------------


async def test_branding_absent_when_unset(client, monkeypatch):
    """A fresh deployment with no branding configured returns
    ``branding: null``. The native client treats null as "use default
    Source tile styling"."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    assert resp.json()["branding"] is None


async def test_branding_appears_when_set(client, monkeypatch, tmp_path):
    """When ``instance.json`` contains a ``branding`` block, the
    well-known document echoes every field exactly so cross-instance
    Source tiles can render with the upstream operator's chosen
    colours.
    """
    import json

    import routers.admin as admin_module

    settings_file = tmp_path / "instance.json"
    settings_file.write_text(
        json.dumps(
            {
                "name": "Branded Instance",
                "branding": {
                    "primary_color": "#1a2b3c",
                    "accent_color": "#ffaabb",
                    "logo_url": "https://example.test/brand.png",
                },
            }
        )
    )
    monkeypatch.setattr(admin_module, "INSTANCE_SETTINGS_FILE", settings_file)
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()
    assert body["branding"] == {
        "primary_color": "#1a2b3c",
        "accent_color": "#ffaabb",
        "logo_url": "https://example.test/brand.png",
    }


async def test_malformed_branding_falls_back_to_null(client, monkeypatch, tmp_path):
    """An operator-corrupted branding block (wrong types, missing
    fields) MUST NOT 500 the discovery endpoint — clients should still
    be able to reach the instance to fix the configuration. Treat the
    block as if absent and serve null."""
    import json

    import routers.admin as admin_module

    settings_file = tmp_path / "instance.json"
    settings_file.write_text(
        json.dumps(
            {
                "branding": {"primary_color": "not-a-hex", "accent_color": 123},
            }
        )
    )
    monkeypatch.setattr(admin_module, "INSTANCE_SETTINGS_FILE", settings_file)
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "chat.example.com")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    assert resp.json()["branding"] is None


# ---------------------------------------------------------------------------
# RFC1918-host hardening — the well-known document must NEVER advertise a
# LAN-only host to off-LAN peers. This caused a live regression on the
# dev stack: ``CONDUWUIT_SERVER_NAME=192.168.1.152`` was inherited from
# the original LAN-only bootstrap, then surfaced as
# ``livekit_url=wss://192.168.1.152/livekit/`` in the discovery doc.
# Browsers that fetched the doc tried to dial the LAN IP, hit a TLS
# cert-name mismatch (cert is for the public domain), and surfaced
# "Encountered websocket error during connection establishment".
# These tests pin the fix.
# ---------------------------------------------------------------------------


async def test_lan_ip_server_name_drops_livekit_url(client, monkeypatch):
    """A ``CONDUWUIT_SERVER_NAME`` set to an RFC1918 literal (e.g. a
    stale LAN bootstrap) and no ``PUBLIC_BASE_URL`` override MUST yield
    ``livekit_url=null`` rather than synthesising a ``wss://192.168...``
    URL the client can never reach from off-LAN."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "192.168.1.152")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["livekit_url"] is None


async def test_public_base_url_overrides_lan_ip_server_name(client, monkeypatch):
    """When the homeserver name is a stale LAN IP but
    ``PUBLIC_BASE_URL`` advertises the real public host, the LiveKit
    URL must derive from the public host — NOT from the LAN IP. This
    is the dev-stack failure mode the regression test was added for:
    cert is for dev.concorrd.com, doc was advertising wss://192.168.x."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "192.168.1.152")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://dev.example.test")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    body = resp.json()

    assert body["livekit_url"] == "wss://dev.example.test/livekit/"
    assert body["api_base"] == "https://dev.example.test/api"


async def test_lan_ip_turn_host_drops_stun_advertisement(client, monkeypatch):
    """An RFC1918 ``TURN_HOST`` (the dev stack's stale value) must NOT
    leak into ``turn_servers`` as a ``stun:192.168.x.x:3478`` entry —
    that URL is unreachable for every off-LAN client and clutters the
    ICE candidate list with a guaranteed-failed candidate."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "192.168.1.152")
    monkeypatch.setenv("TURN_HOST", "192.168.1.152")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    servers = resp.json()["turn_servers"]

    for server in servers:
        url = server.get("urls", "")
        assert "192.168" not in url, f"LAN IP leaked into turn_servers: {url}"
    # Google STUN fallback must still be present so the client always
    # has at least one ICE candidate to try.
    assert any("stun.l.google.com" in s.get("urls", "") for s in servers)


async def test_public_base_url_promotes_stun_endpoint(client, monkeypatch):
    """When ``TURN_HOST`` is RFC1918 but ``PUBLIC_BASE_URL`` is set,
    the STUN advertisement is promoted to the public host so off-LAN
    clients still get a usable own-instance STUN candidate."""
    monkeypatch.setenv("CONDUWUIT_SERVER_NAME", "192.168.1.152")
    monkeypatch.setenv("TURN_HOST", "192.168.1.152")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://dev.example.test")

    resp = await client.get("/.well-known/concord/client")
    assert resp.status_code == 200
    servers = resp.json()["turn_servers"]

    assert any(
        s.get("urls") == "stun:dev.example.test:3478" for s in servers
    ), f"public-host STUN missing from {servers!r}"
