import logging
from email.message import EmailMessage

import aiosmtplib

from config import SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SITE_URL, INSTANCE_SETTINGS_FILE, INSTANCE_NAME_DEFAULT

logger = logging.getLogger(__name__)


def is_configured() -> bool:
    return bool(SMTP_HOST and SMTP_FROM)


def _instance_name() -> str:
    import json
    if INSTANCE_SETTINGS_FILE.exists():
        try:
            return json.loads(INSTANCE_SETTINGS_FILE.read_text()).get("name", INSTANCE_NAME_DEFAULT)
        except Exception:
            pass
    return INSTANCE_NAME_DEFAULT


async def send_invite_email(
    to_email: str,
    invite_token: str,
    server_name: str,
    inviter_name: str,
) -> None:
    """Send an invite link to an email address."""
    if not is_configured():
        raise RuntimeError("SMTP is not configured")

    invite_url = f"{SITE_URL}?invite={invite_token}"

    msg = EmailMessage()
    app_name = _instance_name()
    msg["Subject"] = f"You've been invited to {server_name} on {app_name}"
    msg["From"] = SMTP_FROM
    msg["To"] = to_email

    msg.set_content(
        f"{inviter_name} invited you to join {server_name} on {app_name}.\n\n"
        f"Click here to join: {invite_url}\n\n"
        f"If you don't have an account, you'll be able to create one.\n"
    )

    msg.add_alternative(
        f"""<div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
  <h2 style="color: #e4e4e7; margin: 0 0 8px;">{app_name}</h2>
  <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 24px;">You've been invited to a server</p>
  <div style="background: #27272a; border-radius: 12px; padding: 24px; border: 1px solid #3f3f46;">
    <p style="color: #d4d4d8; margin: 0 0 4px;"><strong>{inviter_name}</strong> invited you to join</p>
    <p style="color: #818cf8; font-size: 20px; font-weight: 600; margin: 0 0 20px;">{server_name}</p>
    <a href="{invite_url}"
       style="display: inline-block; background: #4f46e5; color: white; text-decoration: none;
              padding: 12px 24px; border-radius: 8px; font-weight: 500; font-size: 14px;">
      Join Server
    </a>
  </div>
  <p style="color: #71717a; font-size: 12px; margin: 16px 0 0;">
    If you don't have an account, you'll be able to create one.
  </p>
</div>""",
        subtype="html",
    )

    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        username=SMTP_USER or None,
        password=SMTP_PASSWORD or None,
        start_tls=True,
    )
    logger.info("Invite email sent to %s for server %s", to_email, server_name)
