"""
Rolling server auth codes (INS-020).

Each Concord server has a 6-character alphabetic code that rotates
every 10 minutes. Derived deterministically from the server's secret
+ the current time window via HMAC-SHA256, so every member computing
it at the same time gets the same code — no sync needed.

The code is an ADDITIONAL layer on top of invite tokens. To join a
server you need: invite token + current auth code. The invite token
proves someone created an invitation; the auth code proves someone
currently inside the server shared it recently (within the last
10 minutes).
"""

import hmac
import hashlib
import time

# Window size in seconds. Code rotates every 10 minutes.
WINDOW_SECONDS = 600


def generate_auth_code(secret: str, window_offset: int = 0) -> str:
    """Generate a 6-character uppercase alphabetic code.

    Args:
        secret: The server's auth_code_secret (hex string).
        window_offset: 0 for current window, -1 for previous window
            (useful for grace-period validation at rotation boundaries).

    Returns:
        6-char uppercase string like "KBMWPF".
    """
    time_window = int(time.time()) // WINDOW_SECONDS + window_offset
    digest = hmac.new(
        secret.encode(),
        str(time_window).encode(),
        hashlib.sha256,
    ).hexdigest()
    code = ""
    for i in range(6):
        val = int(digest[i * 2 : i * 2 + 2], 16) % 26
        code += chr(ord("A") + val)
    return code


def validate_auth_code(secret: str, code: str) -> bool:
    """Check if `code` matches the current or previous window's code.

    Accepting the previous window provides a ~10-minute grace period
    at rotation boundaries so a code shared just before rotation
    doesn't immediately become invalid.
    """
    upper = code.strip().upper()
    if len(upper) != 6 or not upper.isalpha():
        return False
    return upper == generate_auth_code(secret, 0) or upper == generate_auth_code(secret, -1)


def seconds_until_rotation() -> int:
    """Seconds remaining until the next code rotation."""
    return WINDOW_SECONDS - (int(time.time()) % WINDOW_SECONDS)
