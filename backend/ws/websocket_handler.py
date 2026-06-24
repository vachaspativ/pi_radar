"""
WebSocket connection manager and broadcaster.

Maintains a set of all connected browser clients and provides
a broadcast_json() method to push updates to all of them at once.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Set

from fastapi import WebSocket
from starlette.websockets import WebSocketState


class ConnectionManager:
    """Manages all active WebSocket client connections."""

    def __init__(self) -> None:
        self._connections: Set[WebSocket] = set()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------
    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.add(ws)
        print(f"[WS] Client connected  — total: {len(self._connections)}")

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.discard(ws)
        print(f"[WS] Client disconnected — total: {len(self._connections)}")

    # ------------------------------------------------------------------
    # Broadcasting
    # ------------------------------------------------------------------
    async def broadcast_json(self, data: Dict[str, Any]) -> None:
        """Send a JSON message to every connected client."""
        if not self._connections:
            return

        payload = json.dumps(data, default=str)
        dead: List[WebSocket] = []

        for ws in list(self._connections):
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(payload)
            except Exception:
                dead.append(ws)

        for ws in dead:
            self.disconnect(ws)

    async def send_json(self, ws: WebSocket, data: Dict[str, Any]) -> None:
        """Send a JSON message to a specific client."""
        try:
            payload = json.dumps(data, default=str)
            await ws.send_text(payload)
        except Exception:
            self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# ---------------------------------------------------------------------------
# Module-level singleton — imported by main.py and routers
# ---------------------------------------------------------------------------
manager = ConnectionManager()
