"""Bridge bootstrap: run at concord-api startup.

## Purpose

In the user-scoped bridge model (see
``docs/bridges/user-scoped-bridge-redesign.md``), the bridge is
invisible infrastructure — there is no admin Enable button. The bridge
must be registered with conduwuit automatically whenever concord-api
starts, so that when a user clicks "Connect Discord" the bridge is
already live and ready to accept the login DM.

## States and actions

On startup we read two pieces of state:

* ``registration.yaml`` — the bridge's own registration file. When
  present it contains the ``as_token``/``hs_token`` pair the bridge
  uses to authenticate to conduwuit. When absent, the bridge has no
  credentials.
* ``tuwunel.toml`` appservice entries — conduwuit's view of which
  bridges it accepts traffic from. When absent, conduwuit rejects all
  appservice pushes from the bridge regardless of what registration
  thinks.

The bootstrap reconciles these two:

================================  ==================================  =====================================
registration.yaml                 tuwunel.toml entry                  action
================================  ==================================  =====================================
missing                           missing                             fresh enable: generate + write + restart
missing                           present (any id)                    orphan tuwunel entry → strip; no new reg
present, id=X, matches constant   present with id=X, matching tokens  steady state → do nothing
present, id=X, matches constant   missing or wrong id or wrong tokens re-inject registration into tuwunel + restart
present, id=X, id mismatch const  any                                 full reset: regenerate with new id
================================  ==================================  =====================================

The "do nothing" path is the common case — on a running, healthy
instance, bootstrap is an idempotent no-op with no conduwuit restart.
Restarts only happen on drift or fresh install.

## Trust and admin carve-outs

Even in the user-scoped model, an admin can still manually delete
``registration.yaml`` from disk (e.g. to force a token rotation). When
they do, bootstrap treats that as "fresh enable" on the next restart.
The admin disable flow (PR4 removes this) does the same: deletes the
registration, and the next restart re-creates it. This means the
bridge is functionally always-on from a user perspective — disable is
transient.

## Non-goals

* Starting the bridge container itself. That's the job of docker-compose
  ``depends_on`` + the bridge's own ``restart: unless-stopped``.
* Writing the bridge's ``config-runtime.yaml``. That's still part of
  the enable flow today; kept separate so PR4's bot-token removal can
  touch it without touching bootstrap.
* Per-user state. User sessions are managed by mautrix-discord itself
  in its own DB; the bootstrap is for instance-level registration
  only.
"""
from __future__ import annotations

import logging

from services.bridge_config import (
    BridgeConfigError,
    DISCORD_BRIDGE_APPSERVICE_ID,
    delete_registration_file,
    ensure_appservice_entry,
    generate_registration,
    read_appservice_ids,
    read_registration_file,
    remove_all_concord_appservice_entries,
    write_registration_file,
)
from services.docker_control import (
    DockerControlError,
    restart_compose_service,
)

logger = logging.getLogger(__name__)


async def bootstrap_bridge_registration() -> dict:
    """Reconcile ``registration.yaml`` and ``tuwunel.toml``.

    Returns a dict with ``{action, changed, restarted_conduwuit}`` so
    the caller (lifespan) can log a concise summary.

    Never raises on drift or missing files — bootstrap is best-effort.
    If something prevents reconciliation (I/O error, docker-socket
    down), we log a warning and return ``action="degraded"`` so the
    instance can still come up. The admin UI can surface the problem
    via the existing status endpoint + PR1's desync detection.
    """
    result = {
        "action": "noop",
        "changed": False,
        "restarted_conduwuit": False,
    }

    try:
        registration = read_registration_file()
    except BridgeConfigError as exc:
        logger.warning(
            "bridge bootstrap: registration file unreadable: %s — skipping",
            exc,
        )
        result["action"] = "degraded"
        result["detail"] = f"unreadable registration: {exc}"
        return result

    try:
        tuwunel_ids = read_appservice_ids()
    except Exception as exc:  # noqa: BLE001 — tuwunel.toml might be absent or malformed
        logger.warning(
            "bridge bootstrap: tuwunel.toml unreadable: %s — skipping",
            exc,
        )
        result["action"] = "degraded"
        result["detail"] = f"unreadable tuwunel.toml: {exc}"
        return result

    # Case 1: both missing — fresh install or first-ever boot.
    if registration is None and not tuwunel_ids:
        return await _fresh_enable(result)

    # Case 2: tuwunel has entries but no registration — orphans. Clean
    # them up silently; admin probably disabled and the restart lost
    # the restart-conduwuit step midway.
    if registration is None and tuwunel_ids:
        return _strip_orphans(result, tuwunel_ids)

    # Case 3: registration present but id doesn't match the current
    # constant (e.g. code was upgraded and the ID changed). Full reset
    # with new tokens under the new ID.
    assert registration is not None
    if registration.id != DISCORD_BRIDGE_APPSERVICE_ID:
        logger.info(
            "bridge bootstrap: registration id=%s doesn't match current "
            "constant=%s — full reset",
            registration.id, DISCORD_BRIDGE_APPSERVICE_ID,
        )
        return await _full_reset(result)

    # Case 4: registration present with correct id, but not in tuwunel
    # OR tuwunel has other stale ids. Re-inject + restart.
    needs_inject = registration.id not in tuwunel_ids
    stale_others = [i for i in tuwunel_ids if i != registration.id]
    if needs_inject or stale_others:
        return await _reconcile_tuwunel(result, registration, stale_others)

    # Case 5: fully in sync. No-op.
    logger.debug("bridge bootstrap: registration + tuwunel in sync, no action")
    return result


async def _fresh_enable(result: dict) -> dict:
    """No registration + no tuwunel entry: generate fresh everything."""
    registration = generate_registration()
    try:
        write_registration_file(registration)
        ensure_appservice_entry(registration)
    except BridgeConfigError as exc:
        logger.error("bridge bootstrap: fresh enable failed: %s", exc)
        result["action"] = "degraded"
        result["detail"] = f"fresh enable failed: {exc}"
        return result

    restarted = await _try_restart_conduwuit()
    result["action"] = "fresh_enable"
    result["changed"] = True
    result["restarted_conduwuit"] = restarted
    logger.info(
        "bridge bootstrap: fresh enable complete (restarted_conduwuit=%s)",
        restarted,
    )
    return result


async def _full_reset(result: dict) -> dict:
    """Wipe all state (registration + all tuwunel entries), then
    fresh enable. Used when the current-constant ID doesn't match
    what's on disk."""
    try:
        removed_ids = remove_all_concord_appservice_entries()
        delete_registration_file()
    except BridgeConfigError as exc:
        logger.error("bridge bootstrap: full reset failed: %s", exc)
        result["action"] = "degraded"
        result["detail"] = f"full reset failed: {exc}"
        return result

    logger.info(
        "bridge bootstrap: full reset cleared stale ids=%s — generating fresh",
        removed_ids,
    )
    return await _fresh_enable(result)


async def _reconcile_tuwunel(
    result: dict,
    registration,
    stale_others: list[str],
) -> dict:
    """Registration is fine; tuwunel drifted. Strip stale entries,
    inject the live registration, restart conduwuit."""
    try:
        if stale_others:
            remove_all_concord_appservice_entries()
        ensure_appservice_entry(registration)
    except BridgeConfigError as exc:
        logger.error("bridge bootstrap: tuwunel reconcile failed: %s", exc)
        result["action"] = "degraded"
        result["detail"] = f"tuwunel reconcile failed: {exc}"
        return result

    restarted = await _try_restart_conduwuit()
    result["action"] = "reconciled_tuwunel"
    result["changed"] = True
    result["restarted_conduwuit"] = restarted
    logger.info(
        "bridge bootstrap: tuwunel re-synced to id=%s (stale removed=%s, "
        "restarted_conduwuit=%s)",
        registration.id, stale_others, restarted,
    )
    return result


def _strip_orphans(result: dict, tuwunel_ids: list[str]) -> dict:
    """Registration missing but tuwunel has entries — silently strip.

    Intentionally does NOT restart conduwuit: conduwuit will ignore
    appservice pushes it has no record for anyway, and a restart would
    drop live federation connections. Next boot after admin re-enables
    will restart conduwuit as part of the enable flow.
    """
    try:
        removed_ids = remove_all_concord_appservice_entries()
    except BridgeConfigError as exc:
        logger.warning("bridge bootstrap: orphan strip failed: %s", exc)
        result["action"] = "degraded"
        result["detail"] = f"orphan strip failed: {exc}"
        return result

    result["action"] = "stripped_orphans"
    result["changed"] = bool(removed_ids)
    logger.info(
        "bridge bootstrap: stripped orphan tuwunel entries %s (no registration present)",
        removed_ids,
    )
    return result


async def _try_restart_conduwuit() -> bool:
    """Attempt conduwuit restart; return True on success.

    Failures (docker-socket-proxy down, conduwuit already stopped) are
    logged but not fatal. concord-api can still come up — the admin
    will see a desync warning via the status endpoint and can
    manually restart later.
    """
    try:
        await restart_compose_service("conduwuit")
        return True
    except DockerControlError as exc:
        logger.warning(
            "bridge bootstrap: conduwuit restart failed: %s — "
            "bridge registration written to disk but homeserver has not "
            "been reloaded. Restart conduwuit manually or via the admin UI.",
            exc,
        )
        return False
