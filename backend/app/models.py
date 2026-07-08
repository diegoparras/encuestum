from datetime import datetime, timezone
from typing import Optional
import secrets
import uuid

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, ForeignKey, String
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_slug() -> str:
    return secrets.token_urlsafe(8)


class Survey(SQLModel, table=True):
    __tablename__ = "surveys"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    title: Optional[str] = Field(sa_column=Column(String), default=None)
    slug: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False),
        default_factory=_new_slug,
    )
    json_schema: dict = Field(sa_column=Column(JSON, nullable=False), default_factory=dict)
    status: str = Field(sa_column=Column(String, nullable=False), default="draft")
    language: Optional[str] = Field(sa_column=Column(String), default=None)
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
