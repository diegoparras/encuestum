"""Central configuration, read once from the environment."""

import os
import secrets
from functools import lru_cache


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        # Sessions. In production SESSION_SECRET MUST be set and stable, otherwise
        # every restart invalidates existing sessions. We generate an ephemeral
        # one as a dev convenience and warn.
        self.session_secret = os.getenv("ENCUESTUM_SESSION_SECRET") or os.getenv("SESSION_SECRET")
        self.session_secret_is_ephemeral = not self.session_secret
        if not self.session_secret:
            self.session_secret = secrets.token_urlsafe(48)

        self.session_cookie = os.getenv("ENCUESTUM_SESSION_COOKIE", "enc_session")
        self.org_cookie = os.getenv("ENCUESTUM_ORG_COOKIE", "enc_org")
        self.session_ttl_days = int(os.getenv("ENCUESTUM_SESSION_TTL_DAYS", "30"))
        # Secure cookies (HTTPS only). Default on; disable for plain-HTTP local dev.
        self.cookie_secure = _bool("ENCUESTUM_COOKIE_SECURE", True)
        self.cookie_samesite = os.getenv("ENCUESTUM_COOKIE_SAMESITE", "lax")

        # CORS. Comma-separated allowed origins; empty => same-origin only.
        raw = os.getenv("ENCUESTUM_CORS_ORIGINS", "")
        self.cors_origins = [o.strip() for o in raw.split(",") if o.strip()]

        # Registration gate: allow public self-signup, or lock it down.
        self.allow_registration = _bool("ENCUESTUM_ALLOW_REGISTRATION", True)

        # Security headers / HSTS (only meaningful behind HTTPS).
        self.enable_hsts = _bool("ENCUESTUM_ENABLE_HSTS", True)

        # Rate limiting (in-memory). Disable in tests / single-user setups.
        self.rate_limit_enabled = _bool("ENCUESTUM_RATE_LIMIT_ENABLED", True)

        # Environment label (affects a couple of dev conveniences).
        self.env = os.getenv("ENCUESTUM_ENV", "production").strip().lower()

    @property
    def is_dev(self) -> bool:
        return self.env in {"dev", "development", "local"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
