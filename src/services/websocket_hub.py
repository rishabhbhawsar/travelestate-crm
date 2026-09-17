"""
Real-time broadcast hub for the TravelEstate CRM dashboard.

Owns the registry of active WebSocket connections and the fan-out
primitive used to push lead state changes to every connected client.
No business logic lives here — this module only knows how to register,
prune, and broadcast to sockets.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

logger = logging.getLogger("travelestate.websocket_hub")


class WebSocketHub:
    """
    Thread-safe-within-the-event-loop registry and broadcaster for active
    dashboard WebSocket connections.

    Connection state is a plain set guarded by an asyncio.Lock — sufficient
    because all access happens on the single event loop thread; the lock
    exists to serialize interleaved connect/disconnect/broadcast coroutines,
    not to guard against OS-level thread contention.
    """

    def __init__(self) -> None:
        self._active_connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a WebSocket handshake and register it for broadcasts."""
        await websocket.accept()
        async with self._lock:
            self._active_connections.add(websocket)
        logger.info("Client connected. Active connections: %d", len(self._active_connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket from the active registry, idempotently."""
        async with self._lock:
            self._active_connections.discard(websocket)
        logger.info("Client disconnected. Active connections: %d", len(self._active_connections))

    async def _send_safe(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        """
        Send to a single socket, raising on any failure so the caller's
        gather() can identify and prune it. No exception is swallowed here
        — pruning decisions belong to the broadcaster, not the sender.
        """
        if websocket.client_state != WebSocketState.CONNECTED:
            raise WebSocketDisconnect(code=1006)
        await websocket.send_json(payload)

    async def broadcast_lead_update(self, lead_data: dict[str, Any]) -> None:
        """
        Push a lead state-change payload to every active connection.

        A single stale or failing socket must never block or fail delivery
        to the rest of the pool — asyncio.gather(return_exceptions=True)
        isolates each send's outcome, and failures are pruned after the
        fan-out completes rather than interrupting it mid-flight.
        """
        async with self._lock:
            targets = tuple(self._active_connections)

        if not targets:
            return

        results = await asyncio.gather(
            *(self._send_safe(ws, lead_data) for ws in targets),
            return_exceptions=True,
        )

        dead_sockets = [
            ws for ws, result in zip(targets, results) if isinstance(result, Exception)
        ]

        if dead_sockets:
            async with self._lock:
                for ws in dead_sockets:
                    self._active_connections.discard(ws)
            logger.info("Pruned %d stale connection(s) during broadcast.", len(dead_sockets))

    @property
    def active_connection_count(self) -> int:
        """Current number of registered live connections."""
        return len(self._active_connections)


hub = WebSocketHub()