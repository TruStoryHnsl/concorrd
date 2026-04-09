"""Structured error handling for the Concord API.

This module is the source of truth for machine-readable error codes.
Every endpoint that can fail in a recurring, classifiable way should
raise ``ConcordError`` with one of the codes documented below. Plain
``HTTPException`` is still acceptable for trivial 404s, but anything a
client might want to handle programmatically (auth failures, validation
beyond Pydantic, rate limits, ownership checks, etc.) should go through
``ConcordError`` so the response shape is consistent.

## Error code registry

| Code | HTTP | Description |
|------|------|-------------|
| `AUTH_INVALID_TOKEN` | 401 | Bearer token missing, malformed, or rejected by Matrix homeserver |
| `AUTH_REQUIRED` | 401 | Endpoint requires an authenticated session |
| `AUTH_FORBIDDEN` | 403 | Authenticated but not authorized for this resource |
| `ADMIN_REQUIRED` | 403 | Caller is not in the global admin allowlist |
| `OWNER_REQUIRED` | 403 | Caller is not the owner of the target server/place |
| `MEMBER_REQUIRED` | 403 | Caller is not a member of the target server |
| `RESOURCE_NOT_FOUND` | 404 | Generic 404 (server, channel, member, lock, vote, etc.) |
| `RESOURCE_CONFLICT` | 409 | Resource already exists or duplicate state (e.g. already banned) |
| `INPUT_INVALID` | 400 | Validation error not caught by Pydantic (e.g. semantic check) |
| `INVITE_INVALID` | 400 | Invite token does not exist, is expired, or is exhausted |
| `INVITE_EXHAUSTED` | 400 | Invite has reached its max_uses |
| `RATE_LIMITED` | 429 | Per-IP/per-user rate limit exceeded |
| `MATRIX_UPSTREAM` | 502 | Matrix homeserver returned an unexpected error |
| `DOCKER_UPSTREAM` | 502 | docker-socket-proxy unreachable or rejected the call |
| `INTERNAL_ERROR` | 500 | Unhandled exception caught by the global handler — never leaks stack traces |
| `DISPOSABLE_NODE_REJECTED` | 403 | Disposable node was rejected (banned, place restricted, etc.) |
| `OWNERSHIP_TRANSFER_FAILED` | 400 | Re-mint pre-flight check failed (target user invalid, etc.) |
| `LEDGER_NOT_FOUND` | 404 | Cannot read the place ledger for re-minting |
| `ENCRYPTION_NOT_AVAILABLE` | 501 | Feature requires an encryption backend that is not yet implemented (re-mint with encrypted=True) |
| `REMINT_SNAPSHOT_INCOMPLETE` | 500 | Re-mint snapshot is missing channel or member data required to reconstruct the place |

## Stack trace policy

``ConcordError.details`` MUST NOT contain exception tracebacks. The
global exception handler in ``main.py`` is responsible for logging the
full traceback server-side via the standard ``logging`` module while
returning only the safe ``ErrorResponse`` body to the client.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class ErrorResponse(BaseModel):
    """JSON body returned for every ConcordError."""

    error_code: str
    message: str
    details: dict[str, Any] | None = None


class ConcordError(Exception):
    """Domain exception with a stable error code and HTTP status.

    Use this instead of ``HTTPException`` for any error a client might
    branch on programmatically. The exception is converted to an
    ``ErrorResponse`` JSON body by the global handler in ``main.py``.

    Example::

        raise ConcordError(
            error_code="INVITE_EXHAUSTED",
            message="Invite has reached its maximum uses",
            status_code=400,
        )
    """

    def __init__(
        self,
        error_code: str,
        message: str,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        self.details = details

    def to_response(self) -> ErrorResponse:
        return ErrorResponse(
            error_code=self.error_code,
            message=self.message,
            details=self.details,
        )
