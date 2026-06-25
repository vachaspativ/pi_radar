"""
Configuration loader for Pi Radar.
Reads config.yaml and exposes a validated Config object.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Sub-config models
# ---------------------------------------------------------------------------

class RadarConfig(BaseModel):
    home_lat: float = 32.7767
    home_lon: float = -96.7970
    home_label: str = "Home"
    range_options: Dict[int, List[int]] = {
        5: [1, 2, 3, 4, 5],
        10: [2, 4, 6, 8, 10],
        25: [5, 10, 15, 20, 25],
        50: [10, 20, 30, 40, 50],
        100: [25, 50, 75, 100],
        150: [25, 50, 75, 100, 125, 150],
        200: [50, 100, 150, 200]
    }
    default_range_nm: int = 100
    refresh_interval_sec: int = 5
    history_hours: int = 1
    track_points: int = 10


class Dump1090Config(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8080
    json_path: str = "/data/aircraft.json"
    timeout_sec: float = 2.0
    failure_threshold: int = 3

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}{self.json_path}"


class OpenSkyConfig(BaseModel):
    enabled: bool = True
    client_id: str = ""
    client_secret: str = ""
    poll_interval_sec: int = 30
    bounding_box_margin_deg: float = 2.5


class FR24Config(BaseModel):
    enabled: bool = False
    sharing_key: str = ""
    mlat_enabled: bool = True


class DisplayConfig(BaseModel):
    kiosk_mode: bool = False
    screen_width: int = 800
    screen_height: int = 480
    photo_api_url: str = "https://api.planespotters.net/pub/photos/hex/{icao}"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"


class DevelopmentConfig(BaseModel):
    use_mock_source: bool = True
    mock_aircraft_count: int = 18


# ---------------------------------------------------------------------------
# Root config model
# ---------------------------------------------------------------------------

class AppConfig(BaseModel):
    radar: RadarConfig = Field(default_factory=RadarConfig)
    dump1090: Dump1090Config = Field(default_factory=Dump1090Config)
    opensky: OpenSkyConfig = Field(default_factory=OpenSkyConfig)
    fr24feed: FR24Config = Field(default_factory=FR24Config)
    display: DisplayConfig = Field(default_factory=DisplayConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    development: DevelopmentConfig = Field(default_factory=DevelopmentConfig)


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def load_config(path: Optional[str] = None) -> AppConfig:
    """
    Load configuration from config.yaml.
    Searches in the current directory and parent directories.
    """
    if path is None:
        # Look for config.yaml relative to the project root
        candidates = [
            Path("config.yaml"),
            Path(__file__).parent.parent / "config.yaml",
        ]
        for candidate in candidates:
            if candidate.exists():
                path = str(candidate)
                break

    if path and Path(path).exists():
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        return AppConfig(**raw)
    else:
        print("[Config] config.yaml not found — using defaults")
        return AppConfig()


# ---------------------------------------------------------------------------
# Module-level singleton — import this everywhere
# ---------------------------------------------------------------------------
config: AppConfig = load_config()
