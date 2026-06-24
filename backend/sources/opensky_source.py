"""
OpenSky Network fallback data source.

Uses OAuth2 Client Credentials flow to authenticate, then queries
the states/all endpoint with a bounding box centred on home.

OpenSky state vector field order (index):
0  icao24          hex transponder address
1  callsign        flight callsign (may be null/empty)
2  origin_country
3  time_position   Unix timestamp of last position update
4  last_contact    Unix timestamp of last message received
5  longitude       WGS-84 longitude (degrees)
6  latitude        WGS-84 latitude (degrees)
7  baro_altitude   barometric altitude (metres)
8  on_ground       boolean
9  velocity        ground speed (m/s)
10 true_track      track angle (degrees, 0=North, clockwise)
11 vertical_rate   m/s (positive = climbing)
12 sensors         (ignored)
13 geo_altitude    geometric altitude (metres)
14 squawk
15 spi
16 position_source
"""

from __future__ import annotations

import time
from typing import Optional, List

import httpx

from .base_source import Aircraft, BaseSource, SourceResult

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)
STATES_URL = "https://opensky-network.org/api/states/all"
METERS_TO_FEET = 3.28084
MS_TO_KNOTS = 1.94384


# ---------------------------------------------------------------------------
# Source class
# ---------------------------------------------------------------------------
class OpenSkySource(BaseSource):
    """Fetches aircraft states from the OpenSky Network REST API."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        home_lat: float,
        home_lon: float,
        margin_deg: float = 2.5,
        timeout_sec: float = 10.0,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._home_lat = home_lat
        self._home_lon = home_lon
        self._margin = margin_deg
        self._timeout = timeout_sec

        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0

    @property
    def name(self) -> str:
        return "Internet (OpenSky Network)"

    # ------------------------------------------------------------------
    # OAuth2 token management
    # ------------------------------------------------------------------
    async def _get_token(self) -> Optional[str]:
        """Obtain or refresh the OAuth2 Bearer token."""
        # Return cached token if still valid (with 30s buffer)
        if self._access_token and time.time() < self._token_expires_at - 30:
            return self._access_token

        # No credentials configured — run in anonymous mode (very limited)
        if not self._client_id or self._client_id == "YOUR_CLIENT_ID_HERE":
            return None

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                resp.raise_for_status()
                token_data = resp.json()
                self._access_token = token_data["access_token"]
                expires_in = token_data.get("expires_in", 3600)
                self._token_expires_at = time.time() + expires_in
                print("[OpenSky] OAuth2 token obtained/refreshed")
                return self._access_token
        except Exception as exc:
            print(f"[OpenSky] Token refresh failed: {exc}")
            return None

    # ------------------------------------------------------------------
    # Fetch
    # ------------------------------------------------------------------
    async def fetch(self) -> SourceResult:
        token = await self._get_token()

        # Build bounding box around home
        lamin = self._home_lat - self._margin
        lamax = self._home_lat + self._margin
        lomin = self._home_lon - self._margin
        lomax = self._home_lon + self._margin

        params = {
            "lamin": lamin,
            "lomin": lomin,
            "lamax": lamax,
            "lomax": lomax,
        }

        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(STATES_URL, params=params, headers=headers)
                resp.raise_for_status()
                data = resp.json()

            states = data.get("states") or []
            aircraft: List[Aircraft] = []
            for state in states:
                ac = self._parse_state(state)
                if ac is not None:
                    aircraft.append(ac)

            print(f"[OpenSky] Fetched {len(aircraft)} aircraft")
            return SourceResult(
                aircraft=aircraft,
                source_name=self.name,
                success=True,
            )

        except httpx.HTTPStatusError as exc:
            return SourceResult(
                aircraft=[],
                source_name=self.name,
                success=False,
                error=f"HTTP {exc.response.status_code}: {exc.response.text[:120]}",
            )
        except Exception as exc:
            return SourceResult(
                aircraft=[],
                source_name=self.name,
                success=False,
                error=f"OpenSky error: {exc}",
            )

    # ------------------------------------------------------------------
    # Parser
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_state(state: list) -> Optional[Aircraft]:
        """Convert an OpenSky state vector list to a normalised Aircraft."""
        try:
            if len(state) < 17:
                return None

            lat = state[6]
            lon = state[5]
            if lat is None or lon is None:
                return None  # no position

            baro_alt_m = state[7]
            alt_ft = baro_alt_m * METERS_TO_FEET if baro_alt_m is not None else None

            velocity_ms = state[9]
            speed_kts = velocity_ms * MS_TO_KNOTS if velocity_ms is not None else None

            vert_ms = state[11]
            vert_fpm = vert_ms * 196.85 if vert_ms is not None else None  # m/s → ft/min

            callsign = (state[1] or "").strip() or None

            return Aircraft(
                icao=state[0].lower() if state[0] else "",
                callsign=callsign,
                lat=lat,
                lon=lon,
                altitude_ft=round(alt_ft, 0) if alt_ft is not None else None,
                speed_kts=round(speed_kts, 1) if speed_kts is not None else None,
                heading_deg=state[10],
                vertical_rate_fpm=round(vert_fpm, 0) if vert_fpm is not None else None,
                squawk=state[14],
                on_ground=bool(state[8]),
            )
        except Exception:
            return None
