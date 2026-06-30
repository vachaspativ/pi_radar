"""
Aircraft data manager.

Maintains the live aircraft state dict, computes bearing/distance from
home for each aircraft, and persists track history to SQLite.
"""

from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from backend.config import AppConfig
from backend.db.database import insert_tracks
from backend.sources.base_source import Aircraft

# ---------------------------------------------------------------------------
# Earth radius in nautical miles
# ---------------------------------------------------------------------------
R_NM = 3440.065


# ---------------------------------------------------------------------------
# Extended aircraft state (Aircraft + computed geo fields + trail)
# ---------------------------------------------------------------------------
@dataclass
class AircraftState:
    # Raw from source
    icao: str
    callsign: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    altitude_ft: Optional[float] = None
    speed_kts: Optional[float] = None
    heading_deg: Optional[float] = None
    vertical_rate_fpm: Optional[float] = None
    squawk: Optional[str] = None
    on_ground: bool = False

    # Computed
    bearing_deg: Optional[float] = None
    distance_nm: Optional[float] = None

    # Track history — list of {lat, lon, ts} dicts (last N positions)
    track: List[Dict[str, Any]] = field(default_factory=list)

    # Metadata
    first_seen: int = field(default_factory=lambda: int(time.time()))
    last_seen: int = field(default_factory=lambda: int(time.time()))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "icao": self.icao,
            "callsign": self.callsign,
            "lat": self.lat,
            "lon": self.lon,
            "altitude_ft": self.altitude_ft,
            "speed_kts": self.speed_kts,
            "heading_deg": self.heading_deg,
            "vertical_rate_fpm": self.vertical_rate_fpm,
            "squawk": self.squawk,
            "on_ground": self.on_ground,
            "bearing_deg": self.bearing_deg,
            "distance_nm": self.distance_nm,
            "track": self.track,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
        }


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------
def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in nautical miles."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R_NM * 2 * math.asin(math.sqrt(max(0, a)))


def bearing_to(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """True bearing (degrees, 0=North clockwise) from point 1 to point 2."""
    lat1r = math.radians(lat1)
    lat2r = math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(lat2r)
    y = (math.cos(lat1r) * math.sin(lat2r)
         - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon))
    return (math.degrees(math.atan2(x, y)) + 360) % 360


# ---------------------------------------------------------------------------
# DataManager
# ---------------------------------------------------------------------------
class DataManager:
    """
    Central store for live aircraft state.
    Updated each time the polling loop calls update().
    """

    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._home_lat = cfg.radar.home_lat
        self._home_lon = cfg.radar.home_lon
        self._max_track_points = cfg.radar.track_points

        # ICAO → AircraftState
        self._state: Dict[str, AircraftState] = {}

        # Source metadata
        self.source_name: str = "Initialising"
        self.source_live: bool = False
        self.last_update: int = 0
        self.aircraft_count: int = 0

    def set_home(self, lat: float, lon: float) -> None:
        self._home_lat = lat
        self._home_lon = lon

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def update(self, aircraft_list: List[Aircraft], source_name: str, is_live: bool) -> None:
        """
        Merge a new list of Aircraft from the source into the state dict.
        Computes bearing/distance and appends track points.
        Also persists to SQLite.
        """
        now = int(time.time())
        self.source_name = source_name
        self.source_live = is_live
        self.last_update = now

        # Mark which ICAOs are in the new batch
        seen_icaos = set()

        for ac in aircraft_list:
            if not ac.icao or ac.lat is None or ac.lon is None:
                continue

            seen_icaos.add(ac.icao)

            # Compute geo fields
            dist = haversine_nm(self._home_lat, self._home_lon, ac.lat, ac.lon)
            brng = bearing_to(self._home_lat, self._home_lon, ac.lat, ac.lon)

            if ac.icao in self._state:
                existing = self._state[ac.icao]
                existing.callsign = ac.callsign or existing.callsign
                existing.lat = ac.lat
                existing.lon = ac.lon
                existing.altitude_ft = ac.altitude_ft
                existing.speed_kts = ac.speed_kts
                existing.heading_deg = ac.heading_deg
                existing.vertical_rate_fpm = ac.vertical_rate_fpm
                existing.squawk = ac.squawk
                existing.on_ground = ac.on_ground
                existing.bearing_deg = round(brng, 1)
                existing.distance_nm = round(dist, 2)
                existing.last_seen = now

                # Append track point
                existing.track.append({"lat": ac.lat, "lon": ac.lon, "ts": now})
                # Trim to max points
                if len(existing.track) > self._max_track_points:
                    existing.track = existing.track[-self._max_track_points:]
            else:
                # New aircraft
                self._state[ac.icao] = AircraftState(
                    icao=ac.icao,
                    callsign=ac.callsign,
                    lat=ac.lat,
                    lon=ac.lon,
                    altitude_ft=ac.altitude_ft,
                    speed_kts=ac.speed_kts,
                    heading_deg=ac.heading_deg,
                    vertical_rate_fpm=ac.vertical_rate_fpm,
                    squawk=ac.squawk,
                    on_ground=ac.on_ground,
                    bearing_deg=round(brng, 1),
                    distance_nm=round(dist, 2),
                    track=[{"lat": ac.lat, "lon": ac.lon, "ts": now}],
                    first_seen=now,
                    last_seen=now,
                )

        # Remove aircraft not seen for >60 seconds
        stale_cutoff = now - 60
        stale = [icao for icao, s in self._state.items()
                 if s.last_seen < stale_cutoff]
        for icao in stale:
            del self._state[icao]

        self.aircraft_count = len(self._state)

        # Persist to SQLite asynchronously
        raw_for_db = [
            {
                "icao": ac.icao,
                "callsign": ac.callsign,
                "lat": ac.lat,
                "lon": ac.lon,
                "altitude_ft": ac.altitude_ft,
                "speed_kts": ac.speed_kts,
                "heading_deg": ac.heading_deg,
                "vertical_rate_fpm": ac.vertical_rate_fpm,
                "squawk": ac.squawk,
            }
            for ac in aircraft_list
            if ac.lat is not None and ac.lon is not None
        ]
        await insert_tracks(raw_for_db, source="live" if is_live else "api")

    def get_all(self) -> List[Dict[str, Any]]:
        """Return all current aircraft as serialisable dicts."""
        return [s.to_dict() for s in self._state.values()]

    def get_one(self, icao: str) -> Optional[Dict[str, Any]]:
        s = self._state.get(icao.lower())
        return s.to_dict() if s else None

    def get_status(self) -> Dict[str, Any]:
        return {
            "source_name": self.source_name,
            "source_live": self.source_live,
            "aircraft_count": self.aircraft_count,
            "last_update": self.last_update,
            "home_lat": self._home_lat,
            "home_lon": self._home_lon,
        }
