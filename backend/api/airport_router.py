"""
Airport API — fetches airports within the current radar bounding box
from the OpenStreetMap Overpass API (free, no auth required).

Results are cached in memory for 30 minutes since airports don't move.

Endpoint:
    GET /api/airports?range_nm=100
"""

from __future__ import annotations

import math
import time
from typing import Any, Dict, List

import httpx
from fastapi import APIRouter, Request

router = APIRouter(prefix="/api", tags=["airports"])

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
CACHE_TTL_SEC = 1800  # 30 minutes

# In-memory cache: dict keyed by (home_lat, home_lon, range_bucket) → entry
_cache: Dict[tuple, Dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
@router.get("/airports")
async def get_airports(request: Request, range_nm: float = 100.0) -> List[Dict]:
    """
    Return all aerodromes within range_nm nautical miles of the configured
    home location.  Results are served from a 30-minute in-memory cache.
    """
    cfg = request.app.state.config
    home_lat: float = cfg.radar.home_lat
    home_lon: float = cfg.radar.home_lon

    # Round range to the nearest 25 nm bucket to maximise cache hits
    range_bucket = max(25, min(200, round(range_nm / 25) * 25))
    cache_key = (round(home_lat, 4), round(home_lon, 4), range_bucket)

    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and cached["expires"] > now:
        print(f"[Airports] Cache hit — {len(cached['data'])} airports")
        return cached["data"]

    airports = await _fetch_airports(home_lat, home_lon, float(range_bucket))
    if airports is None:
        # Do not cache query failures (e.g. rate limits), return empty list
        return []

    _cache[cache_key] = {"data": airports, "expires": now + CACHE_TTL_SEC}
    return airports


# ---------------------------------------------------------------------------
# Overpass query helper
# ---------------------------------------------------------------------------
async def _fetch_airports(
    home_lat: float,
    home_lon: float,
    range_nm: float,
) -> List[Dict] | None:
    """
    Query the Overpass API for all aerodrome nodes/ways/relations
    within a bounding box derived from home + range_nm.
    """
    # Convert nm to degrees (rough approximation — fine for bounding box)
    margin_lat = range_nm / 60.0 * 1.15
    margin_lon = range_nm / (60.0 * math.cos(math.radians(home_lat))) * 1.15

    lamin = home_lat - margin_lat
    lamax = home_lat + margin_lat
    lomin = home_lon - margin_lon
    lomax = home_lon + margin_lon

    query = (
        f"[out:json][timeout:25];\n"
        f"(\n"
        f'  node["aeroway"="aerodrome"]({lamin},{lomin},{lamax},{lomax});\n'
        f'  way["aeroway"="aerodrome"]({lamin},{lomin},{lamax},{lomax});\n'
        f'  relation["aeroway"="aerodrome"]({lamin},{lomin},{lamax},{lomax});\n'
        f");\n"
        f"out center;\n"
    )

    try:
        from urllib.parse import urlencode
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                OVERPASS_URL,
                content=urlencode({"data": query}).encode(),
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "PiRadar/1.0 (ADS-B flight display; contact via github.com/vachaspativ/pi_radar)",
                    "Accept": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        print(f"[Airports] Overpass query failed: {exc}")
        return None

    airports: List[Dict] = []
    for elem in data.get("elements", []):
        # Nodes have lat/lon directly; ways/relations have a "center" object
        lat = elem.get("lat") or (elem.get("center") or {}).get("lat")
        lon = elem.get("lon") or (elem.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue

        tags = elem.get("tags", {})
        icao = tags.get("icao") or ""
        iata = tags.get("iata") or ""
        faa = tags.get("faa") or ""

        # Only show airports with at least one official identifier (large/public airports)
        if not (icao or iata or faa):
            continue

        name = (
            tags.get("name")
            or icao
            or iata
            or faa
            or "Unknown"
        )
        airports.append(
            {
                "icao": icao,
                "iata": iata,
                "faa": faa,
                "name": name,
                "lat": float(lat),
                "lon": float(lon),
                "type": tags.get("aerodrome:type") or tags.get("aeroway") or "aerodrome",
            }
        )

    print(f"[Airports] Fetched {len(airports)} aerodromes (range={range_nm}nm)")
    return airports
