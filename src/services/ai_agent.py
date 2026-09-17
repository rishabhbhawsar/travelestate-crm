"""
AI classification service for the TravelEstate CRM engine.

Wraps the OpenAI Structured Outputs API to convert unstructured customer
inquiry text into a schema-validated LeadClassification object. This is
the only module in the system that talks to an external AI provider —
all non-determinism is contained here.
"""

from __future__ import annotations

import logging
import os

from openai import AsyncOpenAI, APIError, APIConnectionError, APITimeoutError, RateLimitError
from pydantic import ValidationError

from src.models.schemas import LeadCategory, LeadClassification

logger = logging.getLogger("travelestate.ai_agent")

_MODEL = "gpt-4o-mini"
_REQUEST_TIMEOUT_SECONDS = 15.0
_MAX_RETRIES = 2

_SYSTEM_PROMPT = (
    "You are a lead-triage classifier for a real estate and travel/property "
    "consulting business. Extract structured intent from raw customer "
    "inquiry text. Infer budget and location only when reasonably supported "
    "by the text; leave them null otherwise. Classify as SPAM only when the "
    "text shows no genuine property, rental, investment, or partnership "
    "intent. Never fabricate specifics not implied by the input."
)

_client = AsyncOpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=_REQUEST_TIMEOUT_SECONDS,
    max_retries=_MAX_RETRIES,
)


class ClassificationError(Exception):
    """Raised when a lead inquiry cannot be classified after all retries."""


def _fallback_classification(reason: str) -> LeadClassification:
    """
    Deterministic degraded-mode result for downstream consumers that must
    always receive a LeadClassification, never an unhandled exception.
    """
    return LeadClassification(
        category=LeadCategory.SPAM,
        estimated_budget_inr=None,
        preferred_location=None,
        urgency_score=1,
        summary=f"Automatic classification failed: {reason}",
    )


async def classify_lead_inquiry(raw_text: str) -> LeadClassification:
    """
    Classify a raw customer inquiry into a schema-locked LeadClassification.

    Network I/O is fully awaited — the event loop is released for the
    duration of the OpenAI round trip and free to service other requests.
    On unrecoverable failure, raises ClassificationError; callers decide
    whether to persist a fallback or mark the lead FAILED.
    """
    try:
        completion = await _client.beta.chat.completions.parse(
            model=_MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": raw_text},
            ],
            response_format=LeadClassification,
        )
    except (APIConnectionError, APITimeoutError) as exc:
        logger.warning("AI provider unreachable during classification: %s", exc)
        raise ClassificationError("provider_unreachable") from exc
    except RateLimitError as exc:
        logger.warning("AI provider rate limit exceeded: %s", exc)
        raise ClassificationError("rate_limited") from exc
    except APIError as exc:
        logger.error("AI provider returned an API error: %s", exc)
        raise ClassificationError("provider_error") from exc

    choice = completion.choices[0]

    if choice.message.refusal:
        logger.info("Model refused classification: %s", choice.message.refusal)
        raise ClassificationError("model_refused")

    parsed = choice.message.parsed
    if parsed is None:
        logger.error("Structured Outputs returned no parsed payload")
        raise ClassificationError("empty_parse_result")

    try:
        return LeadClassification.model_validate(parsed)
    except ValidationError as exc:
        logger.error("Parsed classification failed contract validation: %s", exc)
        raise ClassificationError("schema_validation_failed") from exc


async def classify_lead_inquiry_safe(raw_text: str) -> LeadClassification:
    """
    Non-raising variant of classify_lead_inquiry for call sites that must
    guarantee forward progress — e.g. background tasks where an unhandled
    exception would silently drop the lead's status transition.
    """
    try:
        return await classify_lead_inquiry(raw_text)
    except ClassificationError as exc:
        return _fallback_classification(reason=str(exc))