"""
Source manager — decides which data source to use and switches
automatically between: Mock → dump1090-fa → OpenSky fallback.

Priority order (when not in dev mode):
  1. dump1090-fa (local RTL-SDR)          ← preferred
  2. OpenSky Network (internet API)        ← fallback if dump1090 fails 3x
  3. Return empty list + stale flag        ← if both fail
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

from backend.config import AppConfig
from .base_source import SourceResult
from .mock_source import MockSource
from .dump1090_source import Dump1090Source
from .opensky_source import OpenSkySource


class SourceManager:
    """
    Manages data source selection and automatic fallback.
    Call fetch() from the background polling loop.
    """

    def __init__(self, cfg: AppConfig) -> None:
        self._cfg = cfg
        self._dev_mode = cfg.development.use_mock_source

        # Instantiate sources
        self._mock = MockSource(
            home_lat=cfg.radar.home_lat,
            home_lon=cfg.radar.home_lon,
            count=cfg.development.mock_aircraft_count,
        )

        self._dump1090 = Dump1090Source(
            url=cfg.dump1090.url,
            timeout_sec=cfg.dump1090.timeout_sec,
        )

        self._opensky = OpenSkySource(
            client_id=cfg.opensky.client_id,
            client_secret=cfg.opensky.client_secret,
            home_lat=cfg.radar.home_lat,
            home_lon=cfg.radar.home_lon,
            margin_deg=cfg.opensky.bounding_box_margin_deg,
        )

        # State
        self._failure_count: int = 0
        self._using_fallback: bool = False
        self._last_opensky_poll: float = 0.0
        self._last_result: Optional[SourceResult] = None
        self._current_source_name: str = "Initialising"

    def set_home(self, lat: float, lon: float) -> None:
        self._mock.set_home(lat, lon)
        self._opensky.set_home(lat, lon)

    @property
    def current_source_name(self) -> str:
        return self._current_source_name

    @property
    def is_live(self) -> bool:
        """True when receiving from RTL-SDR, False on fallback/mock."""
        return not self._dev_mode and not self._using_fallback

    async def fetch(self) -> SourceResult:
        """
        Fetch aircraft data from the best available source.
        Handles failure counting and automatic fallback.
        """
        # ── Development / Windows mock mode ─────────────────────────────
        if self._dev_mode:
            result = await self._mock.fetch()
            self._current_source_name = result.source_name
            self._last_result = result
            return result

        # ── Production: try dump1090-fa first ───────────────────────────
        result = await self._dump1090.fetch()

        if result.success:
            if self._failure_count > 0 or self._using_fallback:
                print("[SourceMgr] dump1090 recovered — switching back to LIVE")
            self._failure_count = 0
            self._using_fallback = False
            self._current_source_name = result.source_name
            self._last_result = result
            return result

        # dump1090 failed
        self._failure_count += 1
        print(
            f"[SourceMgr] dump1090 failure {self._failure_count}"
            f"/{self._cfg.dump1090.failure_threshold}: {result.error}"
        )

        if self._failure_count >= self._cfg.dump1090.failure_threshold:
            self._using_fallback = True

        # ── Fallback: OpenSky (rate-limited polling) ─────────────────────
        if self._using_fallback and self._cfg.opensky.enabled:
            now = time.monotonic()
            since_last = now - self._last_opensky_poll
            poll_interval = self._cfg.opensky.poll_interval_sec

            if since_last >= poll_interval:
                self._last_opensky_poll = now
                os_result = await self._opensky.fetch()
                if os_result.success:
                    self._current_source_name = os_result.source_name
                    self._last_result = os_result
                    return os_result
                else:
                    print(f"[SourceMgr] OpenSky also failed: {os_result.error}")
            else:
                # Return last known OpenSky result until next poll window
                if self._last_result and self._last_result.source_name == self._opensky.name:
                    return self._last_result

        # ── Nothing worked — return stale or empty ───────────────────────
        if self._last_result:
            # Return stale data with a flag so the UI can show a warning
            stale = SourceResult(
                aircraft=self._last_result.aircraft,
                source_name="Stale (no feed)",
                success=False,
                error="No live or fallback data available",
            )
            self._current_source_name = stale.source_name
            return stale

        self._current_source_name = "No Data"
        return SourceResult(aircraft=[], source_name="No Data", success=False,
                            error="All sources unavailable")
