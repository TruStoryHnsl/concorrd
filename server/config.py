import os
from pathlib import Path

DATA_DIR = Path(os.getenv("CONCORD_DATA_DIR", "/data"))
DATABASE_URL = f"sqlite+aiosqlite:///{DATA_DIR / 'concord.db'}"
SOUNDBOARD_DIR = DATA_DIR / "soundboard"
# INS-066: where unpacked runtime-installed extension bundles live.
# Each subdirectory is a single extension keyed by its reverse-domain id,
# e.g. ``EXTENSIONS_DIR / "com.concord.orrdia-bridge" / "index.html"``.
EXTENSIONS_DIR = DATA_DIR / "extensions"

# INS-051: canonical default domain root. Operators who do not supply
# a custom domain advertise their instance at ``<slug>.concordchat.net``
# automatically. Override with CONCORD_DEFAULT_DOMAIN_ROOT for alternate
# forks.
CONCORD_DEFAULT_DOMAIN_ROOT = (
    os.getenv("CONCORD_DEFAULT_DOMAIN_ROOT", "concordchat.net").strip().lstrip(".")
    or "concordchat.net"
)

# Matrix homeserver (internal Docker network or local dev)
MATRIX_HOMESERVER_URL = os.getenv("MATRIX_HOMESERVER_URL", "http://localhost:8080")
MATRIX_SERVER_NAME = os.getenv("CONDUWUIT_SERVER_NAME", "localhost")
MATRIX_REGISTRATION_TOKEN = os.getenv("CONDUWUIT_REGISTRATION_TOKEN", "")

if not MATRIX_REGISTRATION_TOKEN:
    raise RuntimeError(
        "CONDUWUIT_REGISTRATION_TOKEN must be set. "
        "Refusing to start with empty registration token."
    )

# SMTP (email invites)
SMTP_HOST = os.getenv("SMTP_HOST", "")
try:
    SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
except ValueError:
    SMTP_PORT = 587
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "")
SITE_URL = os.getenv("SITE_URL", "http://localhost:8080")

# PUBLIC_BASE_URL is the canonical public-facing origin clients reach
# this instance at. It's the source of truth for derivations like
# INSTANCE_DOMAIN (used for auto-deriving TURN_HOST, TURN_DOMAIN, etc.)
# rather than relying on hand-edited per-component env vars.
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", SITE_URL).rstrip("/")


def _derive_instance_domain(base_url: str) -> str:
    """Extract the bare hostname from PUBLIC_BASE_URL.

    Example: ``https://chat.example.com:8443/`` -> ``chat.example.com``.
    Used as the single input from which TURN_HOST, TURN_DOMAIN, and
    other per-component public addresses are derived — operators set
    ONE knob (the public URL of their instance) rather than keeping
    a handful of redundant env vars in sync.
    """
    from urllib.parse import urlparse

    parsed = urlparse(base_url if "://" in base_url else f"https://{base_url}")
    host = parsed.hostname or ""
    return host.strip().lower()


# INSTANCE_DOMAIN: the bare hostname of this Concord instance.
# Derived from PUBLIC_BASE_URL once, at import time. Empty string if
# PUBLIC_BASE_URL can't be parsed — downstream callers handle that by
# treating the instance as "no public domain configured."
INSTANCE_DOMAIN = _derive_instance_domain(PUBLIC_BASE_URL)

# Freesound API (sound effect library)
FREESOUND_API_KEY = os.getenv("FREESOUND_API_KEY", "")

# Global admin user IDs (comma-separated Matrix user IDs)
ADMIN_USER_IDS: set[str] = {
    uid.strip()
    for uid in os.getenv("ADMIN_USER_IDS", "").split(",")
    if uid.strip()
}

# Instance name (configurable by admin, falls back to server name)
INSTANCE_NAME_DEFAULT = os.getenv("INSTANCE_NAME", MATRIX_SERVER_NAME)
INSTANCE_SETTINGS_FILE = DATA_DIR / "instance.json"

# INS-028: GitHub bug report integration. When GITHUB_BUG_REPORT_TOKEN
# is set to a fine-grained personal access token with `issues:write`
# scoped to the concord repository ONLY, the `submit_bug_report`
# handler mirrors each new report to a GitHub issue. The token's
# blast radius is limited to creating issues on that one repo — it
# cannot read private code, modify workflows, or touch the
# homeserver. When the token is empty (the default), the mirror is
# skipped silently and bug reports are stored only in the local DB.
# Operators roll the token by generating a new PAT, updating the env
# var, and restarting concord-api — there is no in-process cache to
# invalidate. See `docs/deployment/github_bug_report_token.md` for
# the full rotation runbook and threat model.
GITHUB_BUG_REPORT_TOKEN = os.getenv("GITHUB_BUG_REPORT_TOKEN", "")
GITHUB_BUG_REPORT_REPO = os.getenv("GITHUB_BUG_REPORT_REPO", "TruStoryHnsl/concord")

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
SOUNDBOARD_DIR.mkdir(parents=True, exist_ok=True)
EXTENSIONS_DIR.mkdir(parents=True, exist_ok=True)
