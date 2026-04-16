"""Admin router for service-node resource + role configuration (INS-023).

Provides two endpoints:

GET /api/admin/service-node
    Returns the current :class:`ServiceNodeConfig` plus a ``limits`` block
    containing the compile-time maxima so the UI can render slider bounds
    without hardcoding them. Admin-gated.

PUT /api/admin/service-node
    Validates and persists a new :class:`ServiceNodeConfig`. Admin-gated.

Both endpoints use :func:`services.service_node_config.load_config` /
:func:`services.service_node_config.save_config` which write atomically
(tmp + fsync + rename) under ``$CONCORD_DATA_DIR/service_node.json``.
"""
from __future__ import annotations

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from routers.admin import require_admin
from routers.servers import get_user_id
from services.service_node_config import (
    ALLOWED_ROLES,
    MAX_BANDWIDTH_MBPS,
    MAX_CPU_PERCENT,
    MAX_STORAGE_GB,
    NodeRole,
    ServiceNodeConfig,
    ServiceNodeConfigError,
    load_config,
    save_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/service-node", tags=["service-node"])


# ---------------------------------------------------------------------------
# Wire models (Pydantic V2, strict-extra)
# ---------------------------------------------------------------------------

class ServiceNodeLimits(BaseModel):
    """Compile-time maxima exposed to the UI for slider bounds."""

    max_cpu_percent: int = MAX_CPU_PERCENT
    max_bandwidth_mbps: int = MAX_BANDWIDTH_MBPS
    max_storage_gb: int = MAX_STORAGE_GB
    allowed_roles: list[str] = list(ALLOWED_ROLES)


class ServiceNodeResponse(BaseModel):
    """Full config + limits block returned from GET."""

    model_config = {"extra": "forbid"}

    max_cpu_percent: int
    max_bandwidth_mbps: int
    max_storage_gb: int
    tunnel_anchor_enabled: bool
    node_role: str
    limits: ServiceNodeLimits


class ServiceNodePutBody(BaseModel):
    """Validated input for PUT /api/admin/service-node."""

    model_config = {"extra": "forbid"}

    max_cpu_percent: int = Field(
        ...,
        ge=1,
        le=MAX_CPU_PERCENT,
        description=f"Percentage of CPU cores offered to the mesh (1–{MAX_CPU_PERCENT}).",
    )
    max_bandwidth_mbps: int = Field(
        ...,
        ge=0,
        le=MAX_BANDWIDTH_MBPS,
        description="Upstream bandwidth offered in Mbps. 0 means unlimited.",
    )
    max_storage_gb: int = Field(
        ...,
        ge=0,
        le=MAX_STORAGE_GB,
        description="Storage offered in GB. 0 means unlimited.",
    )
    tunnel_anchor_enabled: bool = Field(
        ...,
        description="Whether this node accepts inbound WireGuard sessions.",
    )
    node_role: Annotated[str, Field(description="One of: frontend-only, hybrid, anchor.")]

    @classmethod
    def __get_validators__(cls):  # noqa: D105
        yield cls.validate

    def to_service_node_config(self) -> ServiceNodeConfig:
        """Convert to the domain dataclass. Raises ``ServiceNodeConfigError``
        on semantic violations (e.g. anchor without tunnel_anchor_enabled)."""
        cfg = ServiceNodeConfig(
            max_cpu_percent=self.max_cpu_percent,
            max_bandwidth_mbps=self.max_bandwidth_mbps,
            max_storage_gb=self.max_storage_gb,
            tunnel_anchor_enabled=self.tunnel_anchor_enabled,
            node_role=self.node_role,  # type: ignore[arg-type]
        )
        cfg.validate()
        return cfg


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=ServiceNodeResponse)
async def get_service_node_config(
    user_id: str = Depends(get_user_id),
) -> ServiceNodeResponse:
    """Return the current service-node configuration + compile-time limits.

    Admin-gated. Non-admins receive 403.
    """
    require_admin(user_id)
    cfg = load_config()
    return ServiceNodeResponse(
        max_cpu_percent=cfg.max_cpu_percent,
        max_bandwidth_mbps=cfg.max_bandwidth_mbps,
        max_storage_gb=cfg.max_storage_gb,
        tunnel_anchor_enabled=cfg.tunnel_anchor_enabled,
        node_role=cfg.node_role,
        limits=ServiceNodeLimits(),
    )


@router.put("", response_model=ServiceNodeResponse)
async def put_service_node_config(
    body: ServiceNodePutBody,
    user_id: str = Depends(get_user_id),
) -> ServiceNodeResponse:
    """Validate and persist a new service-node configuration.

    Admin-gated. Pydantic field constraints (ge/le) enforce the numeric
    ranges; semantic validation (anchor requires tunnel_anchor_enabled) is
    done by :class:`ServiceNodeConfig.validate`.
    """
    require_admin(user_id)

    # Validate node_role against the allowed set (Pydantic Literal would
    # require listing the tuple inline; using a runtime check keeps the
    # allowed values DRY with the service layer).
    if body.node_role not in ALLOWED_ROLES:
        from fastapi import HTTPException
        from fastapi.responses import JSONResponse
        raise HTTPException(
            status_code=422,
            detail=[{
                "loc": ["body", "node_role"],
                "msg": f"node_role must be one of {ALLOWED_ROLES}",
                "type": "value_error",
            }],
        )

    try:
        cfg = ServiceNodeConfig(
            max_cpu_percent=body.max_cpu_percent,
            max_bandwidth_mbps=body.max_bandwidth_mbps,
            max_storage_gb=body.max_storage_gb,
            tunnel_anchor_enabled=body.tunnel_anchor_enabled,
            node_role=body.node_role,  # type: ignore[arg-type]
        )
        cfg.validate()
    except ServiceNodeConfigError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    saved = save_config(cfg)
    logger.info("service-node config updated by %s: role=%s", user_id, saved.node_role)

    return ServiceNodeResponse(
        max_cpu_percent=saved.max_cpu_percent,
        max_bandwidth_mbps=saved.max_bandwidth_mbps,
        max_storage_gb=saved.max_storage_gb,
        tunnel_anchor_enabled=saved.tunnel_anchor_enabled,
        node_role=saved.node_role,
        limits=ServiceNodeLimits(),
    )
