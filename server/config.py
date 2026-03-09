import os
from pathlib import Path

DATA_DIR = Path(os.getenv("CONCORRD_DATA_DIR", "/home/corr/projects/concorrd/data/concorrd"))
DATABASE_URL = f"sqlite+aiosqlite:///{DATA_DIR / 'concorrd.db'}"
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
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
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

# Instance name (configurable by admin, default from env or "Concord")
INSTANCE_NAME_DEFAULT = os.getenv("INSTANCE_NAME", "Concord")
INSTANCE_SETTINGS_FILE = DATA_DIR / "instance.json"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
SOUNDBOARD_DIR.mkdir(parents=True, exist_ok=True)
