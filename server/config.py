import os
from pathlib import Path

DATA_DIR = Path(os.getenv("CONCORD_DATA_DIR", os.getenv("CONCORRD_DATA_DIR", "/data")))
DATABASE_URL = f"sqlite+aiosqlite:///{DATA_DIR / 'concord.db'}"
SOUNDBOARD_DIR = DATA_DIR / "soundboard"

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
