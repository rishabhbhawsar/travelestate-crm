"""
Data contracts for the TravelEstate CRM engine.

Single source of truth for request/response DTOs, persistence models,
and the structured-output schema consumed by the OpenAI classification
layer. No business logic lives here — validation and shape only.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, EmailStr, Field, ConfigDict


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class LeadCategory(str, Enum):
    """Deterministic classification buckets for inbound inquiries."""
    BUY = "BUY"
    RENT = "RENT"
    INVESTMENT = "INVESTMENT"
    PARTNERSHIP = "PARTNERSHIP"
    SPAM = "SPAM"


class LeadStatus(str, Enum):
    """Lifecycle state of a lead record within the ingestion pipeline."""
    PENDING = "PENDING"
    CLASSIFIED = "CLASSIFIED"
    FAILED = "FAILED"


# ---------------------------------------------------------------------------
# Inbound ingestion contract
# ---------------------------------------------------------------------------

class LeadCreate(BaseModel):
    """Raw customer payload accepted at the ingestion boundary."""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    full_name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    phone: str = Field(..., min_length=7, max_length=20)
    raw_inquiry_text: str = Field(..., min_length=1, max_length=4000)
    metadata: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# AI Structured Outputs target schema
# ---------------------------------------------------------------------------

class LeadClassification(BaseModel):
    """
    Schema-locked extraction target for the OpenAI Structured Outputs call.

    This model is passed directly as the response_format contract. The API
    guarantees the returned JSON validates against this shape — no manual
    coercion or defensive parsing is required downstream.
    """

    model_config = ConfigDict(extra="forbid")

    category: LeadCategory
    estimated_budget_inr: Optional[int] = Field(
        default=None, ge=0, description="Estimated budget in INR, if stated or inferable."
    )
    preferred_location: Optional[str] = Field(
        default=None, max_length=200, description="Named city, locality, or region of interest."
    )
    urgency_score: int = Field(
        ..., ge=1, le=5, description="1 = exploratory, 5 = immediate intent to transact."
    )
    summary: str = Field(
        ..., min_length=1, max_length=280, description="One-sentence clean summary of customer intent."
    )


# ---------------------------------------------------------------------------
# Persistence / response representation
# ---------------------------------------------------------------------------

class LeadResponse(LeadCreate):
    """
    Full database representation of a lead: raw intake data merged with
    classification output, lifecycle status, and identity/audit fields.
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    status: LeadStatus = LeadStatus.PENDING
    classification: Optional[LeadClassification] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ---------------------------------------------------------------------------
# Auth layer
# ---------------------------------------------------------------------------

class Token(BaseModel):
    """Response body returned on successful authentication."""

    access_token: str
    token_type: str = "bearer"
    expires_in: int = Field(..., description="Access token TTL in seconds.")


class TokenData(BaseModel):
    """Decoded claims extracted from a verified JWT."""

    subject: str = Field(..., alias="sub")
    scopes: list[str] = Field(default_factory=list)
    exp: datetime

    model_config = ConfigDict(populate_by_name=True)