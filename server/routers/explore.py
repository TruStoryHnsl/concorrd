"""Public-facing federation discovery ("explore") endpoints.

This router exposes the Concord instance's current federation allowlist in
a form suitable for the client-side "Explore servers" UI. It is a thin,
read-only projection over the same ``tuwunel.toml`` state that the admin
allowlist writer (``/api/admin/federation/allowlist``) owns — meaning any
change the admin makes shows up here on the next request, no separate
store to keep in sync.

Design notes:
- Auth: the endpoint requires a logged-in user (via ``get_user_id``) but
  NOT admin. Browsing the allowlist is a regular-user feature.
- Shape: ``{domain, name, description}`` matches the explore card model
  the frontend already uses for server discovery. ``description`` is
  ``None`` for now because the allowlist TOML only stores hostnames;
  richer metadata can be added later without changing the wire contract.
- Decoding: the TOML persists anchored regex patterns
  (``^matrix\\.org$``). We run them back through
  :func:`decode_server_name_patterns` to surface plain hostnames. Patterns
  that can't be decoded (hand-edited advanced regexes) are returned
  verbatim — the UI will render them as-is rather than silently hiding
  entries the admin took the trouble to add.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from routers.servers import get_user_id
from services.tuwunel_config import (
    decode_server_name_patterns,
    read_federation,
)

router = APIRouter(prefix="/api/explore", tags=["explore"])


class ExploreServerEntry(BaseModel):
    """A single federated server entry in the explore list.

    ``domain`` is the canonical identifier and is always equal to ``name``
    for now. They are kept as separate fields so a future change can
    introduce human-friendly display names (stored elsewhere) without
    breaking the wire contract clients already depend on.
    """

    domain: str
    name: str
    description: str | None = None


@router.get("/servers", response_model=list[ExploreServerEntry])
async def list_federated_servers(
    user_id: str = Depends(get_user_id),
) -> list[ExploreServerEntry]:
    """Return the federation allowlist as a list of explore cards.

    Any authenticated user may call this. The endpoint is a projection
    over ``read_federation()`` — no separate cache, no extra state — so
    the explore list is always consistent with what the admin last saved
    in ``tuwunel.toml``.
    """
    # ``read_federation()`` is synchronous blocking I/O: it opens
    # ``tuwunel.toml``, takes an ``fcntl`` exclusive lock, and parses
    # TOML. Calling it directly from this async handler would stall the
    # FastAPI event loop for the duration of the lock + parse, hurting
    # concurrent request latency on a shared worker. Offload it to the
    # default thread-pool executor instead. We intentionally do NOT
    # rewrite ``read_federation`` itself — it has other (also-async)
    # callers in ``routers/admin.py`` that would need the same treatment
    # and the targeted fix here keeps the blast radius small.
    loop = asyncio.get_event_loop()
    settings = await loop.run_in_executor(None, read_federation)
    hostnames = decode_server_name_patterns(settings.allowed_remote_server_names)
    return [
        ExploreServerEntry(domain=host, name=host, description=None)
        for host in hostnames
    ]
