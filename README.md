# TravelEstate CRM — AI-Agentic Lead Intelligence Engine

**An async-native, AI-powered CRM engine designed for real-time customer telemetry, automated lead triage, and horizontal scalability.**

---

## 1. Executive Summary

TravelEstate CRM is a demonstration-grade backend and dashboard system that ingests unstructured customer inquiries, classifies them into deterministic sales pipelines using LLM-based structured extraction, and streams state changes to connected clients in real time — without polling.

The system is built to answer a single engineering question: **can a lead-management pipeline stay correct and responsive under concurrent load while making a non-deterministic AI call part of its critical path?** Every architectural decision in this repository traces back to that constraint.

| Property | Target |
|---|---|
| Concurrent connection handling | 5,000+ pooled async connections |
| Initial payload / render latency reduction | 58% (via virtualization + compression) |
| AI classification | Structured, schema-locked (Pydantic V2 contracts) |
| Real-time propagation | WebSocket push, zero client polling |
| Security posture | JWT auth, CSP/CORS/SRI headers, input sanitization at the boundary |

---

## 2. Problem Statement

Traditional CRM ingestion pipelines fall into two failure modes:

1. **Synchronous blocking** — a lead comes in, the server calls an external AI API, and the request thread blocks until it returns. Under load, this serializes what should be parallel work and collapses throughput.
2. **Stale state** — dashboards rely on short polling (every N seconds) to detect new leads, which wastes bandwidth, introduces latency proportional to the poll interval, and does not scale linearly with connected clients.

TravelEstate CRM addresses both: the AI classification step is **non-blocking** relative to the event loop, and state changes are **pushed** to clients the instant they're persisted.

---

## 3. Architecture Overview

### 3.1 High-Level Component Diagram
                ┌─────────────────────────────────────────┐
                │              CLIENT LAYER                │
                │   React + Tailwind + WebSocket Client     │
                │   (Virtualized Lead List, Live Dashboard) │
                └───────────────┬───────────────────────────┘
                                │ WSS (bi-directional)
                                │ HTTPS (REST, auth)
                ┌───────────────▼───────────────────────────┐
                │            FASTAPI GATEWAY                 │
                │  ┌───────────────────────────────────────┐ │
                │  │  core/security.py                     │ │
                │  │  JWT verification · CORS · CSP · SRI  │ │
                │  │  Input sanitization middleware         │ │
                │  └───────────────────────────────────────┘ │
                └───────────────┬───────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────────┐
          │                     │                          │
          ┌──────────▼──────────┐ ┌────────▼─────────┐ ┌─────────────▼────────────┐
        │ services/ai_agent │ │ websocket_hub.py │ │ models/schemas.py │
        │ Async OpenAI call │ │ Connection pool │ │ Pydantic V2 contracts │
        │ Structured Outputs │ │ Broadcast fan-out │ │ Request/Response DTOs │
        └──────────┬───────────┘ └────────┬─────────┘ └───────────────────────────┘
        │ │
        │ (classification │ (state change
        │ result) │ event)
        ▼ ▼
┌────────────────────────────────────────────┐
│ PERSISTENCE & CACHE LAYER │
│ SQLite (transactional ledger, WAL mode) │
│ Redis-simulated cache (session/token TTL) │
└────────────────────────────────────────────┘

### 3.2 Request Lifecycle: "New Lead Ingested"
Customer submits inquiry
│
▼
[1] FastAPI receives POST /leads
│ Pydantic validates + sanitizes payload (rejects malformed input at the edge)
▼
[2] Lead persisted to SQLite as PENDING (immediate ack to client — no AI wait)
│
▼
[3] AI classification scheduled as an asyncio background task
│ Event loop is NOT blocked — it continues serving other requests
▼
[4] ai_agent.py calls OpenAI with Structured Outputs
│ Response is schema-locked to LeadClassification (Pydantic model)
│ A malformed/hallucinated shape is rejected before it touches the DB
▼
[5] SQLite row updated: PENDING → CLASSIFIED (category, priority, confidence)
│
▼
[6] websocket_hub.py broadcasts the state diff to all subscribed dashboard clients
│
▼
[7] React dashboard receives the push and re-renders only the affected row
(virtualized list — no full re-render, no polling)

---

## 4. Core Engineering Decisions — The "Why"

### 4.1 Why FastAPI + `asyncio` over a synchronous framework (e.g., Flask/Django WSGI)

A synchronous worker is occupied for the entire duration of an I/O-bound call — including the ~1–3 second round trip to an LLM provider. Under concurrent load, this means thread/process count becomes the hard ceiling on throughput.

FastAPI's ASGI event loop yields control during I/O waits (network calls, disk reads). A single worker process can therefore hold thousands of in-flight requests where most of them are "waiting," not "computing" — which matches the actual shape of CRM traffic (bursty writes, long-tail AI calls, persistent WebSocket connections).

### 4.2 Why WebSockets over Long/Short Polling

Polling forces the client to ask "did anything change?" on a fixed interval, regardless of whether anything did. This has two costs that compound with client count:

- **Latency floor**: a lead reclassified 100ms after a poll isn't visible until the *next* poll — average staleness is half the poll interval.
- **Wasted bandwidth**: N clients polling every 5s against a 5,000-connection target means constant request volume with a near-zero useful-information ratio.

A WebSocket is a persistent, full-duplex channel: the server pushes the diff the instant it's committed, and idle connections cost a held socket, not a request cycle. This is the correct primitive for "who needs to know about this state change" being determined by the server, not guessed by the client.

### 4.3 Why Pydantic V2 for the AI Layer specifically

LLM output is inherently non-deterministic prose unless constrained. Passing a raw model response into business logic means every downstream consumer has to defensively parse and validate — and can still be handed garbage.

OpenAI's Structured Outputs, combined with a Pydantic V2 `BaseModel` as the schema, moves that validation to the boundary: the AI call either returns an object that satisfies the contract, or it doesn't reach the rest of the system at all. This makes the AI classification step a **deterministic pipeline stage** from the perspective of everything downstream — the non-determinism is fully contained inside `ai_agent.py`.

### 4.4 Why input sanitization is enforced at the middleware layer, not per-endpoint

XSS exploits the gap between "what the server stored" and "what the browser executes." If sanitization is left to individual endpoint handlers, one omitted call is one stored-XSS vulnerability. Centralizing sanitization in `core/security.py` as middleware means every request body is normalized before it reaches a single line of business logic — the guarantee holds regardless of which endpoint is hit or which developer wrote it.

### 4.5 Why SQLite (transactional ledger) + a Redis-simulated cache, rather than one datastore

These serve different access patterns and shouldn't share a bottleneck:

- **SQLite (WAL mode)** is the source of truth for lead records — durable, ACID-compliant, correct under concurrent writes for this workload scale.
- **Redis-simulated cache** holds ephemeral, high-read data — session tokens, rate-limit counters — where durability matters less than *speed* and *TTL expiry semantics*. Mixing this into the transactional ledger would mean paying disk-write cost for data that's supposed to be disposable.

### 4.6 Why virtualized list rendering + payload compression on the frontend

At scale, a CRM lead list isn't 50 rows — it's tens of thousands. Rendering every row into the DOM regardless of scroll position means paint cost scales with total dataset size, not visible size. Virtualization renders only the rows in (or near) the viewport, decoupling render cost from data volume. Paired with response compression (reducing wire payload) and payload shaping (sending only fields the current view needs), this is where the 58% initial-load latency reduction target comes from — it is a compounding effect of *less data transferred* and *less DOM work per frame*, not a single trick.

---

## 5. Security Model

| Layer | Mechanism | Threat Mitigated |
|---|---|---|
| Transport | HTTPS/WSS enforced | Man-in-the-middle interception |
| AuthN | JWT (short-lived access + refresh) | Credential replay, session hijack |
| AuthZ | Route-level dependency injection scopes | Privilege escalation |
| Input boundary | Sanitization middleware on all mutating routes | Stored/Reflected XSS |
| Browser policy | Content-Security-Policy (script-src locked) | Injected script execution |
| Cross-origin | Explicit CORS allow-list (no wildcard `*`) | Unauthorized cross-origin reads |
| Asset integrity | Subresource Integrity (SRI) hashes on CDN assets | Supply-chain / CDN tampering |

---

## 6. Project Structure
travelestate-crm/
├── README.md
├── requirements.txt
└── src/
├── core/
│ └── security.py # JWT issuance/verification, sanitization, security headers
├── models/
│ └── schemas.py # Pydantic V2 contracts — the single source of truth for shapes
├── services/
│ ├── ai_agent.py # Structured-output lead classification
│ └── websocket_hub.py # Connection registry + broadcast fan-out
└── main.py # FastAPI app assembly, route registration, lifespan hooks

---

## 7. Roadmap (Demo MVP Scope)

- [ ] `models/schemas.py` — data contracts for `Lead`, `LeadClassification`, `AuthToken`
- [ ] `core/security.py` — JWT flow, sanitization middleware, security headers
- [ ] `services/ai_agent.py` — async OpenAI Structured Outputs classification
- [ ] `services/websocket_hub.py` — connection pool + broadcast primitives
- [ ] `main.py` — route wiring, lifespan-managed resources
- [ ] React dashboard — virtualized lead table, live WebSocket subscription

---

*This repository is a systems-design demonstration: the emphasis is on defensible architectural reasoning under realistic constraints (concurrency, non-determinism, security boundaries), not on feature breadth.*