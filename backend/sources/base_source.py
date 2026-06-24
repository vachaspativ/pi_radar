"""
Abstract base class for all aircraft data sources.
Every source (mock, dump1090, OpenSky) must implement this interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Aircraft:
    """Normalised aircraft record. All sources produce this structure."""

    icao: str                           # ICAO 24-bit hex (e.g. "a1b2c3")
    callsign: Optional[str] = None      # Flight callsign / registration
    lat: Optional[float] = None         # Latitude (decimal degrees)
    lon: Optional[float] = None         # Longitude (decimal degrees)
    altitude_ft: Optional[float] = None # Barometric altitude in feet
    speed_kts: Optional[float] = None   # Ground speed in knots
    heading_deg: Optional[float] = None # Track / heading in degrees (0–359)
    vertical_rate_fpm: Optional[float] = None  # Climb/descent rate ft/min
    squawk: Optional[str] = None        # Transponder squawk code
    on_ground: bool = False             # True if aircraft is on the ground

    # Computed fields added by DataManager (not from the raw source)
    bearing_deg: Optional[float] = None   # Bearing from home to aircraft
    distance_nm: Optional[float] = None   # Distance from home (nautical miles)


@dataclass
class SourceResult:
    """Wrapper returned by every source's fetch() call."""
    aircraft: List[Aircraft] = field(default_factory=list)
    source_name: str = "unknown"
    success: bool = True
    error: Optional[str] = None


class BaseSource(ABC):
    """All data sources must inherit from this and implement fetch()."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name for this source (e.g. 'RTL-SDR (dump1090-fa)')."""
        ...

    @abstractmethod
    async def fetch(self) -> SourceResult:
        """
        Fetch the current list of aircraft from this source.
        Must return a SourceResult. Should NOT raise exceptions —
        catch them internally and return success=False with an error message.
        """
        ...
