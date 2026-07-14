from datetime import datetime, timezone
from typing import Optional
import secrets
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_slug() -> str:
    return secrets.token_urlsafe(8)


# ── Roles within an organization ─────────────────────────────────────────────
ROLE_OWNER = "owner"
ROLE_ADMIN = "admin"
ROLE_MEMBER = "member"
VALID_ROLES = {ROLE_OWNER, ROLE_ADMIN, ROLE_MEMBER}
# Rank for "at least" checks: owner > admin > member.
ROLE_RANK = {ROLE_MEMBER: 1, ROLE_ADMIN: 2, ROLE_OWNER: 3}


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    email: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False)
    )
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    password_hash: str = Field(sa_column=Column(String, nullable=False))
    is_active: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="1"), default=True
    )
    email_verified: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    is_superadmin: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Organization(SQLModel, table=True):
    __tablename__ = "organizations"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    name: str = Field(sa_column=Column(String, nullable=False))
    slug: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False),
        default_factory=_new_slug,
    )
    # Optional custom subdomain (e.g. "acme" → acme.encuestum.com).
    subdomain: Optional[str] = Field(
        sa_column=Column(String, unique=True, index=True), default=None
    )
    logo: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Membership(SQLModel, table=True):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "org_id", name="uq_membership_user_org"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    user_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    role: str = Field(sa_column=Column(String, nullable=False), default=ROLE_MEMBER)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Invitation(SQLModel, table=True):
    __tablename__ = "invitations"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    email: str = Field(sa_column=Column(String, index=True, nullable=False))
    role: str = Field(sa_column=Column(String, nullable=False), default=ROLE_MEMBER)
    invited_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    accepted_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Webhook(SQLModel, table=True):
    __tablename__ = "webhooks"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    # null → applies to every survey in the org; set → only that survey.
    survey_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("surveys.id", ondelete="CASCADE"), index=True), default=None
    )
    url: str = Field(sa_column=Column(String, nullable=False))
    secret: str = Field(sa_column=Column(String, nullable=False), default_factory=lambda: secrets.token_hex(24))
    active: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="1"), default=True
    )
    created_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Asset(SQLModel, table=True):
    __tablename__ = "assets"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    kind: str = Field(sa_column=Column(String, nullable=False))  # image | audio
    filename: str = Field(sa_column=Column(String, nullable=False))  # stored file name
    original_name: Optional[str] = Field(sa_column=Column(String), default=None)
    content_type: str = Field(sa_column=Column(String, nullable=False))
    size: int = Field(default=0)
    created_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class Survey(SQLModel, table=True):
    __tablename__ = "surveys"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    created_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    title: Optional[str] = Field(sa_column=Column(String), default=None)
    slug: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False),
        default_factory=_new_slug,
    )
    json_schema: dict = Field(sa_column=Column(JSON, nullable=False), default_factory=dict)
    status: str = Field(sa_column=Column(String, nullable=False), default="draft")
    language: Optional[str] = Field(sa_column=Column(String), default=None)
    # Auto-close controls: after this date, or once this many responses arrive.
    opens_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    closes_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    max_responses: Optional[int] = Field(sa_column=Column(Integer), default=None)
    # Access control: how respondents get in.
    #   public → anyone with the link; pin → shared password; list → email allowlist.
    access_mode: str = Field(
        sa_column=Column(String, nullable=False, server_default="public"), default="public"
    )
    access_pin: Optional[str] = Field(sa_column=Column(String), default=None)
    # When respondents may see their AI correction: immediate | on_release | never.
    results_mode: str = Field(
        sa_column=Column(String, nullable=False, server_default="immediate"), default="immediate"
    )
    # For results_mode=on_release: owner flips this to publish grades to respondents.
    results_released: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    # Comma-separated emails notified on each new response (empty → no notifs).
    notify_emails: Optional[str] = Field(sa_column=Column(String), default=None)
    # After submit: a custom thank-you message and/or a redirect URL.
    thankyou_message: Optional[str] = Field(sa_column=Column(String), default=None)
    redirect_url: Optional[str] = Field(sa_column=Column(String), default=None)
    # Mensaje mostrado mientras se procesa/corrige la respuesta (útil en evaluaciones
    # con IA, donde el respondiente espera unos segundos). Vacío = texto por defecto.
    grading_message: Optional[str] = Field(sa_column=Column(String), default=None)
    # Anti-bot: require a proof-of-work challenge before accepting a submission
    # (only meaningful for public/anonymous surveys).
    require_captcha: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    theme: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Answer keys / rubrics / exam settings. SERVER-SIDE ONLY.
    evaluation: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Cached grounded AI insights over open-text answers.
    insights: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Papelera (soft-delete): al borrar se marca la fecha en vez de destruir la
    # encuesta y sus respuestas. Una encuesta en la papelera no se lista, no se
    # edita y — crítico — deja de responderse desde su link público. Se puede
    # restaurar, o purgar definitivamente (ahí sí se borra de verdad).
    deleted_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True), index=True), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )
    updated_at: datetime = Field(
        sa_column=Column(
            DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
        )
    )


class SurveyResponse(SQLModel, table=True):
    __tablename__ = "survey_responses"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    answers: dict = Field(sa_column=Column(JSON, nullable=False), default_factory=dict)
    meta: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Respondent identity (set when the survey is access-gated by email list).
    respondent_email: Optional[str] = Field(
        sa_column=Column(String, index=True), default=None
    )
    respondent_code: Optional[str] = Field(
        sa_column=Column(String, index=True), default=None
    )
    completed: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="1"), default=True
    )
    submitted_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )
    # Grading
    score: Optional[float] = Field(sa_column=Column(Float), default=None)
    max_score: Optional[float] = Field(sa_column=Column(Float), default=None)
    needs_review: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    grade: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    graded_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )


# ── AI providers, usage tracking and editable pricing ────────────────────────
AI_KINDS = {"openai", "openrouter", "custom"}


class AiProvider(SQLModel, table=True):
    """A configured LLM provider account. org_id NULL = platform-global default;
    set = an organization's own override. api_key is stored and masked on read."""

    __tablename__ = "ai_providers"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    # null → global/platform provider; set → org-specific override.
    org_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True),
        default=None,
    )
    name: str = Field(sa_column=Column(String, nullable=False))
    kind: str = Field(sa_column=Column(String, nullable=False))  # openai | openrouter | custom
    base_url: str = Field(sa_column=Column(String, nullable=False))
    api_key: str = Field(sa_column=Column(String, nullable=False))
    model: str = Field(sa_column=Column(String, nullable=False))
    is_default: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    enabled: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="1"), default=True
    )
    created_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class AiUsage(SQLModel, table=True):
    """One row per AI call: tokens consumed and approximate cost, for tracking."""

    __tablename__ = "ai_usage"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True),
        default=None,
    )
    provider_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("ai_providers.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    survey_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("surveys.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    operation: str = Field(sa_column=Column(String, nullable=False))  # generate | grade | insights
    model: str = Field(sa_column=Column(String, nullable=False))
    prompt_tokens: int = Field(sa_column=Column(Integer, nullable=False, server_default="0"), default=0)
    completion_tokens: int = Field(sa_column=Column(Integer, nullable=False, server_default="0"), default=0)
    total_tokens: int = Field(sa_column=Column(Integer, nullable=False, server_default="0"), default=0)
    cost_usd: Optional[float] = Field(sa_column=Column(Float), default=None)
    created_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL")), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class AiModelPrice(SQLModel, table=True):
    """Editable price table (USD per 1M tokens). Used to convert tokens → money
    when the provider doesn't report cost directly."""

    __tablename__ = "ai_model_prices"
    __table_args__ = (UniqueConstraint("kind", "model", name="uq_ai_price_kind_model"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    kind: str = Field(sa_column=Column(String, nullable=False))  # openai | openrouter | custom
    model: str = Field(sa_column=Column(String, nullable=False))
    input_per_m: float = Field(sa_column=Column(Float, nullable=False))  # USD / 1M input tokens
    output_per_m: float = Field(sa_column=Column(Float, nullable=False))  # USD / 1M output tokens
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class SurveyInvitee(SQLModel, table=True):
    """An email allowed to answer an access=list survey, with a unique code used
    both to enter and to retrieve results later."""

    __tablename__ = "survey_invitees"
    __table_args__ = (UniqueConstraint("survey_id", "email", name="uq_invitee_survey_email"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    email: str = Field(sa_column=Column(String, nullable=False, index=True))
    code: str = Field(
        sa_column=Column(String, nullable=False, index=True),
        default_factory=lambda: secrets.token_hex(4).upper(),
    )
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    used_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    sent_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class SurveyVisit(SQLModel, table=True):
    """One row per visitor per survey (anonymous funnel tracking): view →
    started → completed, plus the last question seen (drop-off point)."""

    __tablename__ = "survey_visits"
    __table_args__ = (UniqueConstraint("survey_id", "visitor_id", name="uq_visit_survey_visitor"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    visitor_id: str = Field(sa_column=Column(String, nullable=False, index=True))
    started: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    completed: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    last_question: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )
    last_seen_at: datetime = Field(
        sa_column=Column(
            DateTime(timezone=True), nullable=False, default=_utcnow, onupdate=_utcnow
        )
    )
