"""
Centralized security layer for the TravelEstate CRM engine.

Owns three concerns that must never be delegated to individual endpoint
handlers: credential hashing, JWT lifecycle management, and boundary-level
input sanitization / security headers. No route in this application is
permitted to implement its own version of any of these.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

import bleach
from fastapi import HTTPException, Request, Response, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from src.models.schemas import TokenData

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

SECRET_KEY = "CHANGE_ME_IN_PRODUCTION_ENV_VAR"  # noqa: S105 — load from environment at startup
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7

ALLOWED_ORIGINS = [
    "https://app.travelestate.io",
    "https://staging.travelestate.io",
]

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; "
    "connect-src 'self' wss://app.travelestate.io; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "object-src 'none'"
)

SECURITY_HEADERS: dict[str, str] = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}

# Subresource Integrity is enforced client-side via <script integrity="sha384-...">
# on the HTML shell. This map is the server-side source of truth the build
# pipeline reads from when injecting those attributes at deploy time.
SRI_HASHES: dict[str, str] = {
    "vendor.bundle.js": "sha384-REPLACE_WITH_BUILD_GENERATED_HASH",
}

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

_STRIP_ALL_TAGS: list[str] = []
_STRIP_ALL_ATTRS: dict[str, list[str]] = {}


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

def hash_password(plain_password: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return _pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against its bcrypt hash."""
    return _pwd_context.verify(plain_password, hashed_password)


# ---------------------------------------------------------------------------
# JWT lifecycle
# ---------------------------------------------------------------------------

def _create_token(subject: str, scopes: list[str], expires_delta: timedelta) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "scopes": scopes,
        "iat": now,
        "exp": now + expires_delta,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def create_access_token(subject: str, scopes: Optional[list[str]] = None) -> str:
    """Issue a short-lived access token for API authorization."""
    return _create_token(
        subject, scopes or [], timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )


def create_refresh_token(subject: str) -> str:
    """Issue a long-lived refresh token for silent re-authentication."""
    return _create_token(subject, ["refresh"], timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))


def decode_and_verify_token(token: str) -> TokenData:
    """
    Decode and verify a JWT, returning its validated claims.

    Raises HTTPException(401) on expiry, signature mismatch, or malformed
    claims — the only outcome callers need to branch on is success or 401.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    try:
        return TokenData(**payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token claims",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


# ---------------------------------------------------------------------------
# Input sanitization
# ---------------------------------------------------------------------------

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def sanitize_string(value: str) -> str:
    """
    Strip HTML/script content and control characters from a string.

    Uses bleach's tokenizing parser rather than regex substitution — regex
    cannot correctly handle malformed, nested, or obfuscated markup, and
    incomplete tag-stripping regexes are a well-documented XSS bypass
    vector. bleach walks the tag tree and rejects every element, leaving
    plain text only.
    """
    stripped = bleach.clean(
        value, tags=_STRIP_ALL_TAGS, attributes=_STRIP_ALL_ATTRS, strip=True
    )
    return _CONTROL_CHARS.sub("", stripped).strip()


def _sanitize_json_value(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_string(value)
    if isinstance(value, dict):
        return {k: _sanitize_json_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    return value


# ---------------------------------------------------------------------------
# Sanitization middleware
# ---------------------------------------------------------------------------

class SanitizationMiddleware(BaseHTTPMiddleware):
    """
    Recursively sanitizes every string field in JSON request bodies for
    mutating HTTP methods before the request reaches routing or business
    logic. Non-JSON and read-only requests pass through untouched.
    """

    SANITIZED_METHODS = frozenset({"POST", "PUT", "PATCH"})

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.method not in self.SANITIZED_METHODS:
            return await call_next(request)

        content_type = request.headers.get("content-type", "")
        if "application/json" not in content_type:
            return await call_next(request)

        body_bytes = await request.body()
        if not body_bytes:
            return await call_next(request)

        try:
            parsed = json.loads(body_bytes)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Malformed JSON body"
            )

        sanitized = _sanitize_json_value(parsed)
        new_body = json.dumps(sanitized).encode("utf-8")

        async def receive() -> dict[str, Any]:
            return {"type": "http.request", "body": new_body, "more_body": False}

        request._receive = receive  # rebind body stream for downstream consumers
        return await call_next(request)


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attaches the standard security header set to every response."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)

        # Extract the current URL path safely from the incoming request object
        current_path = str(request.url.path)

        for header_name, header_value in SECURITY_HEADERS.items():
            # If it's a documentation route, skip injecting the strict CSP
            # so the browser lets Swagger render its interactive panels.
            if header_name == "Content-Security-Policy" and (
                current_path.startswith("/docs")
                or current_path.startswith("/openapi.json")
            ):
                continue

            response.headers[header_name] = header_value

        return response