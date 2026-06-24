"""
dump1090-fa data source.

Polls the dump1090-fa local HTTP JSON endpoint every refresh cycle
and normalises the response into the standard Aircraft dataclass.

dump1090-fa JSON format (per aircraft):
{
  "hex": "a1b2c3",
  "flight": "UAL123  ",
  "alt_baro": 35000,         # feet (or "ground")
  "gs": 480.0,               # ground speed in knots
  "track": 275.0,            # heading/track degrees
  "lat": 33.12,
  "lon": -97.45,
  "baro_rate": -64,          # vertical rate ft/min
  "squawk": "1200",
  "seen": 1.2,               # seconds since last message
  "seen_pos": 3.5,           # seconds since last position
}
"""

from __future__ import annotations

from typing import Optional

import httpx

from .base_source import Aircraft, BaseSource, SourceResult


class Dump1090Source(BaseSource):
    """Reads live ADS-B data from dump1090-fa's JSON HTTP endpoint."""

    def __init__(self, url: str, timeout_sec: float = 2.0) -> None:
        self._url = url
        self._timeout = timeout_sec

    @property
    def name(self) -> str:
        return "RTL-SDR (dump1090-fa)"

    async def fetch(self) -> SourceResult:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(self._url)
                resp.raise_for_status()
                data = resp.json()

            raw_aircraft = data.get("aircraft", [])
            aircraft = [
                self._parse(ac) for ac in raw_aircraft
                if self._has_position(ac)
            ]
            return SourceResult(
                aircraft=[a for a in aircraft if a is not None],
                source_name=self.name,
                success=True,
            )

        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            return SourceResult(
                aircraft=[],
                source_name=self.name,
                success=False,
                error=f"Connection failed: {exc}",
            )
        except Exception as exc:
            return SourceResult(
                aircraft=[],
                source_name=self.name,
                success=False,
                error=f"Unexpected error: {exc}",
            )

    @staticmethod
    def _has_position(raw: dict) -> bool:
        return raw.get("lat") is not None and raw.get("lon") is not None

    @staticmethod
    def _parse(raw: dict) -> Optional[Aircraft]:
        """Convert a raw dump1090 aircraft dict into a normalised Aircraft."""
        try:
            alt_baro = raw.get("alt_baro")
            if alt_baro == "ground":
                alt_ft: Optional[float] = 0.0
                on_ground = True
            elif isinstance(alt_baro, (int, float)):
                alt_ft = float(alt_baro)
                on_ground = False
            else:
                alt_ft = None
                on_ground = False

            callsign = raw.get("flight", "").strip() or None

            return Aircraft(
                icao=raw.get("hex", "").lower(),
                callsign=callsign,
                lat=raw.get("lat"),
                lon=raw.get("lon"),
                altitude_ft=alt_ft,
                speed_kts=raw.get("gs"),
                heading_deg=raw.get("track"),
                vertical_rate_fpm=raw.get("baro_rate"),
                squawk=raw.get("squawk"),
                on_ground=on_ground,
            )
        except Exception:
            return None
