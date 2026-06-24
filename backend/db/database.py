"""
SQLite database management for Pi Radar.
Handles aircraft track history with a rolling 1-hour window.
Uses aiosqlite for fully async operation.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import List, Dict, Any, Optional

import aiosqlite

# ---------------------------------------------------------------------------
# Database file location (project root)
# ---------------------------------------------------------------------------
DB_PATH = Path(__file__).parent.parent.parent / "pi_radar.db"

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
CREATE_TRACKS_TABLE = """
CREATE TABLE IF NOT EXISTS aircraft_tracks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    icao              TEXT NOT NULL,
    callsign          TEXT,
    lat               REAL NOT NULL,
    lon               REAL NOT NULL,
    altitude_ft       REAL,
    speed_kts         REAL,
    heading_deg       REAL,
    vertical_rate_fpm REAL,
    squawk            TEXT,
    source            TEXT,
    recorded_at       INTEGER NOT NULL
);
"""

CREATE_IDX_ICAO_TIME = """
CREATE INDEX IF NOT EXISTS idx_tracks_icao_time
    ON aircraft_tracks (icao, recorded_at);
"""

CREATE_IDX_TIME = """
CREATE INDEX IF NOT EXISTS idx_tracks_time
    ON aircraft_tracks (recorded_at);
"""

CREATE_METADATA_TABLE = """
CREATE TABLE IF NOT EXISTS aircraft_metadata (
    icao              TEXT PRIMARY KEY,
    registration      TEXT,
    manufacturer      TEXT,
    model             TEXT,
    airline           TEXT,
    updated_at        INTEGER NOT NULL
);
"""


# ---------------------------------------------------------------------------
# Database initialisation
# ---------------------------------------------------------------------------
async def init_db() -> None:
    """Create tables and indexes if they do not already exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_TRACKS_TABLE)
        await db.execute(CREATE_IDX_ICAO_TIME)
        await db.execute(CREATE_IDX_TIME)
        await db.execute(CREATE_METADATA_TABLE)
        await db.commit()
    print(f"[DB] Initialized database at {DB_PATH}")


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------
async def insert_tracks(aircraft_list: List[Dict[str, Any]], source: str) -> None:
    """Bulk-insert a snapshot of aircraft positions."""
    if not aircraft_list:
        return

    now = int(time.time())
    rows = [
        (
            ac.get("icao", ""),
            ac.get("callsign"),
            ac.get("lat"),
            ac.get("lon"),
            ac.get("altitude_ft"),
            ac.get("speed_kts"),
            ac.get("heading_deg"),
            ac.get("vertical_rate_fpm"),
            ac.get("squawk"),
            source,
            now,
        )
        for ac in aircraft_list
        if ac.get("lat") is not None and ac.get("lon") is not None
    ]

    if not rows:
        return

    async with aiosqlite.connect(DB_PATH) as db:
        await db.executemany(
            """
            INSERT INTO aircraft_tracks
                (icao, callsign, lat, lon, altitude_ft, speed_kts,
                 heading_deg, vertical_rate_fpm, squawk, source, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------
async def get_track_history(
    icao: str,
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Return track points for a single aircraft within the given time range."""
    if from_ts is None:
        from_ts = int(time.time()) - 3600  # last hour default
    if to_ts is None:
        to_ts = int(time.time())

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT icao, callsign, lat, lon, altitude_ft, speed_kts,
                   heading_deg, vertical_rate_fpm, squawk, source, recorded_at
            FROM aircraft_tracks
            WHERE icao = ? AND recorded_at BETWEEN ? AND ?
            ORDER BY recorded_at ASC
            """,
            (icao, from_ts, to_ts),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_replay_snapshot(from_ts: int, to_ts: int) -> List[Dict[str, Any]]:
    """Return all aircraft positions between two timestamps (for replay)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT icao, callsign, lat, lon, altitude_ft, speed_kts,
                   heading_deg, vertical_rate_fpm, squawk, source, recorded_at
            FROM aircraft_tracks
            WHERE recorded_at BETWEEN ? AND ?
            ORDER BY recorded_at ASC, icao ASC
            """,
            (from_ts, to_ts),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
async def cleanup_old_tracks(history_hours: int = 1) -> int:
    """Delete track records older than `history_hours`. Returns rows deleted."""
    cutoff = int(time.time()) - (history_hours * 3600)
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "DELETE FROM aircraft_tracks WHERE recorded_at < ?", (cutoff,)
        )
        await db.commit()
        deleted = cursor.rowcount
    if deleted > 0:
        print(f"[DB] Cleaned up {deleted} old track records")
    return deleted


async def periodic_cleanup(history_hours: int = 1, interval_sec: int = 300) -> None:
    """Background coroutine that runs cleanup every `interval_sec` seconds."""
    while True:
        await asyncio.sleep(interval_sec)
        try:
            await cleanup_old_tracks(history_hours)
        except Exception as exc:
            print(f"[DB] Cleanup error: {exc}")


# ---------------------------------------------------------------------------
# Aircraft metadata cache read/write helpers
# ---------------------------------------------------------------------------
async def get_aircraft_metadata(icao: str) -> Optional[Dict[str, Any]]:
    """Fetch cached extended metadata for a single ICAO hex code."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT registration, manufacturer, model, airline, updated_at
            FROM aircraft_metadata
            WHERE icao = ?
            """,
            (icao.lower().strip(),),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def insert_aircraft_metadata(
    icao: str,
    registration: Optional[str],
    manufacturer: Optional[str],
    model: Optional[str],
    airline: Optional[str],
) -> None:
    """Cache extended aircraft metadata in the database."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT OR REPLACE INTO aircraft_metadata
                (icao, registration, manufacturer, model, airline, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                icao.lower().strip(),
                registration,
                manufacturer,
                model,
                airline,
                int(time.time()),
            ),
        )
        await db.commit()
