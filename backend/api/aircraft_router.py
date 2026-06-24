"""
Aircraft REST API endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from typing import Any, Dict, List

# These are injected at startup in main.py via app.state
from fastapi import Request

router = APIRouter(prefix="/api", tags=["aircraft"])


@router.get("/aircraft", response_model=List[Dict[str, Any]])
async def get_aircraft(request: Request):
    """Return all currently tracked aircraft with positions and metadata."""
    dm = request.app.state.data_manager
    return dm.get_all()


@router.get("/aircraft/{icao}", response_model=Dict[str, Any])
async def get_single_aircraft(icao: str, request: Request):
    """Return details for a single aircraft by its ICAO hex address."""
    dm = request.app.state.data_manager
    result = dm.get_one(icao.lower())
    if result is None:
        raise HTTPException(status_code=404, detail=f"Aircraft {icao} not found")
    return result


@router.get("/aircraft/{icao}/metadata", response_model=Dict[str, Any])
async def get_aircraft_metadata(icao: str, request: Request):
    """
    Fetch extended metadata (airline, model, registration) for a single aircraft.
    Uses local SQLite cache (aircraft_metadata table) to avoid hitting HexDB limits.
    """
    icao = icao.lower().strip()
    cfg = request.app.state.config
    dm = request.app.state.data_manager

    # 1. Dev / Mock mode check
    if cfg.development.use_mock_source:
        # Try to find mock aircraft in data manager to read its mock callsign
        ac = dm.get_one(icao)
        callsign = ac.get("callsign") if ac else None
        
        # Deterministic generation
        import random
        try:
            val = int(icao, 16)
        except ValueError:
            val = random.randint(0, 1000)

        airline = "Mock Aviation"
        if callsign:
            cs = callsign.upper().strip()
            if cs.startswith("UAL"): airline = "United Airlines"
            elif cs.startswith("DAL"): airline = "Delta Air Lines"
            elif cs.startswith("AAL"): airline = "American Airlines"
            elif cs.startswith("SWA") or cs.startswith("WN"): airline = "Southwest Airlines"
            elif cs.startswith("FDX"): airline = "FedEx Express"
            elif cs.startswith("UPS"): airline = "United Parcel Service"
            elif cs.startswith("SKW"): airline = "SkyWest Airlines"
            elif cs.startswith("ASA"): airline = "Alaska Airlines"
            elif cs.startswith("JBU"): airline = "JetBlue Airways"
            elif cs.startswith("NK"): airline = "Spirit Airlines"
            elif cs.startswith("F9"): airline = "Frontier Airlines"
            elif cs.startswith("BAW"): airline = "British Airways"
            elif cs.startswith("DLH"): airline = "Lufthansa"
            elif cs.startswith("AFR"): airline = "Air France"
            elif cs.startswith("KLM"): airline = "KLM Royal Dutch Airlines"

        models = [
            ("Boeing", "B737-800"),
            ("Boeing", "B737-MAX8"),
            ("Airbus", "A320-200"),
            ("Airbus", "A321neo"),
            ("Boeing", "B777-300ER"),
            ("Boeing", "B787-9 Dreamliner"),
            ("Airbus", "A350-900"),
            ("Embraer", "E190-E2"),
            ("Bombardier", "CRJ-900"),
        ]
        manufacturer, model = models[val % len(models)]
        reg_num = (val % 900) + 100
        reg_letters = chr(65 + (val % 26)) + chr(65 + ((val // 26) % 26))
        registration = f"N{reg_num}{reg_letters}"

        return {
            "registration": registration,
            "manufacturer": manufacturer,
            "model": model,
            "airline": airline,
        }

    # 2. Query local cache database
    from backend.db.database import get_aircraft_metadata as db_get_metadata, insert_aircraft_metadata as db_insert_metadata
    import time

    cached = await db_get_metadata(icao)
    if cached:
        # Check cache age — 7 days expiration
        if time.time() - cached["updated_at"] < 7 * 86400:
            return {
                "registration": cached["registration"],
                "manufacturer": cached["manufacturer"],
                "model": cached["model"],
                "airline": cached["airline"],
            }

    # 3. Cache miss or expired — fetch from hexdb.io
    import httpx
    url = f"https://hexdb.io/api/v1/aircraft/{icao}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                url,
                headers={"User-Agent": "PiRadar/1.0 (ADS-B display)"}
            )
            if resp.status_code == 200:
                data = resp.json()
                registration = data.get("Registration")
                manufacturer = data.get("Manufacturer")
                model = data.get("Type") or data.get("ICAOTypeCode")
                airline = data.get("RegisteredOwners")

                await db_insert_metadata(icao, registration, manufacturer, model, airline)
                return {
                    "registration": registration,
                    "manufacturer": manufacturer,
                    "model": model,
                    "airline": airline,
                }
            elif resp.status_code == 404:
                # Save negative result to database so we don't spam requests
                await db_insert_metadata(icao, None, None, None, None)
                return {
                    "registration": None,
                    "manufacturer": None,
                    "model": None,
                    "airline": None,
                }
    except Exception as exc:
        print(f"[API] HexDB lookup failed for {icao}: {exc}")

    # Return empty response in case of API failure (do not cache)
    return {
        "registration": None,
        "manufacturer": None,
        "model": None,
        "airline": None,
    }


@router.get("/status", response_model=Dict[str, Any])
async def get_status(request: Request):
    """Return system status: source name, aircraft count, last update time."""
    dm = request.app.state.data_manager
    ws_mgr = request.app.state.ws_manager
    status = dm.get_status()
    status["ws_clients"] = ws_mgr.connection_count
    return status
