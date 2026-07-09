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

        # Platform super-admin: this email always has super-admin access (plus any
        # user explicitly flagged is_superadmin).
        self.superadmin_email = (os.getenv("ENCUESTUM_SUPERADMIN_EMAIL") or "").strip().lower() or None

        # Security headers / HSTS (only meaningful behind HTTPS).
        self.enable_hsts = _bool("ENCUESTUM_ENABLE_HSTS", True)

        # Rate limiting. In-memory by default; if a Redis URL is set, the limiter
        # uses it (needed when running more than one instance).
        self.rate_limit_enabled = _bool("ENCUESTUM_RATE_LIMIT_ENABLED", True)
        self.redis_url = (os.getenv("ENCUESTUM_REDIS_URL") or "").strip() or None

        # Deliver responses to configured webhooks (Zapier/Sheets/…).
        self.webhooks_enabled = _bool("ENCUESTUM_WEBHOOKS_ENABLED", True)

        # Assets (uploaded images/audio for survey design).
        self.asset_dir = os.getenv(
            "ENCUESTUM_ASSET_DIR",
            os.path.join(os.getenv("ENCUESTUM_DATA_DIR", "/app_data"), "assets"),
        )
        self.asset_max_image_mb = float(os.getenv("ENCUESTUM_ASSET_MAX_IMAGE_MB", "8"))
        self.asset_max_audio_mb = float(os.getenv("ENCUESTUM_ASSET_MAX_AUDIO_MB", "15"))
        self.asset_max_video_mb = float(os.getenv("ENCUESTUM_ASSET_MAX_VIDEO_MB", "50"))

        # Storage backend: "local" (disk under asset_dir) or "s3" (S3-compatible,
        # e.g. Cloudflare R2). With s3, big files upload straight from the browser
        # to the bucket via presigned URLs — the app server never holds them.
        self.storage = (os.getenv("ENCUESTUM_STORAGE") or "local").strip().lower()
        self.s3_endpoint = (os.getenv("ENCUESTUM_S3_ENDPOINT") or "").strip() or None
        self.s3_bucket = (os.getenv("ENCUESTUM_S3_BUCKET") or "").strip() or None
        self.s3_access_key = os.getenv("ENCUESTUM_S3_ACCESS_KEY_ID") or None
        self.s3_secret_key = os.getenv("ENCUESTUM_S3_SECRET_ACCESS_KEY") or None
        self.s3_region = (os.getenv("ENCUESTUM_S3_REGION") or "auto").strip()
        # Public base to SERVE files (R2 public bucket domain or a CDN/custom domain).
        self.s3_public_url = (os.getenv("ENCUESTUM_S3_PUBLIC_URL") or "").strip().rstrip("/") or None
        self.s3_prefix = (os.getenv("ENCUESTUM_S3_PREFIX") or "").strip().strip("/")
        # Presigned-upload URL lifetime (seconds).
        self.upload_url_ttl = int(os.getenv("ENCUESTUM_UPLOAD_URL_TTL", "900"))

        # Public base URL used to build links in emails (invites, reset, verify).
        # Falls back to the first CORS origin, then localhost.
        self.public_base_url = (os.getenv("ENCUESTUM_PUBLIC_URL") or "").strip().rstrip("/")
        if not self.public_base_url:
            self.public_base_url = (self.cors_origins[0] if self.cors_origins else "http://localhost:8080").rstrip("/")

        # Email verification. Off by default so nobody gets locked out when SMTP
        # isn't configured; turn on to require a verified email before login.
        self.require_email_verification = _bool("ENCUESTUM_REQUIRE_EMAIL_VERIFICATION", False)

        # SMTP (optional). If host is unset, emails are logged instead of sent
        # (the link shows up in the logs) so the flows are usable in dev.
        self.smtp_host = (os.getenv("ENCUESTUM_SMTP_HOST") or "").strip() or None
        self.smtp_port = int(os.getenv("ENCUESTUM_SMTP_PORT", "587"))
        self.smtp_user = os.getenv("ENCUESTUM_SMTP_USER") or None
        self.smtp_password = os.getenv("ENCUESTUM_SMTP_PASSWORD") or None
        self.smtp_tls = _bool("ENCUESTUM_SMTP_TLS", True)
        self.email_from = os.getenv("ENCUESTUM_EMAIL_FROM", "Encuestum <no-reply@encuestum.local>")

        # Token lifetimes (hours).
        self.invite_ttl_hours = int(os.getenv("ENCUESTUM_INVITE_TTL_HOURS", "168"))  # 7 días
        self.reset_ttl_hours = int(os.getenv("ENCUESTUM_RESET_TTL_HOURS", "2"))
        self.verify_ttl_hours = int(os.getenv("ENCUESTUM_VERIFY_TTL_HOURS", "72"))

        # Environment label (affects a couple of dev conveniences).
        self.env = os.getenv("ENCUESTUM_ENV", "production").strip().lower()

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host)

    @property
    def use_s3(self) -> bool:
        return self.storage == "s3"

    @property
    def is_dev(self) -> bool:
        return self.env in {"dev", "development", "local"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
