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


