"""Pydantic request/response models for the API."""

from datetime import datetime
from typing import Any, List, Optional
import uuid

from pydantic import BaseModel, Field

from app.models import Survey

VALID_STATUSES = {"draft", "published", "closed"}

PUBLIC_EVALUATION_KEYS = {
    "enabled", "feedbackTiming", "showScoreToRespondent", "passingScore", "integrity",
}


def public_evaluation_meta(evaluation: Optional[dict]) -> Optional[dict]:
    if not evaluation or not evaluation.get("enabled"):
        return None
    return {k: evaluation.get(k) for k in PUBLIC_EVALUATION_KEYS if k in evaluation}


class SurveyCreateRequest(BaseModel):
    title: Optional[str] = None
    json_schema: dict[str, Any] = Field(default_factory=dict)
    language: Optional[str] = None
    theme: Optional[dict[str, Any]] = None
    evaluation: Optional[dict[str, Any]] = None


class SurveyUpdateRequest(BaseModel):
    title: Optional[str] = None
    json_schema: Optional[dict[str, Any]] = None
    status: Optional[str] = None
    language: Optional[str] = None
    theme: Optional[dict[str, Any]] = None
    evaluation: Optional[dict[str, Any]] = None
    closes_at: Optional[datetime] = None
    max_responses: Optional[int] = None
    access_mode: Optional[str] = None  # public | pin | list
    access_pin: Optional[str] = None
    results_mode: Optional[str] = None  # immediate | on_release | never
    notify_emails: Optional[str] = None  # comma-separated owner notification emails
    thankyou_message: Optional[str] = None
    redirect_url: Optional[str] = None
    require_captcha: Optional[bool] = None


class SurveySummary(BaseModel):
    id: uuid.UUID
    title: Optional[str]
    slug: str
    status: str
    language: Optional[str]
    response_count: int
    is_evaluation: bool
    created_at: datetime
    updated_at: datetime


class SurveyDetail(BaseModel):
    id: uuid.UUID
    title: Optional[str]
    slug: str
    status: str
    language: Optional[str]
    json_schema: dict[str, Any]
    theme: Optional[dict[str, Any]]
    evaluation: Optional[dict[str, Any]]
    closes_at: Optional[datetime] = None
    max_responses: Optional[int] = None
    access_mode: str = "public"
    access_pin: Optional[str] = None
    results_mode: str = "immediate"
    results_released: bool = False
    notify_emails: Optional[str] = None
    thankyou_message: Optional[str] = None
    redirect_url: Optional[str] = None
    require_captcha: bool = False
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, s: Survey) -> "SurveyDetail":
        return cls(
            id=s.id, title=s.title, slug=s.slug, status=s.status, language=s.language,
            json_schema=s.json_schema or {}, theme=s.theme, evaluation=s.evaluation,
            closes_at=s.closes_at, max_responses=s.max_responses,
            access_mode=getattr(s, "access_mode", "public"),
            access_pin=getattr(s, "access_pin", None),
            results_mode=getattr(s, "results_mode", "immediate"),
            results_released=getattr(s, "results_released", False),
            notify_emails=getattr(s, "notify_emails", None),
            thankyou_message=getattr(s, "thankyou_message", None),
            redirect_url=getattr(s, "redirect_url", None),
            require_captcha=bool(getattr(s, "require_captcha", False)),
            created_at=s.created_at, updated_at=s.updated_at,
        )


class PublicSurvey(BaseModel):
    slug: str
    title: Optional[str]
    language: Optional[str]
    json_schema: dict[str, Any]
    theme: Optional[dict[str, Any]]
    evaluation: Optional[dict[str, Any]] = None
    available: bool = True
    closed_reason: Optional[str] = None
    # Access gating: when gated is True the schema is withheld until the
    # respondent passes the access step (PIN or email+code).
    access_mode: str = "public"
    gated: bool = False
    # Post-submit customization (rendered by the public page after completion).
    thankyou_message: Optional[str] = None
    redirect_url: Optional[str] = None
    # Anti-bot: when true the public page must solve a proof-of-work before submit.
    require_captcha: bool = False


class SubmitResponseRequest(BaseModel):
    answers: dict[str, Any] = Field(default_factory=dict)
    completed: bool = True
    meta: Optional[dict[str, Any]] = None
    access_token: Optional[str] = None
    # Solved proof-of-work challenge (only required if the survey opts in).
    captcha: Optional[dict[str, Any]] = None


class SurveyAccessRequest(BaseModel):
    pin: Optional[str] = None
    email: Optional[str] = None
    code: Optional[str] = None


class ResultLookupRequest(BaseModel):
    email: str
    code: str


class GradeQuestionRequest(BaseModel):
    name: str
    answer: Any = None
    access_token: Optional[str] = None


class ResponseItem(BaseModel):
    id: uuid.UUID
    answers: dict[str, Any]
    completed: bool
    meta: Optional[dict[str, Any]]
    submitted_at: datetime
    score: Optional[float] = None
    max_score: Optional[float] = None
    needs_review: bool = False
    grade: Optional[dict[str, Any]] = None
    graded_at: Optional[datetime] = None

    @classmethod
    def from_model(cls, r) -> "ResponseItem":
        return cls(
            id=r.id, answers=r.answers or {}, completed=r.completed, meta=r.meta,
            submitted_at=r.submitted_at, score=r.score, max_score=r.max_score,
            needs_review=r.needs_review, grade=r.grade, graded_at=r.graded_at,
        )


class OverrideRequest(BaseModel):
    awards: Optional[dict[str, float]] = None
    total: Optional[float] = None
    clear_review: bool = True
    note: Optional[str] = None


class GenerateQuestionsRequest(BaseModel):
    topic: str
    count: int = 5
    types: List[str] = Field(default_factory=lambda: ["radiogroup", "comment"])
    language: str = "es"
    difficulty: str = "media"
    context: Optional[str] = None
