"""Password hashing (bcrypt) and stateless session tokens (JWT)."""

from datetime import datetime, timezone, timedelta
from typing import Optional
import uuid

import bcrypt
import jwt

from app.config import get_settings

_ALGO = "HS256"


# ── Passwords ────────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    # bcrypt caps input at 72 bytes; encode and truncate defensively.
    pw = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(
            password.encode("utf-8")[:72], password_hash.encode("utf-8")
        )
    except (ValueError, TypeError):
        return False


# ── Session tokens ───────────────────────────────────────────────────────────
def create_session_token(user_id: uuid.UUID) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=s.session_ttl_days)).timestamp()),
    }
    return jwt.encode(payload, s.session_secret, algorithm=_ALGO)


def read_session_token(token: str) -> Optional[uuid.UUID]:
    s = get_settings()
    try:
        payload = jwt.decode(token, s.session_secret, algorithms=[_ALGO])
        return uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


# ── Purpose tokens (invite / password reset / email verify) ──────────────────
def create_purpose_token(purpose: str, data: dict, ttl_hours: int = 0, ttl_minutes: int = 0) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "purpose": purpose,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=ttl_hours, minutes=ttl_minutes)).timestamp()),
        **data,
    }
    return jwt.encode(payload, s.session_secret, algorithm=_ALGO)


def read_purpose_token(purpose: str, token: str) -> Optional[dict]:
    s = get_settings()
    try:
        payload = jwt.decode(token, s.session_secret, algorithms=[_ALGO])
    except jwt.PyJWTError:
        return None
    if payload.get("purpose") != purpose:
        return None
    return payload
