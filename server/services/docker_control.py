"""Thin async wrapper around the docker-socket-proxy sidecar.

We use `tecnativa/docker-socket-proxy` (running inside the concord compose
network) instead of mounting the real `/var/run/docker.sock` into the
concord-api container. The proxy accepts the Docker Engine API unchanged
but enforces an allowlist of routes (configured via CONTAINERS=1 POST=1
in docker-compose.yml). Any request to a blocked route returns 403 before
touching the real socket.

This module exposes :func:`restart_compose_service` for federation
allowlist apply (the conduwuit restart). If we ever need more (inspect
volumes, pull images, prune), extend here rather than scattering docker
calls across routers.
"""
from __future__ import annotations

import logging
import os
import time

import httpx

logger = logging.getLogger(__name__)

# Inside the concord docker network. The proxy listens on 2375 by default.
DOCKER_PROXY_URL = os.getenv(
    "DOCKER_PROXY_URL", "http://docker-socket-proxy:2375"
)

# Default operation timeouts. Restart is blocking in the Docker API and
# returns once the container has actually come back up, so we need a
# generous timeout. Tuwunel typically restarts in 5-15s; 60s is a safety
# margin for slow hosts.
_CONNECT_TIMEOUT = 5.0
_RESTART_TIMEOUT = 60.0


class DockerControlError(RuntimeError):
    """Raised when the docker-socket-proxy call fails or returns non-2xx."""


async def restart_compose_service(service_name: str) -> dict:
    """Restart every container belonging to a docker-compose service.

    Looks up containers by the ``com.docker.compose.service`` label (which
    docker-compose writes automatically on every container it creates) so
    we don't have to care about the actual container name pattern (e.g.
    ``concord-conduwuit-1`` vs ``concord_conduwuit_1``).

    Returns a dict with ``restarted`` (list of container IDs) and
    ``elapsed_seconds``. Raises :class:`DockerControlError` if the proxy
    is unreachable, the service is not found, or the Docker API rejects
    the restart.
    """
    start = time.monotonic()

    async with httpx.AsyncClient(
        base_url=DOCKER_PROXY_URL,
        timeout=httpx.Timeout(
            connect=_CONNECT_TIMEOUT,
            read=_RESTART_TIMEOUT,
            write=_CONNECT_TIMEOUT,
            pool=_CONNECT_TIMEOUT,
        ),
    ) as client:
        # 1) Find the container(s) by compose-service label.
        filters = f'{{"label":["com.docker.compose.service={service_name}"]}}'
        try:
            resp = await client.get(
                "/containers/json",
                params={"filters": filters, "all": "true"},
            )
        except httpx.HTTPError as exc:
            raise DockerControlError(
                f"docker-socket-proxy unreachable at {DOCKER_PROXY_URL}: {exc}"
            ) from exc

        if resp.status_code == 403:
            raise DockerControlError(
                "docker-socket-proxy denied /containers/json — "
                "check that CONTAINERS=1 is set on the proxy"
            )
        if resp.status_code != 200:
            raise DockerControlError(
                f"docker-socket-proxy returned {resp.status_code} "
                f"on /containers/json: {resp.text}"
            )

        containers = resp.json()
        if not containers:
            raise DockerControlError(
                f"No running container with label "
                f"com.docker.compose.service={service_name} — is it up?"
            )

        restarted: list[str] = []
        for c in containers:
            cid = c["Id"]
            short = cid[:12]
            logger.info("restarting container %s (service=%s)", short, service_name)
            try:
                rr = await client.post(f"/containers/{cid}/restart")
            except httpx.HTTPError as exc:
                raise DockerControlError(
                    f"Restart call failed for {short}: {exc}"
                ) from exc

            if rr.status_code == 403:
                raise DockerControlError(
                    f"docker-socket-proxy denied restart for {short} — "
                    "check that POST=1 is set on the proxy"
                )
            if rr.status_code not in (204, 304):
                raise DockerControlError(
                    f"Docker restart returned {rr.status_code} "
                    f"for {short}: {rr.text}"
                )
            restarted.append(short)

    elapsed = time.monotonic() - start
    logger.info(
        "restart_compose_service(%s) completed: %d container(s) in %.2fs",
        service_name, len(restarted), elapsed,
    )
    return {"restarted": restarted, "elapsed_seconds": round(elapsed, 2)}


async def _list_compose_containers(
    service_name: str,
    *,
    all_states: bool,
) -> list[dict]:
    """Shared helper — list containers by compose-service label.

    Uses the ``all=true`` flag so stopped containers show up too, which
    matters for :func:`start_compose_service` (the common case is
    starting a container that already exists but is stopped). Callers
    that only want running containers should filter on the ``State``
    field returned by the proxy.
    """
    filters = f'{{"label":["com.docker.compose.service={service_name}"]}}'
    params = {"filters": filters}
    if all_states:
        params["all"] = "true"
    async with httpx.AsyncClient(
        base_url=DOCKER_PROXY_URL,
        timeout=httpx.Timeout(
            connect=_CONNECT_TIMEOUT,
            read=_RESTART_TIMEOUT,
            write=_CONNECT_TIMEOUT,
            pool=_CONNECT_TIMEOUT,
        ),
    ) as client:
        try:
            resp = await client.get("/containers/json", params=params)
        except httpx.HTTPError as exc:
            raise DockerControlError(
                f"docker-socket-proxy unreachable at {DOCKER_PROXY_URL}: {exc}"
            ) from exc
        if resp.status_code == 403:
            raise DockerControlError(
                "docker-socket-proxy denied /containers/json — "
                "check that CONTAINERS=1 is set on the proxy"
            )
        if resp.status_code != 200:
            raise DockerControlError(
                f"docker-socket-proxy returned {resp.status_code} "
                f"on /containers/json: {resp.text}"
            )
        return resp.json()


async def is_service_running(service_name: str) -> bool:
    """Return ``True`` when at least one container for ``service_name`` is
    in the ``running`` state.

    Heuristic used by ``/api/hosting/profile`` to report whether the web
    stack is actually up. ``running`` is the Docker Engine API's
    own ``State`` value — anything else (``exited``, ``created``,
    ``paused``, ``restarting``) is treated as not-running for the
    purpose of the UI badge.

    Swallows :class:`DockerControlError` to ``False`` because the
    profile endpoint is a status read, not an enforcement point — a
    proxy-down or service-missing condition is "stack not running"
    from the operator's perspective, and the surrounding hosting
    status surface already carries actionable diagnostics for those
    cases.
    """
    try:
        containers = await _list_compose_containers(
            service_name, all_states=True
        )
    except DockerControlError:
        return False
    return any(c.get("State") == "running" for c in containers)


async def start_compose_service(service_name: str) -> dict:
    """Start every container belonging to a docker-compose service.

    Looks up containers by the ``com.docker.compose.service`` label
    (same as :func:`restart_compose_service`). Containers already in
    the ``running`` state are skipped — this call is idempotent so
    the Phase 7 "enable web stack" toggle can be re-pressed without
    error if a previous attempt half-completed.

    Returns a dict with ``started`` (list of container short IDs that
    transitioned from stopped to running), ``already_running`` (list of
    short IDs that were already up), and ``elapsed_seconds``. Raises
    :class:`DockerControlError` if the proxy is unreachable, the
    service has no containers (compose hasn't been ``up``'d at all),
    or the Docker API rejects the start.
    """
    start = time.monotonic()
    containers = await _list_compose_containers(service_name, all_states=True)
    if not containers:
        raise DockerControlError(
            f"No container with label "
            f"com.docker.compose.service={service_name} — "
            "is the compose stack defined and at least once `up`'d?"
        )

    started: list[str] = []
    already_running: list[str] = []
    async with httpx.AsyncClient(
        base_url=DOCKER_PROXY_URL,
        timeout=httpx.Timeout(
            connect=_CONNECT_TIMEOUT,
            read=_RESTART_TIMEOUT,
            write=_CONNECT_TIMEOUT,
            pool=_CONNECT_TIMEOUT,
        ),
    ) as client:
        for c in containers:
            cid = c["Id"]
            short = cid[:12]
            if c.get("State") == "running":
                already_running.append(short)
                continue
            logger.info(
                "starting container %s (service=%s)", short, service_name
            )
            try:
                rr = await client.post(f"/containers/{cid}/start")
            except httpx.HTTPError as exc:
                raise DockerControlError(
                    f"Start call failed for {short}: {exc}"
                ) from exc
            if rr.status_code == 403:
                raise DockerControlError(
                    f"docker-socket-proxy denied start for {short} — "
                    "check that POST=1 is set on the proxy"
                )
            # 204 = started, 304 = already running (idempotent).
            if rr.status_code not in (204, 304):
                raise DockerControlError(
                    f"Docker start returned {rr.status_code} "
                    f"for {short}: {rr.text}"
                )
            started.append(short)
    elapsed = time.monotonic() - start
    logger.info(
        "start_compose_service(%s) done: started=%d already=%d in %.2fs",
        service_name, len(started), len(already_running), elapsed,
    )
    return {
        "started": started,
        "already_running": already_running,
        "elapsed_seconds": round(elapsed, 2),
    }


