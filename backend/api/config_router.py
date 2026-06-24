"""
Configuration REST API endpoints.
Allows reading and live-updating a safe subset of config values.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["config"])


class ConfigUpdate(BaseModel):
    """Only these fields can be changed at runtime without restarting."""
    home_lat: Optional[float] = None
    home_lon: Optional[float] = None
    home_label: Optional[str] = None
    default_range_nm: Optional[int] = None
    use_mock_source: Optional[bool] = None


@router.get("/config", response_model=Dict[str, Any])
async def get_config(request: Request):
    """Return the current application configuration (safe fields only)."""
    cfg = request.app.state.config
    return {
        "radar": {
            "home_lat": cfg.radar.home_lat,
            "home_lon": cfg.radar.home_lon,
            "home_label": cfg.radar.home_label,
            "range_options": cfg.radar.range_options,
            "default_range_nm": cfg.radar.default_range_nm,
            "refresh_interval_sec": cfg.radar.refresh_interval_sec,
            "track_points": cfg.radar.track_points,
        },
        "opensky": {
            "enabled": cfg.opensky.enabled,
            "poll_interval_sec": cfg.opensky.poll_interval_sec,
            # Do NOT expose client_id / client_secret
        },
        "development": {
            "use_mock_source": cfg.development.use_mock_source,
        },
        "server": {
            "host": cfg.server.host,
            "port": cfg.server.port,
        },
    }


@router.post("/config", response_model=Dict[str, Any])
async def update_config(update: ConfigUpdate, request: Request):
    """
    Update a safe subset of config values at runtime.
    Changes take effect on the next data polling cycle.
    Note: Changes are NOT persisted to config.yaml — restart to reset.
    """
    cfg = request.app.state.config
    dm = request.app.state.data_manager

    if update.home_lat is not None:
        cfg.radar.home_lat = update.home_lat
        dm._home_lat = update.home_lat
    if update.home_lon is not None:
        cfg.radar.home_lon = update.home_lon
        dm._home_lon = update.home_lon
    if update.home_label is not None:
        cfg.radar.home_label = update.home_label
    if update.default_range_nm is not None:
        cfg.radar.default_range_nm = update.default_range_nm
    if update.use_mock_source is not None:
        cfg.development.use_mock_source = update.use_mock_source
        request.app.state.source_manager._dev_mode = update.use_mock_source

    return {"success": True, "message": "Config updated"}
