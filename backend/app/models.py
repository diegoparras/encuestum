from datetime import datetime, timezone
from typing import Optional
import secrets
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
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
    # Cuántas veces puede responder UNA MISMA persona. None o 0 = sin límite.
    # Distinto de `max_responses`, que es el cupo total de la encuesta.
    # Cómo se reconoce a "la misma persona" depende del modo de acceso: por el
    # código del invitado (infalible) o, en público/PIN, por una marca del
    # navegador y el correo que haya respondido (ver `app/attempts.py`).
    max_attempts: Optional[int] = Field(sa_column=Column(Integer), default=None)
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
    # Cached AI executive report (narrative over the computed aggregates).
    report: Optional[dict] = Field(sa_column=Column(JSON), default=None)
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


# Una respuesta que vino de Moodle pertenece a UN solo origen: o al vínculo LTI
# (`lti_link_id`, camino `mod_lti`/`local_encuestum`) o al sitio del módulo
# nativo (`mod_site_id`, camino `mod_encuestum`). Nunca a los dos.
#
# El invariante lo garantiza el motor y no la aplicación a propósito: el
# despacho de la nota (`_deliver` en `app/lti/ags.py`) elige el transporte
# mirando estas dos columnas, y una fila con las dos puestas es un caso
# ambiguo -- el desenlace más probable es publicar la misma nota dos veces,
# por AGS y por el servicio web, en dos actividades distintas de Moodle. Una
# regla que vive sólo en el código se rompe con el primer script de migración
# de datos que alguien escriba a mano.
_CK_UN_SOLO_ORIGEN = "ck_survey_responses_un_solo_origen"
_SQL_UN_SOLO_ORIGEN = "NOT (lti_link_id IS NOT NULL AND mod_site_id IS NOT NULL)"


class SurveyResponse(SQLModel, table=True):
    __tablename__ = "survey_responses"
    __table_args__ = (CheckConstraint(_SQL_UN_SOLO_ORIGEN, name=_CK_UN_SOLO_ORIGEN),)

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
    # Atribución LTI: de qué actividad de qué LMS vino esta respuesta.
    lti_link_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("lti_resource_links.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    # El identificador opaco del alumno del lado de Moodle. Se llama `lti_sub`
    # por historia, pero lo comparten los DOS caminos: en LTI es el `sub` del
    # id_token y en `mod_encuestum` es el HMAC que calcula Moodle con un
    # secreto suyo. En ambos es "a quién le corresponde la nota", y en ambos
    # queda en NULL cuando la actividad es anónima -- que es lo que corta la
    # publicación de la nota antes de cualquier request saliente.
    lti_sub: Optional[str] = Field(sa_column=Column(String, index=True), default=None)
    # ── Atribución del módulo nativo (`mod_encuestum`) ───────────────────────
    #
    # A diferencia de LTI, acá Encuestum no persiste la actividad: no hay
    # `LtiResourceLink` que apuntar porque el vínculo vive del lado de Moodle.
    # Lo único que llega es el token de lanzamiento, y de él salen estas tres
    # columnas. Sin ellas la respuesta no tenía ninguna referencia a la
    # actividad de origen y la nota no tenía a dónde volver.
    #
    # `ondelete="SET NULL"`: desconectar el Moodle borra la fila de `mod_sites`
    # y las respuestas quedan en pie -- son datos del alumno, no del vínculo.
    mod_site_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("mod_sites.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    # `course_module id` de Moodle: identifica la actividad concreta dentro del
    # curso, y es el primer argumento del servicio web que publica la nota.
    mod_cmid: Optional[int] = Field(sa_column=Column(Integer), default=None)
    # `grademax` del `grade_item` de esa actividad, congelado en el momento del
    # lanzamiento. La escala la define Moodle, no la rúbrica, y viaja en el
    # token porque preguntarla costaría un round-trip sincrónico más y una
    # segunda función de servicio web. El razonamiento completo (y por qué la
    # ventana de desfasaje es aceptable) está en `app/mod/grades.py`.
    mod_grademax: Optional[float] = Field(sa_column=Column(Float), default=None)
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
    # ── Higiene de resultados ────────────────────────────────────────────────
    #
    # Dos formas de sacar una respuesta de los resultados SIN destruirla, que es
    # lo que hace falta la mayoría de las veces (limpiar la vista, no borrar
    # datos). Ambas la excluyen de tablas, resumen, estadísticas, informe y
    # exportaciones, y ambas se pueden revertir.
    #
    # `excluded`: alguien la sacó a mano (respuesta basura, duplicada, de prueba).
    # `is_test`: la marcó el sistema porque la envió alguien del equipo dueño de
    # la encuesta mientras la probaba. Se distinguen para poder decir POR QUÉ no
    # está contada.
    excluded: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0", index=True),
        default=False,
    )
    is_test: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0", index=True),
        default=False,
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


class ResponseDeletion(SQLModel, table=True):
    """Quién borró qué respuesta y cuándo.

    Borrar una respuesta es irreversible y solo pueden hacerlo los admins, así
    que queda rastro. A propósito NO hay clave foránea a la respuesta: la fila
    sobrevive justamente porque la respuesta ya no existe. Se guarda un resumen
    de a quién correspondía (sin arrastrar todas las respuestas) para que el
    registro sirva de algo al leerlo.
    """

    __tablename__ = "response_deletions"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    response_id: uuid.UUID = Field(index=True)
    # Quién borró. SET NULL para no perder el registro si se da de baja la cuenta.
    deleted_by: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="SET NULL"), index=True),
        default=None,
    )
    deleted_by_email: Optional[str] = Field(sa_column=Column(String), default=None)
    # A quién correspondía la respuesta borrada (lo que se supiera).
    respondent: Optional[str] = Field(sa_column=Column(String), default=None)
    submitted_at: Optional[datetime] = Field(
        sa_column=Column(DateTime(timezone=True)), default=None
    )
    deleted_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


# ── LTI 1.3 (Encuestum como herramienta de un LMS) ───────────────────────────


class LtiPlatform(SQLModel, table=True):
    """Un LMS registrado (típicamente un Moodle). En el modelo self-hosted suele
    haber una sola fila, pero el protocolo obliga a soportar varias."""

    __tablename__ = "lti_platforms"
    __table_args__ = (
        UniqueConstraint("issuer", "client_id", name="uq_lti_platform_issuer_client"),
    )

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    issuer: str = Field(sa_column=Column(String, index=True, nullable=False))
    client_id: str = Field(sa_column=Column(String, nullable=False))
    # Un mismo LMS puede desplegar la herramienta varias veces.
    deployment_ids: list = Field(sa_column=Column(JSON, nullable=False), default_factory=list)
    auth_login_url: str = Field(sa_column=Column(String, nullable=False))
    auth_token_url: str = Field(sa_column=Column(String, nullable=False))
    jwks_url: str = Field(sa_column=Column(String, nullable=False))
    # Organización de Encuestum a la que pertenecen las encuestas de este LMS.
    org_id: Optional[uuid.UUID] = Field(
        sa_column=Column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True),
        default=None,
    )
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiResourceLink(SQLModel, table=True):
    """La atadura entre una actividad concreta de un curso y una encuesta."""

    __tablename__ = "lti_resource_links"
    __table_args__ = (
        UniqueConstraint("platform_id", "resource_link_id", name="uq_lti_link"),
    )

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    platform_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("lti_platforms.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    resource_link_id: str = Field(sa_column=Column(String, nullable=False))
    context_id: Optional[str] = Field(sa_column=Column(String), default=None)
    # Título del curso tal como lo manda Moodle en el claim de contexto. Se
    # guarda sólo para poder mostrar algo legible en el panel: sin esto la
    # única referencia al curso es un id opaco que no le dice nada a nadie.
    context_title: Optional[str] = Field(sa_column=Column(String), default=None)
    # Vínculo anónimo: la respuesta no se atribuye a nadie y NO se publica nota.
    # Las dos cosas van juntas — publicar una nota por alumno es identificarlo.
    anonymous: bool = Field(
        sa_column=Column(Boolean, nullable=False, server_default="0"), default=False
    )
    survey_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("surveys.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    # Endpoint AGS donde se publica la nota. Null = la actividad no lleva nota.
    lineitem_url: Optional[str] = Field(sa_column=Column(String), default=None)
    lineitems_url: Optional[str] = Field(sa_column=Column(String), default=None)
    # Escala del libro de calificaciones del LMS (no la de la rúbrica).
    max_score: Optional[float] = Field(sa_column=Column(Float), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiUser(SQLModel, table=True):
    """Un usuario del LMS. `sub` es el identificador estable que manda la
    plataforma; es único dentro de la plataforma, no globalmente."""

    __tablename__ = "lti_users"
    __table_args__ = (UniqueConstraint("platform_id", "sub", name="uq_lti_user"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    platform_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("lti_platforms.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    sub: str = Field(sa_column=Column(String, nullable=False, index=True))
    email: Optional[str] = Field(sa_column=Column(String), default=None)
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    roles: list = Field(sa_column=Column(JSON, nullable=False), default_factory=list)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class MoodleSite(SQLModel, table=True):
    """Un Moodle conectado por el módulo nativo (`mod_encuestum`), no por LTI.

    `public_key`: la firma del lanzamiento es **asimétrica (RS256)**, no un
    secreto compartido. El par de claves lo genera Moodle y de acá para este
    lado viaja **sólo la pública**, que se guarda tal cual porque no es secreta.
    No es ceremonia: un secreto compartido no se puede guardar hasheado, porque
    verificar un HMAC exige la misma clave que lo firmó -- Encuestum tendría que
    guardar en claro y de forma reversible una credencial que alcanza para
    lanzar como cualquier alumno de cualquier curso. Con firma asimétrica un
    volcado de esta tabla no sirve para falsificar nada: es la misma propiedad
    que da LTI, y por la misma razón.

    La unicidad es por `wwwroot` SOLO, no por `(org_id, wwwroot)` como decía el
    plan: un Moodle firma con una única clave a nivel sitio, así que pertenece a
    exactamente una organización de Encuestum. Con la unicidad compuesta, dos
    organizaciones podían tener su propia fila para el mismo `wwwroot` y el
    chequeo de dueño del registro quedaba siendo puramente de aplicación --
    dos registros concurrentes desde organizaciones distintas se colaban por la
    ventana entre el SELECT y el INSERT. Así, el motor lo garantiza."""

    __tablename__ = "mod_sites"
    __table_args__ = (UniqueConstraint("wwwroot", name="uq_mod_site"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
    )
    # Forma canónica (ver `normalizar_wwwroot` en `app/mod/wwwroot.py`): sin
    # barra final, host en minúsculas y sin query ni fragmento. Si cada variante
    # de escritura fuera una fila distinta, la unicidad de arriba se esquivaría
    # con una barra.
    wwwroot: str = Field(sa_column=Column(String, nullable=False))
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    # Clave pública RSA en PEM (SubjectPublicKeyInfo), tal como la deja
    # `_validar_clave_publica` en `routers/modapi.py`: se reserializa al
    # guardarla, así que la forma acá adentro es siempre la misma aunque Moodle
    # la haya mandado en PKCS#1. Con ella se verifica el JWT del lanzamiento
    # (Tarea 2), siempre con `algorithms=["RS256"]` explícito: aceptar HS256
    # convertiría esta clave pública en la clave de FIRMAR.
    public_key: str = Field(sa_column=Column(String, nullable=False))
    # Token de servicio web de Moodle, para empujarle la nota (Tarea 3). Éste sí
    # es un secreto -- de ELLOS, guardado por nosotros -- y hay que poder
    # recuperarlo para usarlo, así que ni hash ni clave pública sirven. Queda en
    # claro, igual que `ai_providers.api_key`: este repo todavía no tiene
    # cifrado en reposo (el plan decía que sí). Ninguna respuesta lo devuelve.
    ws_token: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )


class LtiKey(SQLModel, table=True):
    """Par de claves RSA del tool, generado al arrancar si no vino por entorno."""

    __tablename__ = "lti_keys"

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    kid: str = Field(sa_column=Column(String, unique=True, nullable=False))
    private_pem: str = Field(sa_column=Column(String, nullable=False))
    public_pem: str = Field(sa_column=Column(String, nullable=False))
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow)
    )
