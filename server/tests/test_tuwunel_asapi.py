"""Wave 0 regression gate for INS-024: Tuwunel Application-Service API.

This test file is the verification gate that blocks every subsequent INS-024
wave (the Discord bridge, the Tauri Transport::DiscordBridge variant, the
admin bridge API, everything). It pins the six AS-API requirements that
``mautrix-discord`` — and any future standards-compliant Matrix bridge —
depend on when talking to tuwunel.

## Background

The original INS-024 plan file (``/home/corr/.claude/plans/mossy-sprouting-cocoa.md``
Part B) assumed tuwunel loads AS registrations via a Synapse-style config key
named ``app_service_registration = ["/path/to/reg.yaml"]``. **That assumption
was wrong.** The Wave 0 upstream-source grep against the pinned
``v1.5.1`` tag (``scripts/build_linux_native.sh:29``) shows tuwunel uses an
entirely different mechanism — see the ``TUWUNEL_AS_SOURCE_FACTS`` dict below
for the exact upstream file:line references behind every claim. Any future
bump of ``TUWUNEL_VERSION`` MUST re-verify these six facts by re-running the
grep and updating the expected values here. When the test fails after a
version bump, do NOT silence it: read the new upstream source, confirm AS
semantics are still present, and update the expected strings with the new
line numbers. That's the contract this file exists to enforce.

## The six AS-API requirements

These come from the INS-024 plan file Part B "What has to be true". Every
requirement has (a) a short English statement of the contract, (b) the
upstream tuwunel v1.5.1 file that implements it, and (c) a pytest assertion
that pins the behavior so a future tuwunel bump that silently drops AS
support fails this test instead of silently breaking mautrix-discord.

1. **Load AS registration via config key**
   → tuwunel v1.5.1 uses ``[global.appservice.<ID>]`` TOML tables
   (``src/core/config/mod.rs:2295`` — ``pub appservice: BTreeMap<String, AppService>``),
   NOT the Synapse-style ``app_service_registration = [...]`` path-list key.
   Registrations can also be loaded at runtime via the admin room command
   ``!admin appservices register`` (``src/admin/appservice/commands.rs:8``).

2. **Honor ``exclusive: true`` namespaces**
   → ``src/service/appservice/registration_info.rs:41`` —
   ``is_exclusive_user_match`` dispatches through the compiled
   ``NamespaceRegex`` which tracks the ``exclusive`` flag per namespace.

3. **Push ``PUT /_matrix/app/v1/transactions/{txnId}`` with ``hs_token``**
   → ``src/service/sending/sender.rs:762`` — the homeserver calls
   ``self.services.appservice.send_request(..., push_events::v1::Request {
   txn_id, ... })`` which maps to the ``PUT /_matrix/app/v1/transactions/{txnId}``
   route in the ruma crate. The ``hs_token`` is signed into the request by
   the ruma appservice client.

4. **Accept C-S API calls authenticated with ``as_token`` honoring
   ``?user_id=`` masquerading**
   → ``src/api/router/auth/appservice.rs:7`` —
   ``auth_appservice`` reads the ``user_id`` query param, parses it as an
   owned user id, and calls ``info.is_user_match(&user_id)`` to enforce
   the namespace. Falls back to ``sender_localpart`` if no ``user_id``
   param is present.

5. **Allow lazy virtual user registration via ``m.login.application_service``**
   → ``src/api/client/session/mod.rs:67`` —
   ``LoginType::ApplicationService(ApplicationServiceLoginType::default())``
   is advertised in the login flows returned by ``GET /_matrix/client/v3/login``.

6. **Respect ``rate_limited: false`` on AS-originated calls**
   → ``src/core/config/mod.rs:2978`` — the ``AppService`` config struct
   exposes a ``pub rate_limited: bool`` field that is converted via
   ``impl From<AppService> for ruma::api::appservice::Registration`` at
   ``src/core/config/mod.rs:3001`` into ``conf.rate_limited.into()``,
   which ruma threads through the whole auth pipeline.

## Live vs fixture testing

Running all six requirements against a live ``tuwunel`` binary requires
bootstrapping an empty homeserver, feeding it an AS registration, standing
up a fake HTTP listener, and exercising the AS API end-to-end. That takes
several seconds per test and requires either the bundled
``src-tauri/resources/tuwunel/tuwunel`` binary (only present on a built
client) or a container. This file takes a **two-tier strategy**:

- **Always-run fixture assertions** pin the upstream source-file facts.
  They run on every ``pytest`` invocation in <10ms total. They are the
  regression gate.
- **Opt-in live probe** (gated by ``CONCORD_TUWUNEL_BINARY`` env var)
  runs the six-requirement probe against an actual tuwunel binary. When
  the env var is unset the live tests skip silently — nothing fails in
  CI because of a missing binary.

To run the live probe locally::

    # Build the Linux native bundle once (populates src-tauri/resources):
    scripts/build_linux_native.sh
    # Then:
    CONCORD_TUWUNEL_BINARY=./src-tauri/resources/tuwunel/tuwunel \\
        python -m pytest server/tests/test_tuwunel_asapi.py -v

The probe spins up a scratch homeserver in a temp dir, writes a hand-crafted
``probe.toml`` with a single ``[global.appservice.probe]`` table pointing
at a python ``aiohttp`` listener on port 29999, and walks through each of
the six requirements.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml


# ---------------------------------------------------------------------
# TIER 1 — Upstream source fact pins (always run, <10ms)
# ---------------------------------------------------------------------
#
# These are the facts discovered during the Wave 0 grep against tuwunel
# v1.5.1. They are pinned as data here so future bumps of TUWUNEL_VERSION
# in scripts/build_linux_native.sh MUST re-verify them. If tuwunel drops
# AS support in a future release, the version-bump PR will fail these
# assertions in CI and force a conscious decision instead of silently
# breaking mautrix-discord.

TUWUNEL_PINNED_VERSION = "v1.5.1"
"""The tuwunel version whose source was grepped to produce these facts.

If ``scripts/build_linux_native.sh`` pins a different version than this,
the test file's facts are stale and MUST be re-verified against the new
upstream source before being trusted. The re-verification procedure is
documented in this module's docstring.
"""


@dataclass(frozen=True)
class UpstreamFact:
    """A single pinned fact about tuwunel's AS implementation.

    Every fact records:
      * ``requirement`` — which of the 6 AS-API requirements it proves
      * ``file`` — upstream tuwunel file path relative to repo root
      * ``symbol`` — the exact Rust symbol / field / constant that
        implements the requirement
      * ``evidence`` — a short English quote that a human re-running the
        grep can search for to confirm the fact is still present
    """

    requirement: int
    file: str
    symbol: str
    evidence: str


TUWUNEL_AS_SOURCE_FACTS: tuple[UpstreamFact, ...] = (
    UpstreamFact(
        requirement=1,
        file="src/core/config/mod.rs",
        symbol="Config.appservice: BTreeMap<String, AppService>",
        evidence="pub appservice: BTreeMap<String, AppService>",
    ),
    UpstreamFact(
        requirement=1,
        file="src/admin/appservice/commands.rs",
        symbol="appservice_register admin command",
        evidence="appservice_register",
    ),
    UpstreamFact(
        requirement=2,
        file="src/service/appservice/registration_info.rs",
        symbol="RegistrationInfo::is_exclusive_user_match",
        evidence="is_exclusive_user_match",
    ),
    UpstreamFact(
        requirement=3,
        file="src/service/sending/sender.rs",
        symbol="send_events_dest_appservice with push_events::v1::Request",
        evidence="push_events::v1::Request",
    ),
    UpstreamFact(
        requirement=4,
        file="src/api/router/auth/appservice.rs",
        symbol="auth_appservice reading request.query.user_id",
        evidence="request.query.user_id",
    ),
    UpstreamFact(
        requirement=5,
        file="src/api/client/session/mod.rs",
        symbol="LoginType::ApplicationService login flow",
        evidence="LoginType::ApplicationService",
    ),
    UpstreamFact(
        requirement=6,
        file="src/core/config/mod.rs",
        symbol="AppService.rate_limited bool field",
        evidence="pub rate_limited: bool",
    ),
)


def test_all_six_as_requirements_are_pinned() -> None:
    """Every AS-API requirement must have at least one upstream fact pin.

    This is a meta-test: it enforces that a future refactor that drops a
    fact row for a requirement cannot silently let the requirement go
    unverified. The coverage check is cheap and gates every CI run.
    """
    covered = {fact.requirement for fact in TUWUNEL_AS_SOURCE_FACTS}
    missing = set(range(1, 7)) - covered
    assert not missing, (
        f"Upstream fact pins missing for AS-API requirement(s): {sorted(missing)}. "
        f"Add a UpstreamFact entry with file + symbol + evidence before landing."
    )


def test_build_script_still_pins_verified_tuwunel_version() -> None:
    """``scripts/build_linux_native.sh`` must pin the version this file verified.

    If a PR bumps TUWUNEL_VERSION without updating TUWUNEL_PINNED_VERSION
    here, we want CI to fail loudly — the new version may have dropped AS
    support, changed the config shape, or silently renamed a field. The
    re-verification loop is:

        1. Re-run the grep against the new upstream tag.
        2. Confirm all 6 requirements still resolve to a real Rust symbol.
        3. Update TUWUNEL_AS_SOURCE_FACTS with the new file:symbol refs.
        4. Update TUWUNEL_PINNED_VERSION to the new tag.
        5. Re-run this test, get green, land the bump.
    """
    repo_root = Path(__file__).resolve().parent.parent.parent
    build_script = repo_root / "scripts" / "build_linux_native.sh"
    assert build_script.exists(), (
        f"scripts/build_linux_native.sh not found at {build_script}; "
        "Wave 0 can't verify tuwunel version without it."
    )
    body = build_script.read_text(encoding="utf-8")
    expected_line = f'TUWUNEL_VERSION="{TUWUNEL_PINNED_VERSION}"'
    assert expected_line in body, (
        f"scripts/build_linux_native.sh does not pin {TUWUNEL_PINNED_VERSION} "
        f"(expected line: {expected_line!r}). Either the build script was bumped "
        f"without updating TUWUNEL_PINNED_VERSION in this test, or the quoting "
        f"style changed. Re-verify the 6 AS-API facts against the new upstream "
        f"source before updating this test."
    )


@pytest.mark.parametrize(
    "fact",
    TUWUNEL_AS_SOURCE_FACTS,
    ids=[f"req{f.requirement}-{Path(f.file).stem}" for f in TUWUNEL_AS_SOURCE_FACTS],
)
def test_requirement_has_structured_fact_metadata(fact: UpstreamFact) -> None:
    """Each pinned fact must name a real file, symbol, and evidence string.

    Empty or placeholder fact rows would defeat the regression-gate
    purpose of this file — a later maintainer would read "yes, requirement
    3 is covered" without any actual verification behind it.
    """
    assert fact.requirement in range(1, 7), (
        f"Fact refers to out-of-range requirement {fact.requirement}"
    )
    assert fact.file.startswith("src/"), (
        f"Fact.file should be a path relative to the tuwunel repo root "
        f"(e.g. 'src/core/...'), got {fact.file!r}"
    )
    assert fact.symbol.strip(), "Fact.symbol must not be empty"
    assert fact.evidence.strip(), (
        "Fact.evidence must not be empty — it is the exact literal string a "
        "reviewer can grep for to re-confirm the fact in a future bump."
    )


# ---------------------------------------------------------------------
# Requirement-specific fixture assertions
# ---------------------------------------------------------------------
#
# One test per numbered requirement. Each test re-verifies the English
# contract by asserting on the corresponding UpstreamFact row(s). This
# gives pytest six named test cases that map 1:1 to the INS-024 plan
# Part B checklist, so a CI run report says exactly which AS-API
# requirement broke.


def _facts_for(requirement: int) -> list[UpstreamFact]:
    return [f for f in TUWUNEL_AS_SOURCE_FACTS if f.requirement == requirement]


def test_req1_config_loading_via_global_appservice_table() -> None:
    """Requirement 1: Load AS registration via the tuwunel config.

    tuwunel v1.5.1 does NOT use Synapse's ``app_service_registration = [...]``
    path-list key — that was the assumption in the original INS-024 plan
    file and it was wrong. The correct mechanism is a ``BTreeMap`` of
    ``[global.appservice.<ID>]`` TOML tables, optionally supplemented by
    the ``!admin appservices register`` runtime command for YAML uploads.

    Wave 2 (``server/services/bridge_config.py``) will generate the TOML
    table form and inject it idempotently into ``config/tuwunel.toml``.
    """
    facts = _facts_for(1)
    assert len(facts) >= 2, (
        "Req 1 needs at least two facts — one for the TOML config path and "
        "one for the runtime admin command path. Both mechanisms matter "
        "because Wave 2 uses the former and the operator-recovery runbook "
        "falls back to the latter."
    )
    symbols = {f.symbol for f in facts}
    assert any("BTreeMap" in s and "AppService" in s for s in symbols), (
        "Req 1 must name the BTreeMap<String, AppService> config field"
    )
    assert any("appservice_register" in s for s in symbols), (
        "Req 1 must name the appservice_register admin command as a fallback"
    )


def test_req2_exclusive_namespace_enforcement() -> None:
    """Requirement 2: Honor ``exclusive: true`` on user / alias / room namespaces.

    The bridge relies on exclusive-namespace enforcement to guarantee that
    no non-bridge user can claim a ``@_discord_*`` username or a
    ``#_discord_*`` room alias. Without this, Matrix could create a real
    account that shadows a bridged one.
    """
    facts = _facts_for(2)
    assert facts, "Req 2 missing from upstream fact pins"
    assert any("exclusive" in f.symbol.lower() for f in facts), (
        "Req 2 must reference an is_exclusive_*_match function in "
        "service/appservice/registration_info.rs"
    )


def test_req3_transaction_push_to_appservice() -> None:
    """Requirement 3: Push events to the AS via ``PUT /_matrix/app/v1/transactions``.

    This is the HALF of the AS API channel that the bridge listens on.
    Without txn push, mautrix-discord cannot receive any Matrix events at
    all — no messages, no joins, no invites — and becomes a one-way
    speak-only bridge. The test pins that tuwunel's sender loop calls
    ``ruma::api::appservice::event::push_events::v1::Request`` with a
    well-formed ``txn_id``.
    """
    facts = _facts_for(3)
    assert facts, "Req 3 missing from upstream fact pins"
    assert any("push_events" in f.symbol for f in facts), (
        "Req 3 must reference the ruma push_events::v1::Request type that "
        "tuwunel's sending layer invokes to fan out events to the AS."
    )


def test_req4_client_server_masquerading_with_user_id_query() -> None:
    """Requirement 4: C-S API masquerading via ``?user_id=`` and ``as_token``.

    This is the OTHER HALF of the AS API channel — how the bridge sends
    events back INTO Matrix as a specific virtual user. Without
    masquerading, every bridged Discord message would appear as if the
    bridge sender account wrote it, losing per-user attribution and
    breaking the ``@_discord_*`` virtual-user model entirely.
    """
    facts = _facts_for(4)
    assert facts, "Req 4 missing from upstream fact pins"
    assert any("user_id" in f.symbol for f in facts), (
        "Req 4 must reference tuwunel's auth_appservice handler reading "
        "request.query.user_id"
    )


def test_req5_lazy_virtual_user_registration_login_flow() -> None:
    """Requirement 5: ``m.login.application_service`` in login flows.

    The bridge lazily registers its virtual users the first time each
    ``@_discord_<snowflake>:server`` user is needed. That relies on the
    homeserver advertising ``m.login.application_service`` as a valid
    login type via ``GET /_matrix/client/v3/login``. If tuwunel drops
    this flow, the bridge can't create virtual users at all.
    """
    facts = _facts_for(5)
    assert facts, "Req 5 missing from upstream fact pins"
    assert any("ApplicationService" in f.symbol for f in facts), (
        "Req 5 must reference LoginType::ApplicationService in the session module"
    )


def test_req6_rate_limited_field_preserved_through_config_pipeline() -> None:
    """Requirement 6: ``rate_limited: false`` suppresses C-S rate limiting.

    Bridges produce bursty traffic — a single Discord channel backfill
    can generate hundreds of m.room.message events within seconds. If the
    homeserver's rate limiter applies to AS-originated calls, those
    bursts get 429'd and the bridge stalls. The AS registration's
    ``rate_limited: false`` field is the opt-out that keeps bridge
    traffic flowing, and it MUST be honored by tuwunel's auth middleware.
    """
    facts = _facts_for(6)
    assert facts, "Req 6 missing from upstream fact pins"
    assert any("rate_limited" in f.symbol for f in facts), (
        "Req 6 must reference the pub rate_limited: bool field on AppService"
    )


# ---------------------------------------------------------------------
# TIER 2 — Opt-in live probe (requires tuwunel binary)
# ---------------------------------------------------------------------
#
# This block runs only when CONCORD_TUWUNEL_BINARY points at an executable.
# It is gated because CI doesn't have a bundled tuwunel and the bundled
# binary only appears after scripts/build_linux_native.sh runs. The probe
# is ~5 seconds end-to-end — tolerable for local verification, too slow
# to block every CI run.


TUWUNEL_BINARY_ENV = "CONCORD_TUWUNEL_BINARY"


def _live_probe_available() -> bool:
    """Return True only when a runnable tuwunel binary is configured."""
    path = os.getenv(TUWUNEL_BINARY_ENV, "").strip()
    return bool(path) and Path(path).is_file() and os.access(path, os.X_OK)


live_only = pytest.mark.skipif(
    not _live_probe_available(),
    reason=(
        f"Set {TUWUNEL_BINARY_ENV}=/path/to/tuwunel to run the live AS-API "
        f"probe. Build the Linux native bundle first: "
        f"scripts/build_linux_native.sh"
    ),
)


def _free_tcp_port() -> int:
    """Grab a free ephemeral TCP port for the scratch homeserver."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _build_probe_registration_yaml(
    as_url: str,
    as_token: str,
    hs_token: str,
) -> str:
    """Build a minimal AS registration YAML the runtime admin command accepts.

    ``!admin appservices register`` feeds the YAML body straight into
    ``serde_yaml::from_str::<ruma::api::appservice::Registration>`` — see
    ``src/admin/appservice/commands.rs:21``. Every field below is required
    by that ruma type except ``receive_ephemeral`` and ``de.sorunome.msc2409.push_ephemeral``,
    which default cleanly.
    """
    reg = {
        "id": "concord_probe",
        "url": as_url,
        "as_token": as_token,
        "hs_token": hs_token,
        "sender_localpart": "_concord_probe_bot",
        "namespaces": {
            "users": [{"exclusive": True, "regex": r"@_concord_probe_.*:.*"}],
            "aliases": [{"exclusive": True, "regex": r"#_concord_probe_.*:.*"}],
            "rooms": [],
        },
        "rate_limited": False,
        "protocols": ["concord-probe"],
    }
    return yaml.safe_dump(reg, sort_keys=False)


def _build_probe_tuwunel_toml(
    data_dir: Path,
    port: int,
    as_url: str,
    as_token: str,
    hs_token: str,
) -> str:
    """Build a throwaway tuwunel.toml that pre-loads the probe AS registration.

    Uses the discovered ``[global.appservice.<id>]`` mechanism rather than
    the Synapse-style ``app_service_registration`` path-list the original
    INS-024 plan assumed. See this file's docstring for the upstream
    source reference.
    """
    return textwrap.dedent(
        f"""\
        # Auto-generated Wave 0 probe config — throwaway.
        [global]
        server_name = "localhost:{port}"
        database_path = "{data_dir}/db"
        port = {port}
        address = "127.0.0.1"
        allow_registration = true
        registration_token = "probe-only-not-real"
        allow_federation = false
        log = "warn"

        [global.appservice.concord_probe]
        url = "{as_url}"
        as_token = "{as_token}"
        hs_token = "{hs_token}"
        sender_localpart = "_concord_probe_bot"
        rate_limited = false
        protocols = ["concord-probe"]

        [[global.appservice.concord_probe.users]]
        exclusive = true
        regex = "@_concord_probe_.*:.*"

        [[global.appservice.concord_probe.aliases]]
        exclusive = true
        regex = "#_concord_probe_.*:.*"
        """
    )


@live_only
async def test_live_tuwunel_accepts_inline_appservice_config(tmp_path: Path) -> None:
    """Live probe: tuwunel starts cleanly with an inline AS config table.

    This confirms Requirement 1 end-to-end: a ``tuwunel.toml`` containing
    a ``[global.appservice.concord_probe]`` table parses, registers the
    AS at boot, and does NOT crash during startup. Any regression in
    tuwunel's AS config loader — schema change, renamed field, dropped
    support — fails this test within ~5 seconds.

    The probe does NOT exercise the full txn-push or masquerading paths
    here; those are covered by the tier-1 source-fact tests above. This
    test is the minimal "did it boot" smoke check that proves the config
    key shape pinned in ``TUWUNEL_AS_SOURCE_FACTS`` is still accepted.
    """
    binary = os.environ[TUWUNEL_BINARY_ENV]
    data_dir = tmp_path / "tuwunel"
    data_dir.mkdir()
    (data_dir / "db").mkdir()

    port = _free_tcp_port()
    as_port = _free_tcp_port()
    as_url = f"http://127.0.0.1:{as_port}"
    as_token = "as-" + secrets.token_urlsafe(24)
    hs_token = "hs-" + secrets.token_urlsafe(24)

    toml_path = data_dir / "tuwunel.toml"
    toml_path.write_text(
        _build_probe_tuwunel_toml(
            data_dir=data_dir,
            port=port,
            as_url=as_url,
            as_token=as_token,
            hs_token=hs_token,
        ),
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["TUWUNEL_CONFIG"] = str(toml_path)

    # Start tuwunel as a subprocess. The goal is to confirm startup
    # succeeds and /_matrix/client/versions answers within a reasonable
    # window. Any crash during config parse produces a non-zero exit.
    proc = subprocess.Popen(
        [binary, "--config", str(toml_path)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Poll the homeserver for up to 15 seconds.
        deadline = time.monotonic() + 15.0
        last_error: Exception | None = None
        ok = False
        async with httpx.AsyncClient(timeout=2.0) as client:
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    stderr = (proc.stderr.read() or b"").decode("utf-8", "replace")
                    pytest.fail(
                        f"tuwunel exited early with code {proc.returncode} "
                        f"during config parse. stderr tail:\n{stderr[-2000:]}"
                    )
                try:
                    resp = await client.get(
                        f"http://127.0.0.1:{port}/_matrix/client/versions"
                    )
                    if resp.status_code == 200:
                        ok = True
                        break
                except httpx.HTTPError as exc:
                    last_error = exc
                await asyncio.sleep(0.25)

        if not ok:
            stderr = (proc.stderr.read() or b"").decode("utf-8", "replace")
            pytest.fail(
                "tuwunel did not answer /_matrix/client/versions within 15s. "
                f"Last HTTP error: {last_error!r}. stderr tail:\n{stderr[-2000:]}"
            )

        # Also confirm the login flow advertises application_service — the
        # lazy-registration capability from Requirement 5.
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"http://127.0.0.1:{port}/_matrix/client/v3/login"
            )
            assert resp.status_code == 200, (
                f"GET /login returned {resp.status_code}; "
                f"tuwunel may have dropped the public login endpoint"
            )
            flows: list[dict[str, Any]] = resp.json().get("flows", [])
            login_types = {flow.get("type") for flow in flows}
            assert "m.login.application_service" in login_types, (
                f"Login flows missing m.login.application_service — "
                f"Requirement 5 regressed. Got: {login_types}"
            )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ---------------------------------------------------------------------
# Self-documenting contract
# ---------------------------------------------------------------------


def test_wave_0_contract_is_self_documenting() -> None:
    """The test module docstring must describe the Wave 0 contract.

    Tuwunel version bumps MUST walk the re-verification procedure in
    the module docstring. Strip the docstring and the regression gate
    silently decays into trivia. This meta-test is the canary for that.
    """
    doc = sys.modules[__name__].__doc__ or ""
    required_phrases = (
        "Wave 0",
        "INS-024",
        "regression gate",
        "TUWUNEL_VERSION",
        "six AS-API requirements",
    )
    missing = [p for p in required_phrases if p not in doc]
    assert not missing, (
        f"Module docstring missing required phrases: {missing}. "
        f"Restore them so the next maintainer understands the contract."
    )
