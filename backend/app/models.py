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
    closes_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    max_responses: Optional[int] = Field(sa_column=Column(Integer), default=None)
    theme: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Answer keys / rubrics / exam settings. SERVER-SIDE ONLY.
    evaluation: Optional[dict] = Field(sa_column=Column(JSON), default=None)
    # Cached grounded AI insights over open-text answers.
    insights: Optional[dict] = Field(sa_column=Column(JSON), default=None)
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
