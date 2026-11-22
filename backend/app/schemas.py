"""Pydantic request/response models for the API."""

from datetime import datetime
from typing import Any, List, Optional
import uuid

from pydantic import BaseModel, Field

from app.config import get_settings as _get_settings
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
    slug: Optional[str] = None  # link personalizado (se normaliza y valida unicidad)
    json_schema: Optional[dict[str, Any]] = None
    status: Optional[str] = None
    language: Optional[str] = None
    theme: Optional[dict[str, Any]] = None
    evaluation: Optional[dict[str, Any]] = None
    opens_at: Optional[datetime] = None
    closes_at: Optional[datetime] = None
    max_responses: Optional[int] = None
    # Intentos por persona (distinto del cupo total). None/0 = sin límite.
    max_attempts: Optional[int] = None
    # Carpeta que la contiene (None = sin clasificar).
    folder_id: Optional[uuid.UUID] = None
    access_mode: Optional[str] = None  # public | pin | list
    access_pin: Optional[str] = None
    results_mode: Optional[str] = None  # immediate | on_release | never
    notify_emails: Optional[str] = None  # comma-separated owner notification emails
    thankyou_message: Optional[str] = None
    grading_message: Optional[str] = None  # texto mientras se procesa/corrige
    redirect_url: Optional[str] = None
    require_captcha: Optional[bool] = None
    # Privacidad y distribución (ver app/privacy.py y app/distribution.py).
    anonymous: Optional[bool] = None
    retention_days: Optional[int] = None  # 0 = sin retención
    retention_action: Optional[str] = None  # anonymize | delete
    reminders: Optional[dict[str, Any]] = None
    # Campos ocultos de la URL, cupos y link público de resultados (app/fields.py).
    hidden_fields: Optional[List[str]] = None
    quotas: Optional[List[dict[str, Any]]] = None
    public_results: Optional[dict[str, Any]] = None
    # Control de concurrencia: el `content_hash` que el editor tenía al cargar o
    # al último guardado. Sin él no se controla (llamadores viejos, API).
    base_content_hash: Optional[str] = None
    # Guardado manual (botón Guardar / Ctrl+S): deja una versión en el
    # historial. El autoguardado deja una cada 15 minutos como mucho.
    snapshot: Optional[bool] = None


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
    # Carpeta que la contiene (None = sin clasificar).
    folder_id: Optional[uuid.UUID] = None
    # Solo lo completa el listado de la papelera; en el listado normal va en None.
    deleted_at: Optional[datetime] = None


class SurveyDetail(BaseModel):
    id: uuid.UUID
    title: Optional[str]
    slug: str
    status: str
    language: Optional[str]
    json_schema: dict[str, Any]
    theme: Optional[dict[str, Any]]
    evaluation: Optional[dict[str, Any]]
    opens_at: Optional[datetime] = None
    closes_at: Optional[datetime] = None
    max_responses: Optional[int] = None
    # Intentos por persona (distinto del cupo total). None/0 = sin límite.
    max_attempts: Optional[int] = None
    # Carpeta que la contiene (None = sin clasificar).
    folder_id: Optional[uuid.UUID] = None
    # Zona horaria del servidor (config global) para que el panel interprete/muestre
    # opens_at/closes_at. No se guarda por encuesta; es un espejo de la config.
    timezone: str = "UTC"
    access_mode: str = "public"
    access_pin: Optional[str] = None
    results_mode: str = "immediate"
    results_released: bool = False
    notify_emails: Optional[str] = None
    thankyou_message: Optional[str] = None
    grading_message: Optional[str] = None
    redirect_url: Optional[str] = None
    require_captcha: bool = False
    anonymous: bool = False
    retention_days: Optional[int] = None
    retention_action: Optional[str] = None
    reminders: Optional[dict[str, Any]] = None
    hidden_fields: Optional[List[str]] = None
    quotas: Optional[List[dict[str, Any]]] = None
    public_results: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime
    # Huella del contenido editable (preguntas, corrección, diseño, título).
    # El editor la devuelve en `base_content_hash` al guardar: si no coincide,
    # alguien más cambió la encuesta mientras tanto (ver `update_survey`).
    content_hash: Optional[str] = None

    @classmethod
    def from_model(cls, s: Survey) -> "SurveyDetail":
        from app.audit import survey_content_hash

        return cls(
            id=s.id, title=s.title, slug=s.slug, status=s.status, language=s.language,
            json_schema=s.json_schema or {}, theme=s.theme, evaluation=s.evaluation,
            opens_at=getattr(s, "opens_at", None),
            closes_at=s.closes_at, max_responses=s.max_responses,
            max_attempts=s.max_attempts, folder_id=s.folder_id,
            timezone=_get_settings().timezone,
            access_mode=getattr(s, "access_mode", "public"),
            access_pin=getattr(s, "access_pin", None),
            results_mode=getattr(s, "results_mode", "immediate"),
            results_released=getattr(s, "results_released", False),
            notify_emails=getattr(s, "notify_emails", None),
            thankyou_message=getattr(s, "thankyou_message", None),
            grading_message=getattr(s, "grading_message", None),
            redirect_url=getattr(s, "redirect_url", None),
            require_captcha=bool(getattr(s, "require_captcha", False)),
            anonymous=bool(getattr(s, "anonymous", False)),
            retention_days=getattr(s, "retention_days", None),
            retention_action=getattr(s, "retention_action", None),
            reminders=getattr(s, "reminders", None),
            hidden_fields=getattr(s, "hidden_fields", None),
            quotas=getattr(s, "quotas", None),
            public_results=getattr(s, "public_results", None),
            created_at=s.created_at, updated_at=s.updated_at,
            content_hash=survey_content_hash(s),
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
    grading_message: Optional[str] = None
    redirect_url: Optional[str] = None
    # Anti-bot: when true the public page must solve a proof-of-work before submit.
    require_captcha: bool = False
    # Parámetros de la URL que se guardan con la respuesta (campos ocultos).
    hidden_fields: List[str] = []
    # Idiomas en que se puede responder (el primero es el original).
    languages: List[str] = []


class SubmitResponseRequest(BaseModel):
    answers: dict[str, Any] = Field(default_factory=dict)
    completed: bool = True
    meta: Optional[dict[str, Any]] = None
    access_token: Optional[str] = None
    # Solved proof-of-work challenge (only required if the survey opts in).
    captcha: Optional[dict[str, Any]] = None
    # Intento de examen (ver POST /public/{slug}/start y app/exam.py).
    attempt_token: Optional[str] = None


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
    # Fuera de los resultados sin estar borrada (ver app/hygiene.py).
    excluded: bool = False
    is_test: bool = False
    # Trazabilidad (ver app/audit.py).
    survey_version_id: Optional[uuid.UUID] = None
    # True/False: la huella coincide o no; None: respuesta anterior a la huella.
    integrity_ok: Optional[bool] = None

    @classmethod
    def from_model(cls, r) -> "ResponseItem":
        from app.audit import verify_response

        return cls(
            id=r.id, answers=r.answers or {}, completed=r.completed, meta=r.meta,
            submitted_at=r.submitted_at, score=r.score, max_score=r.max_score,
            needs_review=r.needs_review, grade=r.grade, graded_at=r.graded_at,
            excluded=bool(getattr(r, "excluded", False)),
            is_test=bool(getattr(r, "is_test", False)),
            survey_version_id=getattr(r, "survey_version_id", None),
            integrity_ok=verify_response(r) if hasattr(r, "integrity_hash") else None,
        )


class OverrideRequest(BaseModel):
    awards: Optional[dict[str, float]] = None
    total: Optional[float] = None
    clear_review: bool = True
    note: Optional[str] = None
    # Comentario editado a mano, por nombre de pregunta. Vacío borra la edición.
    feedback: Optional[dict[str, str]] = None
    # Visto bueno a los comentarios de esta corrección (ver evaluation
    # `feedbackReview`): sin él, el texto que redactó la IA no se muestra.
    approve_feedback: Optional[bool] = None


class GenerateQuestionsRequest(BaseModel):
    topic: str = Field(max_length=500)
    count: int = 5
    types: List[str] = Field(default_factory=lambda: ["radiogroup", "comment"])
    language: str = "es"
    difficulty: str = "media"
    # Material base (texto). Puede ser largo: el servidor elige los fragmentos
    # relevantes (ver app/material.py), no viaja entero al modelo.
    context: Optional[str] = Field(default=None, max_length=600_000)
    # Niveles de Bloom a cubrir y objetivos de aprendizaje (opcionales).
    bloom: List[str] = Field(default_factory=list)
    objectives: Optional[str] = Field(default=None, max_length=4000)
    # Títulos que ya hay en el editor (aunque no estén guardados): no repetirlas.
    existing_titles: List[str] = Field(default_factory=list, max_length=500)
    # Generar variantes de esta pregunta en vez de preguntas nuevas.
    variant_of: Optional[dict[str, Any]] = None
