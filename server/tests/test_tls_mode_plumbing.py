"""Static checks for the TLS_MODE plumbing.

This file lives in the server test tree so it runs as part of the
default `pytest -v` job, but it doesn't test the FastAPI server —
TLS termination is Caddy's job and the .env / Caddyfile / docker-compose
contract is what we lock down here. The Caddy-binary-level adaptation
check lives in `scripts/lint_tls_mode_matrix.sh` (CI runs it as a
separate step because it needs the Docker daemon, which the pytest
job intentionally avoids).

What this module asserts:

  1. Each TLS_MODE value documented in the operator matrix has a
     matching `(tls_mode_<value>)` snippet defined in BOTH Caddyfiles.
  2. Each Caddyfile imports a tls_mode snippet at the top of the
     site block via `import tls_mode_{$TLS_MODE:<default>}`.
  3. The prod Caddyfile defaults to letsencrypt_http01; the dev
     Caddyfile defaults to internal_longlived.
  4. docker-compose.yml passes TLS_MODE / ACME_EMAIL /
     CLOUDFLARE_API_TOKEN to the web service.
  5. .env.example documents all three env vars + each mode by name.

Drift on any of these is what would make `docker compose up -d`
explode at Caddy startup instead of at PR-review time.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

TLS_MODES = (
    "internal_longlived",
    "letsencrypt_http01",
    "letsencrypt_dns01_cloudflare",
)


@pytest.fixture(scope="module")
def caddyfile_prod() -> str:
    return (REPO_ROOT / "config" / "Caddyfile").read_text()


@pytest.fixture(scope="module")
def caddyfile_dev() -> str:
    return (REPO_ROOT / "config" / "Caddyfile.dev").read_text()


@pytest.fixture(scope="module")
def env_example() -> str:
    return (REPO_ROOT / ".env.example").read_text()


@pytest.fixture(scope="module")
def compose_yml() -> str:
    return (REPO_ROOT / "docker-compose.yml").read_text()


@pytest.fixture(scope="module")
def compose_dev_yml() -> str:
    return (REPO_ROOT / "docker-compose.dev.yml").read_text()


@pytest.mark.parametrize("mode", TLS_MODES)
def test_prod_caddyfile_defines_tls_mode_snippet(caddyfile_prod: str, mode: str) -> None:
    assert f"(tls_mode_{mode})" in caddyfile_prod, (
        f"config/Caddyfile is missing the (tls_mode_{mode}) snippet — "
        "operator picking that TLS_MODE value would crash at Caddy startup."
    )


@pytest.mark.parametrize("mode", TLS_MODES)
def test_dev_caddyfile_defines_tls_mode_snippet(caddyfile_dev: str, mode: str) -> None:
    assert f"(tls_mode_{mode})" in caddyfile_dev, (
        f"config/Caddyfile.dev is missing the (tls_mode_{mode}) snippet — "
        "operator picking that TLS_MODE value would crash at Caddy startup."
    )


def test_prod_caddyfile_default_is_letsencrypt_http01(caddyfile_prod: str) -> None:
    # The site block must import via the env-var-driven default, and
    # the default for prod must be letsencrypt_http01 — that's the
    # behaviour pre-TLS_MODE operators are relying on (auto-ACME on
    # any domain SITE_ADDRESS).
    assert (
        "import tls_mode_{$TLS_MODE:letsencrypt_http01}" in caddyfile_prod
    ), (
        "config/Caddyfile must default TLS_MODE to letsencrypt_http01 "
        "via `import tls_mode_{$TLS_MODE:letsencrypt_http01}`; "
        "changing the default is a breaking change for existing operators."
    )


def test_dev_caddyfile_default_is_internal_longlived(caddyfile_dev: str) -> None:
    # The dev default must stay internal_longlived because that's
    # what Tailscale-only / LAN-only dev deployments depend on (the
    # long-lived self-signed cert that survives the no-public-ACME
    # topology). PR #91 shipped this; PR-current task keeps it as
    # the fallback when TLS_MODE is empty.
    assert (
        "import tls_mode_{$TLS_MODE:internal_longlived}" in caddyfile_dev
    ), (
        "config/Caddyfile.dev must default TLS_MODE to internal_longlived "
        "via `import tls_mode_{$TLS_MODE:internal_longlived}`; "
        "changing the default would break Tailscale-only dev operators."
    )


@pytest.mark.parametrize("env_var", ("TLS_MODE", "ACME_EMAIL", "CLOUDFLARE_API_TOKEN"))
def test_compose_web_env_passes_tls_var(compose_yml: str, env_var: str) -> None:
    assert f"{env_var}:" in compose_yml, (
        f"docker-compose.yml must thread {env_var} into the web service environment "
        "so Caddy can read it."
    )


def test_compose_tls_mode_has_letsencrypt_http01_default(compose_yml: str) -> None:
    # The base compose file is the prod surface; its TLS_MODE default
    # must match the prod Caddyfile default so operators who never
    # touch TLS_MODE get auto-ACME.
    assert "TLS_MODE: ${TLS_MODE:-letsencrypt_http01}" in compose_yml, (
        "docker-compose.yml must default TLS_MODE to letsencrypt_http01 "
        "(via `${TLS_MODE:-letsencrypt_http01}`) so empty/.env-blank "
        "operators get the prod-safe default."
    )


def test_compose_dev_tls_mode_overrides_to_internal(compose_dev_yml: str) -> None:
    # The dev override must flip the default to internal_longlived;
    # otherwise the dev stack would inherit the prod default and break
    # Tailscale-only dev origins on first boot.
    assert "TLS_MODE: ${TLS_MODE:-internal_longlived}" in compose_dev_yml, (
        "docker-compose.dev.yml must override TLS_MODE to internal_longlived "
        "so Tailscale-only / LAN-only dev origins keep working when the "
        "operator leaves TLS_MODE blank in .env."
    )


@pytest.mark.parametrize("env_var", ("TLS_MODE", "ACME_EMAIL", "CLOUDFLARE_API_TOKEN"))
def test_env_example_documents_var(env_example: str, env_var: str) -> None:
    assert f"{env_var}=" in env_example, (
        f".env.example must contain a `{env_var}=` line so operators "
        "see the knob in the canonical config template."
    )


@pytest.mark.parametrize("mode", TLS_MODES)
def test_env_example_documents_mode_value(env_example: str, mode: str) -> None:
    assert mode in env_example, (
        f".env.example must mention the `{mode}` TLS_MODE value in the "
        "operator-facing comment block so the matrix is self-documenting."
    )
