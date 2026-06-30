"""
Mock aircraft data source for development / Windows testing.

Generates realistic simulated flights centred on the configured home
location.  Aircraft follow great-circle paths, change altitude, and
disappear when they fly out of range — just like the real thing.
"""

from __future__ import annotations

import math
import random
import time
from typing import List

from .base_source import Aircraft, BaseSource, SourceResult

# ---------------------------------------------------------------------------
# Airline / flight templates for realism
# ---------------------------------------------------------------------------
CALLSIGNS = [
    "UAL", "DAL", "AAL", "SWA", "FDX", "UPS", "SKW", "ASA",
    "JBU", "WN", "NK", "F9", "BAW", "DLH", "AFR", "KLM",
    "EIN", "IBE", "THY", "SAS",
]

SQUAWKS = ["1200", "2000", "3000", "7000", "7700", "7600", "7500", "0042", "1337", "5012"]


def _random_callsign() -> str:
    prefix = random.choice(CALLSIGNS)
    number = random.randint(100, 9999)
    return f"{prefix}{number}"


def _random_icao() -> str:
    return f"{random.randint(0x800000, 0xFFFFFF):06X}".lower()


# ---------------------------------------------------------------------------
# Internal aircraft state (keeps between calls so positions update smoothly)
# ---------------------------------------------------------------------------
class _MockAircraft:
    """A single simulated aircraft that updates its own position."""

    def __init__(self, home_lat: float, home_lon: float, max_range_nm: float) -> None:
        self.icao = _random_icao()
        self.callsign = _random_callsign()
        self.squawk = random.choice(SQUAWKS)

        # Spawn at a random position within max_range_nm of home
        angle = random.uniform(0, 360)
        # Allow spawning close to home (from 0.5 NM)
        dist = random.uniform(0.5, max_range_nm * 0.9)
        self.lat, self.lon = _offset_position(home_lat, home_lon, angle, dist)

        # Flight parameters
        # Occasionally force extremely low altitude (e.g. 500 - 1500 ft) for close flights to trigger warnings
        if dist < 3.0 and random.random() < 0.5:
            self.altitude_ft = random.uniform(500, 1800)
        else:
            self.altitude_ft = random.choice([
                random.uniform(1000, 5000),    # low approach / departure
                random.uniform(15000, 25000),  # mid altitude
                random.uniform(30000, 42000),  # cruise
            ])
        self.speed_kts = random.uniform(180, 520)
        self.heading_deg = random.uniform(0, 360)
        self.vertical_rate_fpm = random.uniform(-2000, 2000)

        # State
        self.last_update = time.monotonic()
        self._home_lat = home_lat
        self._home_lon = home_lon
        self._max_range_nm = max_range_nm
        self._age_sec = 0.0

    def update(self) -> None:
        """Move the aircraft forward based on elapsed time."""
        now = time.monotonic()
        dt = now - self.last_update
        self.last_update = now
        self._age_sec += dt

        # Move position (speed in knots → nm/sec → degrees per second approx)
        dist_nm = self.speed_kts * dt / 3600.0
        self.lat, self.lon = _offset_position(
            self.lat, self.lon, self.heading_deg, dist_nm
        )

        # Slowly adjust altitude
        self.altitude_ft += self.vertical_rate_fpm * dt / 60.0
        self.altitude_ft = max(0, min(45000, self.altitude_ft))

        # Occasionally wobble heading slightly (turns / wind)
        self.heading_deg = (self.heading_deg + random.uniform(-1.5, 1.5)) % 360

        # Gradually slow vertical rate toward cruise
        if abs(self.altitude_ft - 35000) < 2000:
            self.vertical_rate_fpm *= 0.95

    def is_in_range(self) -> bool:
        dist = _haversine_nm(
            self._home_lat, self._home_lon, self.lat, self.lon
        )
        return dist <= self._max_range_nm * 1.1

    def to_aircraft(self) -> Aircraft:
        return Aircraft(
            icao=self.icao,
            callsign=self.callsign,
            lat=self.lat,
            lon=self.lon,
            altitude_ft=round(self.altitude_ft, 0),
            speed_kts=round(self.speed_kts, 1),
            heading_deg=round(self.heading_deg, 1),
            vertical_rate_fpm=round(self.vertical_rate_fpm, 0),
            squawk=self.squawk,
            on_ground=self.altitude_ft < 100,
        )


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------
def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R_NM = 3440.065
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R_NM * 2 * math.asin(math.sqrt(a))


def _offset_position(lat: float, lon: float, bearing_deg: float, dist_nm: float):
    """Move a point by `dist_nm` nautical miles in direction `bearing_deg`."""
    R_NM = 3440.065
    d = dist_nm / R_NM
    brng = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(d)
        + math.cos(lat1) * math.sin(d) * math.cos(brng)
    )
    lon2 = lon1 + math.atan2(
        math.sin(brng) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


# ---------------------------------------------------------------------------
# Source class
# ---------------------------------------------------------------------------
class MockSource(BaseSource):
    """Simulated aircraft data source for development and Windows testing."""

    def __init__(
        self,
        home_lat: float,
        home_lon: float,
        count: int = 18,
        max_range_nm: float = 220,
    ) -> None:
        self._home_lat = home_lat
        self._home_lon = home_lon
        self._max_range_nm = max_range_nm
        self._count = count
        self._fleet: List[_MockAircraft] = []
        self._init_fleet()

    def set_home(self, lat: float, lon: float) -> None:
        self._home_lat = lat
        self._home_lon = lon
        for ac in self._fleet:
            ac._home_lat = lat
            ac._home_lon = lon

    def _init_fleet(self) -> None:
        self._fleet = [
            _MockAircraft(self._home_lat, self._home_lon, self._max_range_nm)
            for _ in range(self._count)
        ]

    @property
    def name(self) -> str:
        return "Mock (Development)"

    async def fetch(self) -> SourceResult:
        """Update all aircraft positions and return the current fleet."""
        # Remove aircraft that have flown out of range
        self._fleet = [ac for ac in self._fleet if ac.is_in_range()]

        # Update positions
        for ac in self._fleet:
            ac.update()

        # Replenish fleet to maintain target count
        while len(self._fleet) < self._count:
            self._fleet.append(
                _MockAircraft(self._home_lat, self._home_lon, self._max_range_nm)
            )

        aircraft = [ac.to_aircraft() for ac in self._fleet]
        return SourceResult(
            aircraft=aircraft,
            source_name=self.name,
            success=True,
        )
