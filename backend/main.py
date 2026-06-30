"""
Pi Radar — FastAPI Application Entry Point

Startup sequence:
  1. Load configuration
  2. Initialise SQLite database
  3. Initialise DataManager, SourceManager, WebSocket ConnectionManager
  4. Start background polling task (every 5 seconds)
  5. Start background DB cleanup task (every 5 minutes)
  6. Mount frontend static files
  7. Register API routers
  8. Open WebSocket endpoint at /ws
"""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from backend.config import load_config
from backend.data_manager import DataManager
from backend.db.database import init_db, periodic_cleanup
from backend.sources.source_manager import SourceManager
from backend.ws.websocket_handler import ConnectionManager
from backend.api.aircraft_router import router as aircraft_router
from backend.api.history_router import router as history_router
from backend.api.config_router import router as config_router
from backend.api.airport_router import router as airport_router

# ---------------------------------------------------------------------------
# Frontend path
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ---------------------------------------------------------------------------
# Background polling loop
# ---------------------------------------------------------------------------
async def polling_loop(app: FastAPI) -> None:
    """
    Runs forever. Every `refresh_interval_sec` seconds:
      1. Fetch aircraft from the best source
      2. Update the DataManager state
      3. Broadcast to all WebSocket clients
    """
    cfg = app.state.config
    dm: DataManager = app.state.data_manager
    sm: SourceManager = app.state.source_manager
    ws_mgr: ConnectionManager = app.state.ws_manager

    interval = cfg.radar.refresh_interval_sec
    print(f"[Poller] Starting — interval={interval}s, mode={'MOCK' if cfg.development.use_mock_source else 'LIVE'}")

    while True:
        try:
            result = await sm.fetch()
            await dm.update(
                aircraft_list=result.aircraft,
                source_name=result.source_name,
                is_live=sm.is_live,
            )

            # Build WebSocket message
            message = {
                "type": "aircraft_update",
                "timestamp": int(time.time()),
                "source": "LIVE" if sm.is_live else "FALLBACK",
                "source_label": result.source_name,
                "success": result.success,
                "aircraft_count": dm.aircraft_count,
                "aircraft": dm.get_all(),
                "status": dm.get_status(),
            }

            await ws_mgr.broadcast_json(message)

        except asyncio.CancelledError:
            print("[Poller] Cancelled — shutting down")
            break
        except Exception as exc:
            print(f"[Poller] Error in polling loop: {exc}")

        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Lifespan (replaces on_event("startup") / on_event("shutdown"))
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────
    print("[Startup] Pi Radar backend initialising...")

    cfg = load_config()
    app.state.config = cfg

    await init_db()

    dm = DataManager(cfg)
    sm = SourceManager(cfg)
    ws_mgr = ConnectionManager()

    app.state.data_manager = dm
    app.state.source_manager = sm
    app.state.ws_manager = ws_mgr
    app.state.loop = asyncio.get_running_loop()

    # Start GPS Poller
    from backend.gps_poller import GPSPoller
    gps_poller = GPSPoller(app)
    gps_poller.start()
    app.state.gps_poller = gps_poller

    # Start background tasks
    poller_task = asyncio.create_task(polling_loop(app))
    cleanup_task = asyncio.create_task(
        periodic_cleanup(
            history_hours=cfg.radar.history_hours,
            interval_sec=300,
        )
    )
    app.state.bg_tasks = [poller_task, cleanup_task]

    mode = "MOCK (dev)" if cfg.development.use_mock_source else "LIVE"
    print(f"[Startup] Ready — mode={mode}, home=({cfg.radar.home_lat}, {cfg.radar.home_lon})")
    print(f"[Startup] Open http://localhost:{cfg.server.port} in your browser")

    yield  # ← app runs here

    # ── Shutdown ─────────────────────────────────────────────────────────
    print("[Shutdown] Stopping background tasks...")
    if hasattr(app.state, "gps_poller"):
        app.state.gps_poller.stop()

    for task in app.state.bg_tasks:
        task.cancel()
    await asyncio.gather(*app.state.bg_tasks, return_exceptions=True)
    print("[Shutdown] Done.")


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Pi Radar",
    description="Real-time ADS-B flight radar for Raspberry Pi",
    version="1.0.0",
    lifespan=lifespan,
)

# ── API routers ─────────────────────────────────────────────────────────────
app.include_router(aircraft_router)
app.include_router(history_router)
app.include_router(config_router)
app.include_router(airport_router)


# ── WebSocket endpoint ───────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    ws_mgr: ConnectionManager = app.state.ws_manager
    await ws_mgr.connect(websocket)

    # Send current state immediately on connect
    dm: DataManager = app.state.data_manager
    sm: SourceManager = app.state.source_manager
    await ws_mgr.send_json(websocket, {
        "type": "aircraft_update",
        "timestamp": int(time.time()),
        "source": "LIVE" if sm.is_live else "FALLBACK",
        "source_label": dm.source_name,
        "success": True,
        "aircraft_count": dm.aircraft_count,
        "aircraft": dm.get_all(),
        "status": dm.get_status(),
    })

    try:
        while True:
            # Keep connection alive — handle client control messages
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get("type")

                if msg_type == "ping":
                    await ws_mgr.send_json(websocket, {"type": "pong"})

                elif msg_type == "set_range":
                    # Acknowledge range change (UI handles display logic)
                    await ws_mgr.send_json(websocket, {
                        "type": "range_ack",
                        "range_nm": msg.get("range_nm"),
                    })

            except Exception:
                pass  # Ignore malformed messages

    except WebSocketDisconnect:
        ws_mgr.disconnect(websocket)


# ── Root → serve frontend index.html ────────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse(FRONTEND_DIR / "index.html")


# ── Static files (CSS, JS) ───────────────────────────────────────────────────
if FRONTEND_DIR.exists():
    app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
