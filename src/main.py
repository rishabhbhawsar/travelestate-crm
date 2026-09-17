"""
Application assembly layer for the TravelEstate CRM engine.

Wires together security middleware, the SQLite transactional ledger, the
AI classification service, and the WebSocket broadcast hub into a single
FastAPI gateway. This is the only module that knows how the pieces fit
together — every other module remains independently testable.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import aiosqlite
from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.core.security import ALLOWED_ORIGINS, SanitizationMiddleware, SecurityHeadersMiddleware
from src.models.schemas import LeadCreate, LeadResponse, LeadStatus
from src.services.ai_agent import classify_lead_inquiry_safe
from src.services.websocket_hub import hub

logger = logging.getLogger("travelestate.main")

DATABASE_PATH = "travelestate.db"

_CREATE_LEADS_TABLE = """
CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    raw_inquiry_text TEXT NOT NULL,
    status TEXT NOT NULL,
    classification_json TEXT,
    created_at TEXT NOT NULL
);
"""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Initializes the SQLite ledger and applies concurrency-oriented PRAGMAs
    on startup. WAL mode and NORMAL synchronous are set once, at the
    connection level, before any request traffic is served.
    """
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL;")
        await db.execute("PRAGMA synchronous=NORMAL;")
        await db.execute(_CREATE_LEADS_TABLE)
        await db.commit()
    logger.info("Database initialized at %s (WAL mode).", DATABASE_PATH)
    yield
    logger.info("Application shutdown complete.")


app = FastAPI(
    title="TravelEstate CRM Engine",
    version="0.1.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="src/static"), name="static")

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(SanitizationMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH"],
    allow_headers=["Authorization", "Content-Type"],
)


async def _get_db() -> aiosqlite.Connection:
    """Opens a per-call connection against the WAL-mode database file."""
    db = await aiosqlite.connect(DATABASE_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def _insert_pending_lead(lead: LeadResponse) -> None:
    db = await _get_db()
    try:
        await db.execute(
            """
            INSERT INTO leads
                (id, full_name, email, phone, raw_inquiry_text, status, classification_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lead.id,
                lead.full_name,
                lead.email,
                lead.phone,
                lead.raw_inquiry_text,
                lead.status.value,
                None,
                lead.created_at.isoformat(),
            ),
        )
        await db.commit()
    finally:
        await db.close()


async def _update_lead_classification(lead_id: str, classification_json: str, new_status: LeadStatus) -> None:
    db = await _get_db()
    try:
        await db.execute(
            "UPDATE leads SET status = ?, classification_json = ? WHERE id = ?",
            (new_status.value, classification_json, lead_id),
        )
        await db.commit()
    finally:
        await db.close()


async def process_lead_classification(lead: LeadResponse) -> None:
    """
    Out-of-band worker invoked via BackgroundTasks after the HTTP response
    has already been sent. Classifies the inquiry, persists the result,
    and broadcasts the state change to all connected dashboard clients.
    """
    classification = await classify_lead_inquiry_safe(lead.raw_inquiry_text)
    classification_json = classification.model_dump_json()

    await _update_lead_classification(
        lead_id=lead.id,
        classification_json=classification_json,
        new_status=LeadStatus.CLASSIFIED,
    )

    await hub.broadcast_lead_update(
        {
            "event": "lead_classified",
            "lead_id": lead.id,
            "status": LeadStatus.CLASSIFIED.value,
            "classification": json.loads(classification_json),
        }
    )


@app.post(
    "/api/v1/leads",
    response_model=LeadResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_lead(payload: LeadCreate, background_tasks: BackgroundTasks) -> LeadResponse:
    """
    Ingests a raw customer inquiry, persists it as PENDING, and schedules
    AI classification out-of-band. Returns immediately — the caller does
    not wait on the LLM round trip.
    """
    lead = LeadResponse(**payload.model_dump(), status=LeadStatus.PENDING)

    try:
        await _insert_pending_lead(lead)
    except aiosqlite.Error as exc:
        logger.error("Failed to persist lead %s: %s", lead.id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Lead ledger temporarily unavailable.",
        ) from exc

    background_tasks.add_task(process_lead_classification, lead)
    return lead


@app.websocket("/ws/dashboard")
async def dashboard_socket(websocket: WebSocket) -> None:
    """
    Real-time gateway for dashboard clients. Holds the connection open,
    relying on the hub for outbound broadcasts, and prunes the socket on
    disconnect. Inbound client messages are not part of this protocol and
    are read only to detect connection liveness/closure.
    """
    await hub.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(websocket)

@app.get("/")
async def serve_dashboard():
    """Explicit root fallback to deliver the live presentation HTML interface."""
    return FileResponse("src/static/index.html")
