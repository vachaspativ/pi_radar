"""
Aircraft REST API endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any, Dict, List

# These are injected at startup in main.py via app.state
from fastapi import Request

router = APIRouter(prefix="/api", tags=["aircraft"])


@router.get("/aircraft", response_model=List[Dict[str, Any]])
async def get_aircraft(request: Request):
    """Return all currently tracked aircraft with positions and metadata."""
    dm = request.app.state.data_manager
    return dm.get_all()


@router.get("/aircraft/{icao}", response_model=Dict[str, Any])
async def get_single_aircraft(icao: str, request: Request):
    """Return details for a single aircraft by its ICAO hex address."""
    dm = request.app.state.data_manager
    result = dm.get_one(icao.lower())
    if result is None:
        raise HTTPException(status_code=404, detail=f"Aircraft {icao} not found")
    return result


@router.get("/status", response_model=Dict[str, Any])
async def get_status(request: Request):
    """Return system status: source name, aircraft count, last update time."""
    dm = request.app.state.data_manager
    ws_mgr = request.app.state.ws_manager
    status = dm.get_status()
    status["ws_clients"] = ws_mgr.connection_count
    return status
