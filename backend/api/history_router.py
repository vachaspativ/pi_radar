"""
Flight history REST API endpoints.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List

from fastapi import APIRouter, Query, Request

from backend.db.database import get_track_history, get_replay_snapshot

router = APIRouter(prefix="/api", tags=["history"])


@router.get("/history/{icao}", response_model=List[Dict[str, Any]])
async def get_aircraft_history(
    icao: str,
    from_ts: int = Query(default=None, description="Start Unix timestamp"),
    to_ts: int = Query(default=None, description="End Unix timestamp"),
):
    """
    Return the stored track history for a single aircraft.
    Defaults to the last hour if no timestamps are provided.
    """
    now = int(time.time())
    _from = from_ts if from_ts else now - 3600
    _to = to_ts if to_ts else now
    return await get_track_history(icao.lower(), from_ts=_from, to_ts=_to)


@router.get("/replay", response_model=Dict[str, Any])
async def get_replay(
    from_ts: int = Query(..., description="Start Unix timestamp"),
    to_ts: int = Query(..., description="End Unix timestamp"),
):
    """
    Return all aircraft positions within a time window (for replay).
    Groups positions by 5-second buckets to match the original refresh rate.
    """
    rows = await get_replay_snapshot(from_ts, to_ts)

    # Group by time bucket (5-second windows)
    buckets: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        bucket = (row["recorded_at"] // 5) * 5
        buckets.setdefault(bucket, []).append(row)

    return {
        "from_ts": from_ts,
        "to_ts": to_ts,
        "total_records": len(rows),
        "buckets": [
            {"ts": ts, "aircraft": acs}
            for ts, acs in sorted(buckets.items())
        ],
    }
