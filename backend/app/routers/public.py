import logging
import math
import uuid
from datetime import timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.hygiene import counted_only
from app.models import LtiResourceLink, Survey, SurveyResponse, SurveyInvitee, SurveyVisit
from app.ratelimit import rate_limit
from app.schemas import (
    GradeQuestionRequest,
    PublicSurvey,
    ResultLookupRequest,
    SubmitResponseRequest,
    SurveyAccessRequest,
    public_evaluation_meta,
)
from app.grading import (
    extract_question_choices,
    extract_question_types,
    grade_deterministic,
    grade_response,
)
from app.models import _utcnow
from app.security import create_purpose_token, read_purpose_token
from app.webhooks import schedule_response_delivery
from app.config import get_settings
from app import captcha

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/public", tags=["public"])

_ACCESS_PURPOSE = "survey_access"



def _identidad_respondida(s: Survey, answers: dict) -> tuple[str | None, str | None]:
    """(nombre, mail) que la persona escribió en la propia encuesta."""
    from app.identity import respondent_identity

    return respondent_identity(s.json_schema or {}, answers)


async def _find_invitee(session: AsyncSession, survey_id, email: str, code: str) -> SurveyInvitee | None:
    email = (email or "").strip().lower()
    code = (code or "").strip().upper()
    if not email or not code:
        return None
    inv = (
        await session.scalars(
            select(SurveyInvitee).where(
                SurveyInvitee.survey_id == survey_id, SurveyInvitee.email == email
            )
        )
    ).first()
    if inv and inv.code.upper() == code:
        return inv
    return None


def _valid_access(s: Survey, token: str | None) -> bool:
    """Public surveys need no token; gated ones require a token minted for this slug."""
    if getattr(s, "access_mode", "public") == "public":
        return True
    if not token:
        return False
    data = read_purpose_token(_ACCESS_PURPOSE, token)
    return bool(data and data.get("slug") == s.slug)


def _lti_context(request: Request, s: Survey) -> dict | None:
    """Identidad que trajo un lanzamiento del LMS para *esta* encuesta, si la hay.

    Cuando existe, la encuesta ya no pide PIN ni figurar en la lista: quien
    autenticó al alumno fue el LMS.

    La misma cookie la siembran los dos caminos a Moodle: `/lti/launch` y el
    `/mod/launch` del módulo nativo (`routers/modapi.py`), que la reusa a
    propósito para no obligar a esta función a leer dos. Por eso alcanza con
    que **cualquiera** de las dos integraciones esté prendida: una instalación
    que sólo tiene el módulo nativo (`MOD_ENABLED=1`, `LTI_ENABLED=0`) es un
    caso normal, y con el `lti_enabled` solo la cookie se ignoraba y el alumno
    caía en la pantalla del PIN."""
    from app.lti.state import LTI_COOKIE, LTI_PURPOSE

    settings = get_settings()
    if not (settings.lti_enabled or settings.mod_enabled):
        return None
    data = read_purpose_token(LTI_PURPOSE, request.cookies.get(LTI_COOKIE) or "")
    if not data or data.get("slug") != s.slug:
        return None
    return data


# Rango de `mod_cmid` en la base: la columna es `Integer` (ver `app/models.py` y
# la 0022), o sea un `int4` de Postgres. Un entero fuera de este rango no es un
# valor "grande": es un INSERT que asyncpg rechaza con `DataError: value out of
# int32 range` -- y como el `cmid` viaja en el MISMO INSERT que la respuesta del
# alumno, se cae la fila entera.
_INT32_MIN = -(2**31)
_INT32_MAX = 2**31 - 1


def _entero(valor) -> int | None:
    """El claim tal como lo mandó Moodle, si es un entero que la columna acepta.
    `None` si no.

    Los claims del token de lanzamiento vienen de JSON: `cmid` puede llegar como
    número o como string según cómo lo serialice el plugin, y un plugin roto
    puede mandar cualquier cosa. Que un valor raro deje la columna en NULL (y la
    nota sin publicar) es preferible a un 500 en el submit de un alumno cuya
    respuesta, del lado de Encuestum, salió perfecta.

    Por eso no alcanza con que `int()` no levante: `int("1000000000000")`
    devuelve un entero perfecto que la columna `int4` no puede guardar, y el
    error sale recién en el `flush`, cuando el `SurveyResponse` ya es parte del
    INSERT. Es el mismo modo de falla que `_sitio_del_modulo` existe para
    evitar, y se cierra igual: fuera de rango -> NULL."""
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        return None
    return numero if _INT32_MIN <= numero <= _INT32_MAX else None


def _flotante(valor) -> float | None:
    """Idem `_entero`, para `grademax`. Un valor no positivo se descarta: una
    escala de 0 o negativa no sirve para reescalar nada y dejarla pasar sólo
    correría el error hasta una división por cero en `app/mod/grades.py`.

    `math.isfinite` y no sólo `> 0`: `float("inf") > 0` es `True` y `inf` es un
    valor que el JSON de un token puede traer (`json.loads` acepta `Infinity`
    por defecto, y PyJWT usa el `json` de la stdlib tal cual). Sin este
    chequeo, `inf` se guardaba en la fila, `reescalar` devolvía `inf` y la nota
    salía como `grade=inf` en el POST al servicio web -- donde PHP lo castea a
    **0**. Una nota cero, en silencio, sin ningún error en ningún lado.
    `nan` ya caía por el `> 0` (toda comparación con `nan` es falsa), pero
    entra acá igual para que el motivo quede escrito."""
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        return None
    return numero if math.isfinite(numero) and numero > 0 else None


async def _sitio_del_modulo(session: AsyncSession, crudo) -> uuid.UUID | None:
    """El `site_id` del token de lanzamiento, **sólo si la fila todavía existe**.

    El SELECT extra parece de más -- el token lo firmamos nosotros y el sitio
    existía cuando se emitió -- pero la cookie vive `ACCESS_TTL_S` (4 horas) y
    en ese rato un admin puede desconectar el Moodle. Sin este chequeo, el
    INSERT chocaría contra la FK y el alumno vería un 500 al enviar una
    respuesta que del lado de Encuestum está perfecta. Así, lo peor que pasa es
    que la respuesta se guarda sin origen y la nota no se publica."""
    from app.models import MoodleSite

    if not crudo:
        return None
    try:
        site_id = uuid.UUID(str(crudo))
    except (TypeError, ValueError):
        return None
    return site_id if await session.get(MoodleSite, site_id) is not None else None


async def _visible(slug: str, session: AsyncSession) -> Survey:
    """A survey that has been published at least once (published or closed).
    Drafts / unknown slugs are 404 — they never existed publicly. Una encuesta en
    la papelera (deleted_at) también es 404: al borrarla debe dejar de responderse
    de inmediato, aunque siga siendo restaurable."""
    s = await session.scalar(
        select(Survey).where(Survey.slug == slug, Survey.deleted_at.is_(None))
    )
    if not s or s.status == "draft":
        raise HTTPException(status_code=404, detail="Survey not available")
    return s


async def _response_count(survey_id, session: AsyncSession) -> int:
    from sqlalchemy import func

    return int(
        await session.scalar(
            counted_only(select(func.count(SurveyResponse.id)).where(SurveyResponse.survey_id == survey_id))
        )
        or 0
    )


async def _availability(s: Survey, session: AsyncSession) -> tuple[bool, str | None]:
    from datetime import timezone

    if s.status == "closed":
        return False, "Esta encuesta fue cerrada."
    if s.opens_at is not None:
        opens = s.opens_at
        if opens.tzinfo is None:  # SQLite returns naive datetimes
            opens = opens.replace(tzinfo=timezone.utc)
        if _utcnow() < opens:
            return False, "Esta encuesta todavía no está abierta."
    if s.closes_at is not None:
        closes = s.closes_at
        if closes.tzinfo is None:  # SQLite returns naive datetimes
            closes = closes.replace(tzinfo=timezone.utc)
        if _utcnow() > closes:
            return False, "Esta encuesta cerró por fecha."
    if s.max_responses:
        if await _response_count(s.id, session) >= s.max_responses:
            return False, "Esta encuesta alcanzó el máximo de respuestas."
    return True, None


def _titles(schema: dict) -> dict:
    out = {}
    for p in (schema or {}).get("pages", []) or []:
        for el in p.get("elements", []) or []:
            if el.get("name"):
                out[el["name"]] = el.get("title") or el["name"]
    return out


async def _ya_cerro(s: Survey, session: AsyncSession) -> bool:
    """Si la encuesta ya no admite respuestas.

    Es la condición del modo "revelar al cerrar": mientras alguien todavía pueda
    responder, mostrarle la respuesta correcta a quien ya terminó es filtrarla.
    Deliberadamente NO alcanza con que el dueño haya publicado los resultados:
    publicar la nota de los que terminaron es una cosa y repartir la clave de
    corrección con el examen abierto es otra."""
    disponible, _ = await _availability(s, session)
    return not disponible


def _respondent_view(
    grade: dict,
    evaluation: dict,
    schema: dict,
    answers: dict | None = None,
    *,
    cerrada: bool = False,
) -> dict:
    """Lo que ve quien respondió. Incluye SU respuesta, y -- si el autor lo
    habilitó -- la correcta y por qué la suya no lo era (ver app/review.py)."""
    from app.review import vista_de_repaso

    show = bool(evaluation.get("showScoreToRespondent", True))
    questions = vista_de_repaso(
        grade, evaluation, schema, answers or {},
        titles=_titles(schema), cerrada=cerrada,
    )
    view = {"questions": questions, "needs_review": grade.get("needs_review", False)}
    if show:
        view.update({k: grade.get(k) for k in ("total", "max", "percent", "passed")})
    return view


def _public_payload(s: Survey, available: bool, reason: str | None, gated: bool) -> PublicSurvey:
    show_form = available and not gated
    return PublicSurvey(
        slug=s.slug, title=s.title, language=s.language,
        json_schema=(s.json_schema or {}) if show_form else {},
        theme=s.theme,  # theme carries branding; safe to show on the gate
        evaluation=public_evaluation_meta(s.evaluation) if show_form else None,
        available=available, closed_reason=reason,
        access_mode=getattr(s, "access_mode", "public"), gated=gated,
        thankyou_message=getattr(s, "thankyou_message", None),
        grading_message=getattr(s, "grading_message", None),
        redirect_url=getattr(s, "redirect_url", None),
        require_captcha=bool(getattr(s, "require_captcha", False))
        and get_settings().captcha_enabled,
    )


@router.get("/{slug}", response_model=PublicSurvey)
async def get_public_survey(
    slug: str,
    request: Request,
    access_token: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    # Si llegó por un lanzamiento LTI, el LMS ya autenticó al alumno: no hay
    # puerta que tocar.
    gated = available and not _valid_access(s, access_token) and not _lti_context(request, s)
    return _public_payload(s, available, reason, gated)


@router.get("/{slug}/challenge")
async def captcha_challenge(slug: str, request: Request):
    """Fresh proof-of-work challenge for the anti-bot check on submit."""
    await rate_limit(request, f"challenge:{slug}", limit=60, window_s=60)
    return captcha.make_challenge()


# ── Funnel tracking (anonymous): view → start → drop-off point ───────────────
class TrackRequest(BaseModel):
    visitor_id: str = Field(min_length=8, max_length=64)
    event: str = "view"  # view | progress
    question: Optional[str] = Field(default=None, max_length=200)


@router.post("/{slug}/track", status_code=204)
async def track_visit(
    slug: str,
    payload: TrackRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    await rate_limit(request, f"track:{slug}", limit=120, window_s=60)
    s = await _visible(slug, session)
    visit = (
        await session.scalars(
            select(SurveyVisit).where(
                SurveyVisit.survey_id == s.id, SurveyVisit.visitor_id == payload.visitor_id
            )
        )
    ).first()
    if visit is None:
        visit = SurveyVisit(survey_id=s.id, visitor_id=payload.visitor_id)
    if payload.event == "progress":
        visit.started = True
        if payload.question:
            visit.last_question = payload.question[:200]
    visit.last_seen_at = _utcnow()
    session.add(visit)
    try:
        await session.commit()
    except Exception:  # noqa: BLE001 — carrera del upsert: otro request lo creó
        await session.rollback()


# ── Intentos de examen: tiempo límite y sorteo controlados por el servidor ────
_ATTEMPT_PURPOSE = "exam_attempt"


class StartRequest(BaseModel):
    access_token: Optional[str] = None
    visitor_id: Optional[str] = Field(default=None, max_length=64)


async def _attempt_key(request: Request, s: Survey, access_token: Optional[str], visitor_id: Optional[str], session) -> str:
    """Quién rinde. Con identidad (invitado, alumno del LMS) el intento es suyo
    en cualquier dispositivo; sin identidad, del navegador."""
    k = await _draft_key(request, s, access_token, session)
    if k:
        return k
    if visitor_id:
        return f"v:{visitor_id}"
    import secrets

    return f"anon:{secrets.token_urlsafe(12)}"


@router.post("/{slug}/start")
async def start_attempt(slug: str, payload: StartRequest, request: Request, session: AsyncSession = Depends(get_session)):
    """Empieza (o retoma) el intento de examen: fija la hora de inicio, el
    plazo y las preguntas sorteadas, y devuelve el esquema que le toca a esta
    persona. Retomar devuelve el MISMO intento: recargar la página no reinicia
    el reloj ni cambia las preguntas."""
    from app import exam
    from app.models import SurveyAttempt

    await rate_limit(request, f"start:{slug}", limit=60, window_s=60)
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")
    if (getattr(s, "access_mode", "public") != "public" and not _lti_context(request, s)
            and not _valid_access(s, payload.access_token)):
        raise HTTPException(status_code=403, detail="Necesitás acceso para responder esta encuesta.")
    cfg = exam.settings(s.evaluation)
    if cfg is None:
        return {"exam": None}

    key = await _attempt_key(request, s, payload.access_token, payload.visitor_id, session)
    att = (
        await session.scalars(
            select(SurveyAttempt)
            .where(SurveyAttempt.survey_id == s.id, SurveyAttempt.key == key,
                   SurveyAttempt.submitted_at.is_(None))
            .order_by(SurveyAttempt.started_at.desc())
            .limit(1)
        )
    ).first()
    if att is None:
        previos = int(await session.scalar(
            select(func.count(SurveyAttempt.id)).where(SurveyAttempt.survey_id == s.id, SurveyAttempt.key == key)
        ) or 0)
        ahora = _utcnow()
        att = SurveyAttempt(
            survey_id=s.id, key=key, started_at=ahora,
            deadline=ahora + timedelta(seconds=cfg["timeLimitSec"]) if cfg["timeLimitSec"] else None,
            drawn=exam.draw(s.json_schema or {}, cfg["groups"], f"{s.id}:{key}:{previos}") if cfg["groups"] else None,
        )
        session.add(att)
        await session.commit()
        await session.refresh(att)

    def aware(d):
        return d if d is None or d.tzinfo else d.replace(tzinfo=timezone.utc)

    deadline = aware(att.deadline)
    restan = max(0, int((deadline - _utcnow()).total_seconds())) if deadline else None
    token = create_purpose_token(_ATTEMPT_PURPOSE, {"a": str(att.id), "s": str(s.id)}, ttl_hours=72)
    return {
        "exam": {
            "attempt_token": token,
            "started_at": aware(att.started_at).isoformat(),
            "deadline": deadline.isoformat() if deadline else None,
            "seconds_left": restan,
            "signals": cfg["signals"],
            "json_schema": exam.personal_schema(s.json_schema or {}, att.drawn, cfg),
        }
    }


# ── Borradores en el servidor (retomar desde otro dispositivo) ───────────────
_MAX_DRAFT_BYTES = 256 * 1024


class DraftRequest(BaseModel):
    answers: dict = Field(default_factory=dict)
    page: int = 0
    access_token: Optional[str] = None


async def _draft_key(request: Request, s: Survey, access_token: Optional[str], session) -> Optional[str]:
    """La identidad bajo la que se guarda el borrador, o None si no hay una.

    Sin identidad (encuesta pública anónima) no se guarda nada en el servidor:
    ver `SurveyDraft`. Un vínculo LTI anónimo tampoco: guardar por `sub` sería
    identificar a quien eligió no ser identificado."""
    lti = _lti_context(request, s)
    if lti:
        if not lti.get("sub") or lti.get("anonymous"):
            return None
        if lti.get("link_id"):
            link = await session.get(LtiResourceLink, uuid.UUID(lti["link_id"]))
            if link is None or link.anonymous:
                return None
        origen = lti.get("link_id") or lti.get("mod_site_id") or "lms"
        return f"lms:{origen}:{lti['sub']}"
    if getattr(s, "access_mode", "public") == "list" and _valid_access(s, access_token):
        data = read_purpose_token(_ACCESS_PURPOSE, access_token or "") or {}
        if data.get("code"):
            return f"inv:{data['code']}"
    return None


@router.get("/{slug}/draft")
async def get_draft(
    slug: str,
    request: Request,
    access_token: Optional[str] = None,
    session: AsyncSession = Depends(get_session),
):
    """El borrador de quien responde, si tiene identidad y dejó uno.
    `enabled: false` le dice al navegador que no hace falta mandar borradores."""
    from app.models import SurveyDraft

    await rate_limit(request, f"draft:{slug}", limit=120, window_s=60)
    s = await _visible(slug, session)
    key = await _draft_key(request, s, access_token, session)
    if key is None:
        return {"enabled": False}
    d = (
        await session.scalars(
            select(SurveyDraft).where(SurveyDraft.survey_id == s.id, SurveyDraft.key == key)
        )
    ).first()
    if d is None:
        return {"enabled": True, "draft": None}
    return {"enabled": True, "draft": {"answers": d.answers, "page": d.page,
                                       "updated_at": d.updated_at.isoformat()}}


@router.put("/{slug}/draft")
async def save_draft(
    slug: str,
    payload: DraftRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Guarda (o reemplaza) el borrador. Silencioso si no hay identidad."""
    import json as _json

    from app.models import SurveyDraft

    await rate_limit(request, f"draft:{slug}", limit=120, window_s=60)
    s = await _visible(slug, session)
    key = await _draft_key(request, s, payload.access_token, session)
    if key is None:
        return {"enabled": False}
    if len(_json.dumps(payload.answers, default=str)) > _MAX_DRAFT_BYTES:
        raise HTTPException(status_code=413, detail="El borrador es demasiado grande.")
    d = (
        await session.scalars(
            select(SurveyDraft).where(SurveyDraft.survey_id == s.id, SurveyDraft.key == key)
        )
    ).first()
    if d is None:
        d = SurveyDraft(survey_id=s.id, key=key)
    d.answers = payload.answers
    d.page = max(0, int(payload.page or 0))
    d.updated_at = _utcnow()
    session.add(d)
    try:
        await session.commit()
    except Exception:  # noqa: BLE001 — carrera del upsert: otro request lo creó
        await session.rollback()
    return {"enabled": True, "saved": True}


@router.post("/{slug}/access")
async def survey_access(
    slug: str,
    payload: SurveyAccessRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    # Frena fuerza bruta de PIN / códigos de invitado.
    await rate_limit(request, f"access:{slug}", limit=10, window_s=60)
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")

    mode = getattr(s, "access_mode", "public")
    token_data: dict = {"slug": s.slug, "mode": mode}

    if mode == "public":
        pass
    elif mode == "pin":
        if not s.access_pin or (payload.pin or "").strip() != s.access_pin:
            raise HTTPException(status_code=403, detail="Clave incorrecta")
    elif mode == "list":
        inv = await _find_invitee(session, s.id, payload.email or "", payload.code or "")
        if not inv:
            raise HTTPException(status_code=403, detail="Email o código inválido")
        if inv.used_at is None:
            inv.used_at = _utcnow()
            session.add(inv)
            await session.commit()
        token_data.update({"email": inv.email, "code": inv.code})
    else:
        raise HTTPException(status_code=400, detail="Modo de acceso desconocido")

    token = create_purpose_token(_ACCESS_PURPOSE, token_data, ttl_hours=12)
    return {"access_token": token, "survey": _public_payload(s, True, None, gated=False)}


@router.post("/{slug}/submit", status_code=201)
async def submit(
    slug: str,
    payload: SubmitResponseRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    # Anti-spam: tope de envíos por IP por encuesta.
    await rate_limit(request, f"submit:{slug}", limit=15, window_s=60)
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")

    # Anti-bot proof-of-work: required only on surveys that opt in.
    if bool(getattr(s, "require_captcha", False)) and get_settings().captcha_enabled:
        if not captcha.verify_solution(payload.captcha):
            raise HTTPException(
                status_code=400,
                detail="Verificación anti-bot inválida o vencida. Recargá y probá de nuevo.",
            )

    # Gated surveys require a valid access token; capture respondent identity.
    resp_email = resp_code = None
    lti = _lti_context(request, s)
    if lti:
        resp_email = lti.get("email")
    elif getattr(s, "access_mode", "public") != "public":
        if not _valid_access(s, payload.access_token):
            raise HTTPException(status_code=403, detail="Necesitás acceso para responder esta encuesta.")
        data = read_purpose_token(_ACCESS_PURPOSE, payload.access_token or "") or {}
        resp_email, resp_code = data.get("email"), data.get("code")

    # Un vínculo anónimo no guarda identidad: ni el sub de Moodle ni el email.
    # Se conserva `lti_link_id` para saber de qué actividad vino (hace falta
    # para el panel), pero eso no identifica a nadie.
    #
    # `anonymous` se lee acá FRESCO de la base, no del token `lti` (que lo
    # trae congelado desde el momento del lanzamiento y vive hasta
    # ACCESS_TTL_S -- 4 horas). Si el docente marca el vínculo como anónimo
    # después de que un alumno ya lanzó, ese alumno sigue con una cookie
    # vieja durante toda esa ventana; leer la fila de acá hace que esta mitad
    # del contrato (no guardar identidad) esté siempre de acuerdo con la otra
    # (no publicar nota, en `_deliver` de `app/lti/ags.py`, que también lee
    # `link.anonymous` de la base) -- sin depender de que el token esté al
    # día.
    #
    # Un lanzamiento de `mod_encuestum` (`/mod/launch`) siembra esta misma
    # cookie pero **sin** `link_id`: no hay `LtiResourceLink` que apuntar,
    # porque la actividad vive del lado de Moodle y Encuestum no la persiste.
    # Ahí el anonimato sale del propio token, que es la única copia de ese dato
    # que llega hasta acá. Leer `lti["link_id"]` a secas -- como hacía este
    # bloque antes de la Tarea 2 del módulo -- reventaba con un KeyError (500)
    # en el primer envío de un alumno lanzado desde el módulo nativo.
    #
    # Este bloque va ANTES del tope de intentos (y no después, donde estaba)
    # porque el tope necesita las dos cosas que resuelve: si la actividad es
    # anónima -- y entonces no hay a quién contarle intentos -- y de qué
    # plataforma vino el `sub`, que sin eso no distingue a dos alumnos de dos
    # Moodles distintos.
    anonimo = False
    link = None
    link_id = lti.get("link_id") if lti else None
    if link_id:
        link = await session.get(LtiResourceLink, uuid.UUID(link_id))
        anonimo = bool(link and link.anonymous)
    elif lti:
        anonimo = bool(lti.get("anonymous"))

    # De qué actividad del módulo nativo vino la respuesta. Sin esto la nota no
    # tiene a dónde volver: `mod_encuestum` no deja ninguna fila del lado de
    # Encuestum, así que el token del lanzamiento es la ÚNICA copia de ese dato
    # que llega hasta acá.
    #
    # Sólo cuando NO hay `link_id`: los dos orígenes son excluyentes y el CHECK
    # `ck_survey_responses_un_solo_origen` lo hace cumplir el motor. Una fila
    # con los dos haría que el despacho de la nota (`_deliver` en
    # `app/lti/ags.py`) tuviera un caso ambiguo.
    mod_site_id, mod_cmid, mod_grademax = (None, None, None)
    if lti and not link_id:
        mod_site_id = await _sitio_del_modulo(session, lti.get("mod_site_id"))
        if mod_site_id is not None:
            mod_cmid = _entero(lti.get("cmid"))
            mod_grademax = _flotante(lti.get("grademax"))

    # Tope de intentos POR PERSONA (distinto del cupo total de la encuesta).
    # Se comprueba acá, sobre la base, y no sólo del lado del cliente: es el
    # único punto que no se puede saltear. Cómo se reconoce a la persona y por
    # qué esto es "mejor esfuerzo" fuera del modo lista está en app/attempts.py.
    from app import attempts

    tope = attempts.limite(s)
    if tope is not None:
        _, mail_respondido = _identidad_respondida(s, payload.answers or {})
        # Quién es la persona según el LMS, con el origen que le da alcance al
        # `sub`. `None` si la respuesta no vino de un LMS: es lo que decide si
        # la marca del navegador cuenta o no. En una actividad anónima el `sub`
        # va en `None` -- igual que en la fila -- y el tope no aplica.
        lms = None
        if lti:
            lms = {
                "sub": None if anonimo else lti.get("sub"),
                "platform_id": link.platform_id if link else None,
                "site_id": mod_site_id,
            }
        ya = await attempts.usados(
            s,
            session,
            code=resp_code,
            visitor_id=(payload.meta or {}).get("visitor_id"),
            email=resp_email or mail_respondido,
            lms=lms,
        )
        if ya >= tope:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Ya respondiste esta encuesta."
                    if tope == 1
                    else f"Ya usaste tus {tope} intentos para esta encuesta."
                ),
            )

    # Examen: intento, plazo, preguntas sorteadas y senales de integridad.
    from app import exam as exam_mod
    from app.models import SurveyAttempt

    exam_cfg = exam_mod.settings(s.evaluation)
    intento = None
    if exam_cfg is not None:
        datos = read_purpose_token(_ATTEMPT_PURPOSE, payload.attempt_token or "") or {}
        if datos.get("s") == str(s.id):
            intento = await session.get(SurveyAttempt, uuid.UUID(datos["a"]))
        if intento is None and exam_cfg["groups"]:
            # Sin intento no se sabe qué preguntas le tocaron: corregir todo
            # sería ponerle 0 en las que nunca vio.
            raise HTTPException(status_code=409, detail="El examen no se inició bien. Recargá la página.")
        if intento is not None and intento.submitted_at is not None:
            raise HTTPException(status_code=409, detail="Ese intento ya se entregó.")

    # Trazabilidad: qué versión se contestó, metadatos que pone el SERVIDOR (el
    # navegador sólo aporta un puñado de claves acotadas) y la huella.
    from app.audit import ensure_survey_version, hash_ip, record_grade_revision, response_hash, sanitize_client_meta
    from app.ratelimit import _client_ip

    version = await ensure_survey_version(session, s, label="respuesta")
    meta = sanitize_client_meta(payload.meta)
    ajustes = get_settings()
    server_meta: dict = {
        "received_at": _utcnow().isoformat(),
        "user_agent": (request.headers.get("user-agent") or "")[:512] or None,
    }
    if ajustes.store_ip_hash:
        server_meta["ip_hash"] = hash_ip(_client_ip(request), ajustes.session_secret)
    if exam_cfg is not None:
        ahora = _utcnow()
        late = 0
        exam_seconds = None
        if intento is not None:
            ini = intento.started_at if intento.started_at.tzinfo else intento.started_at.replace(tzinfo=timezone.utc)
            exam_seconds = max(0, int((ahora - ini).total_seconds()))
            server_meta["exam_seconds"] = exam_seconds
            if intento.deadline is not None:
                dl = intento.deadline if intento.deadline.tzinfo else intento.deadline.replace(tzinfo=timezone.utc)
                late = max(0, int((ahora - dl).total_seconds()) - exam_mod.GRACE_S)
            if intento.drawn is not None:
                meta["drawn"] = list(intento.drawn)
        else:
            server_meta["no_attempt"] = True
        integridad = exam_mod.sanitize_integrity((payload.meta or {}).get("integrity")) if exam_cfg["signals"] else None
        if integridad:
            meta["integrity"] = integridad
        titulos = {el.get("name"): el.get("title") or el.get("name") for el in _elementos_publicos(s.json_schema)}
        senales = exam_mod.flags(integridad, exam_seconds=exam_seconds, late_seconds=late, titles=titulos)
        if senales:
            server_meta["flags"] = senales
    meta["server"] = server_meta

    r = SurveyResponse(
        survey_id=s.id, answers=payload.answers or {}, completed=payload.completed, meta=meta,
        survey_version_id=version.id,
        respondent_email=None if anonimo else resp_email, respondent_code=resp_code,
        lti_link_id=uuid.UUID(link_id) if link_id else None,
        lti_sub=None if anonimo else (lti.get("sub") if lti else None),
        mod_site_id=mod_site_id, mod_cmid=mod_cmid, mod_grademax=mod_grademax,
    )
    # Enviada: el borrador (si lo había) ya no tiene razón de existir.
    clave_borrador = await _draft_key(request, s, payload.access_token, session)
    if clave_borrador is not None:
        from app.models import SurveyDraft

        await session.execute(
            sa_delete(SurveyDraft).where(SurveyDraft.survey_id == s.id, SurveyDraft.key == clave_borrador)
        )

    r.id = r.id or uuid.uuid4()
    r.submitted_at = _utcnow()
    r.integrity_hash = response_hash(r)
    session.add(r)
    if intento is not None:
        intento.submitted_at = r.submitted_at
        intento.response_id = r.id
        session.add(intento)

    # Funnel: si el cliente mandó su visitor_id, cerramos su visita como completa.
    visitor_id = meta.get("visitor_id")
    if isinstance(visitor_id, str) and visitor_id:
        visit = (
            await session.scalars(
                select(SurveyVisit).where(
                    SurveyVisit.survey_id == s.id, SurveyVisit.visitor_id == visitor_id
                )
            )
        ).first()
        if visit is None:
            visit = SurveyVisit(survey_id=s.id, visitor_id=visitor_id)
        visit.started = True
        visit.completed = True
        visit.last_seen_at = _utcnow()
        session.add(visit)
        # Duración aproximada: desde que abrió la encuesta por primera vez
        # hasta que la envió. Incluye lo que tardó en empezar.
        if visit.created_at is not None:
            abierta = visit.created_at if visit.created_at.tzinfo else visit.created_at.replace(tzinfo=timezone.utc)
            server_meta["seconds_since_first_view"] = max(0, int((r.submitted_at - abierta).total_seconds()))
            r.meta = {**meta, "server": dict(server_meta)}

    await session.commit()

    evaluation = s.evaluation or {}
    grade = None
    if evaluation.get("enabled"):
        try:
            from app.ai_config import resolve_provider
            from app.ai_usage import track_ai_call
            provider = await resolve_provider(session, s.org_id)
            async with track_ai_call(session, provider, s.org_id, "grade", s.id, response_id=r.id):
                grade = await grade_response(
                    # Sólo las preguntas que le tocaron (sorteo de examen).
                    evaluation=exam_mod.evaluation_for(evaluation, s.json_schema or {}, meta.get("drawn")),
                    answers=r.answers,
                    question_types=extract_question_types(s.json_schema),
                    question_choices=extract_question_choices(s.json_schema),
                    language=s.language or "es",
                )
            grade["graded_with_version"] = version.number
            r.grade = grade
            r.score = grade.get("total")
            r.max_score = grade.get("max")
            r.needs_review = bool(grade.get("needs_review"))
            r.graded_at = _utcnow()
            session.add(r)
            record_grade_revision(
                session, r, source="submit", grade_before=None, survey_version_id=version.id
            )
            await session.commit()
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("grading failed for %s: %s", r.id, exc)
            r.needs_review = True
            session.add(r)
            # La respuesta ya está guardada; la corrección se reintenta sola en
            # segundo plano (un proveedor de IA caído un minuto no puede dejar
            # la nota pendiente para siempre).
            from app import jobs

            jobs.enqueue(
                session, "grade.response", {"response_id": str(r.id)},
                org_id=s.org_id, survey_id=s.id, response_id=r.id,
                dedupe_key=f"grade.response:{r.id}", delay=timedelta(minutes=1),
            )
            await session.commit()
            grade = None

    # Todo lo que sale de acá se ENCOLA en una sola transacción (ver
    # app/jobs.py): webhooks con el estado final (ya corregido), la nota al LMS
    # y los avisos por email. Nada de esto bloquea a quien respondió, y nada se
    # pierde si el proceso se reinicia antes de enviarlo.
    schedule_response_delivery(s.id, r.id, session=session)
    # Si vino de un LMS y quedó una nota, se la devolvemos al libro de calificaciones.
    if lti and r.score is not None:
        from app.lti.ags import schedule_score

        schedule_score(r.id, session=session, survey_id=s.id, org_id=s.org_id)
    if getattr(s, "notify_emails", None):
        from app.notify import schedule_response_notification
        schedule_response_notification(
            s.notify_emails, s.title, s.id, await _response_count(s.id, session), session=session
        )
    await session.commit()

    if grade is None:
        return {"id": str(r.id), "status": "recorded"}

    # Whether the respondent sees their correction now depends on results_mode.
    results_mode = getattr(s, "results_mode", "immediate")
    if results_mode == "immediate":
        return {"id": str(r.id), "status": "graded",
                "result": _respondent_view(
                    grade, evaluation, s.json_schema or {}, r.answers,
                    cerrada=await _ya_cerro(s, session),
                )}
    if results_mode == "on_release":
        return {"id": str(r.id), "status": "recorded", "results_pending": True,
                "can_check": getattr(s, "access_mode", "public") == "list"}
    # never
    return {"id": str(r.id), "status": "recorded"}


@router.post("/{slug}/result")
async def lookup_result(
    slug: str,
    payload: ResultLookupRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """A respondent (email-list access) comes back with their code to see their
    correction — once the owner has released results (or immediately)."""
    await rate_limit(request, f"result:{slug}", limit=10, window_s=300)
    s = await _visible(slug, session)
    if getattr(s, "access_mode", "public") != "list":
        raise HTTPException(status_code=404, detail="Esta encuesta no permite consultar resultados")
    inv = await _find_invitee(session, s.id, payload.email, payload.code)
    if not inv:
        raise HTTPException(status_code=403, detail="Email o código inválido")

    results_mode = getattr(s, "results_mode", "immediate")
    if results_mode == "never":
        raise HTTPException(status_code=403, detail="Los resultados no están disponibles.")
    if results_mode == "on_release" and not getattr(s, "results_released", False):
        return {"status": "pending", "detail": "Los resultados todavía no fueron publicados."}

    r = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == s.id, SurveyResponse.respondent_code == inv.code)
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).first()
    if not r:
        raise HTTPException(status_code=404, detail="No encontramos tu respuesta")
    if not r.grade:
        return {"status": "pending", "detail": "Tu respuesta todavía no fue corregida."}
    from app.models import GradeAppeal

    reclamos = (await session.scalars(
        select(GradeAppeal).where(GradeAppeal.response_id == r.id).order_by(GradeAppeal.created_at)
    )).all()
    return {
        "status": "graded",
        "result": _respondent_view(
            r.grade, s.evaluation or {}, s.json_schema or {}, r.answers,
            cerrada=await _ya_cerro(s, session),
        ),
        # Reclamos de esta persona: estado y respuesta del docente.
        "appeals": [
            {"question": a.question, "status": a.status, "reply": a.reply,
             "created_at": a.created_at.isoformat()}
            for a in reclamos
        ],
    }


class AppealRequest(BaseModel):
    email: str = Field(max_length=320)
    code: str = Field(max_length=64)
    question: str = Field(max_length=200)
    message: str = Field(min_length=5, max_length=2000)


@router.post("/{slug}/appeal", status_code=201)
async def create_appeal(slug: str, payload: AppealRequest, request: Request, session: AsyncSession = Depends(get_session)):
    """Un alumno (con su email y código) pide que se revise la corrección de
    una pregunta. Uno abierto por pregunta; el docente recibe un aviso."""
    from app.audit import record_event
    from app.models import GradeAppeal

    await rate_limit(request, f"appeal:{slug}", limit=10, window_s=600)
    s = await _visible(slug, session)
    if getattr(s, "access_mode", "public") != "list":
        raise HTTPException(status_code=404, detail="Esta encuesta no admite reclamos")
    inv = await _find_invitee(session, s.id, payload.email, payload.code)
    if not inv:
        raise HTTPException(status_code=403, detail="Email o código inválido")
    modo = getattr(s, "results_mode", "immediate")
    if modo == "never" or (modo == "on_release" and not getattr(s, "results_released", False)):
        raise HTTPException(status_code=403, detail="Los resultados todavía no están disponibles.")
    r = (await session.scalars(
        select(SurveyResponse)
        .where(SurveyResponse.survey_id == s.id, SurveyResponse.respondent_code == inv.code)
        .order_by(SurveyResponse.submitted_at.desc())
    )).first()
    if not r or not r.grade:
        raise HTTPException(status_code=404, detail="No encontramos tu respuesta corregida")
    pregunta = next((q for q in (r.grade.get("questions") or []) if q.get("name") == payload.question), None)
    if pregunta is None:
        raise HTTPException(status_code=422, detail="Esa pregunta no está en tu corrección")
    abierto = await session.scalar(select(GradeAppeal.id).where(
        GradeAppeal.response_id == r.id, GradeAppeal.question == payload.question, GradeAppeal.status == "open"))
    if abierto:
        raise HTTPException(status_code=409, detail="Ya hay un reclamo abierto sobre esa pregunta.")
    a = GradeAppeal(survey_id=s.id, response_id=r.id, question=payload.question,
                    message=payload.message.strip(), award_before=pregunta.get("awarded"))
    session.add(a)
    record_event(session, action="appeal.created", org_id=s.org_id, survey_id=s.id, response_id=r.id,
                 detail={"question": payload.question, "by": inv.email})
    if getattr(s, "notify_emails", None):
        from app.email import build_url
        from app.notify import parse_emails
        from app import jobs

        for dest in parse_emails(s.notify_emails):
            jobs.enqueue(session, "email.send", {
                "to": dest, "subject": f"Reclamo de nota: {s.title or 'examen'}",
                "text": f"{inv.email} pidió revisar «{pregunta.get('title') or payload.question}».\n\n"
                        f"«{payload.message.strip()}»\n\nRespondelo acá:\n{build_url(f'/surveys/{s.id}')}\n",
            }, org_id=s.org_id, survey_id=s.id)
    await session.commit()
    return {"id": str(a.id), "status": a.status}


@router.post("/{slug}/certificate")
async def certificate(
    slug: str,
    payload: ResultLookupRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Certificate data for a respondent who passed an assessment (email-list
    access). The frontend renders a printable certificate from this."""
    await rate_limit(request, f"cert:{slug}", limit=10, window_s=300)
    from app.models import Organization
    s = await _visible(slug, session)
    if getattr(s, "access_mode", "public") != "list":
        raise HTTPException(status_code=404, detail="No disponible")
    if not (s.evaluation or {}).get("enabled"):
        raise HTTPException(status_code=404, detail="Esta encuesta no es una evaluación")
    inv = await _find_invitee(session, s.id, payload.email, payload.code)
    if not inv:
        raise HTTPException(status_code=403, detail="Email o código inválido")
    if getattr(s, "results_mode", "immediate") == "on_release" and not getattr(s, "results_released", False):
        raise HTTPException(status_code=403, detail="Los resultados todavía no fueron publicados.")

    r = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == s.id, SurveyResponse.respondent_code == inv.code)
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).first()
    if not r or not r.grade:
        raise HTTPException(status_code=404, detail="Todavía no tenés una respuesta corregida")

    passing = float((s.evaluation or {}).get("passingScore", 60) or 60)
    pct = float((r.grade or {}).get("percent", 0) or 0)
    if pct < passing:
        raise HTTPException(status_code=403, detail="El certificado se emite solo al aprobar.")

    org = await session.get(Organization, s.org_id)
    return {
        "name": inv.name or inv.email,
        "survey_title": s.title or "Evaluación",
        "org_name": org.name if org else "",
        "percent": round(pct, 1),
        "passing_score": passing,
        "date": r.submitted_at.date().isoformat(),
        "code": inv.code,
    }


@router.post("/{slug}/grade-question")
async def grade_question(
    slug: str,
    payload: GradeQuestionRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    # Anti-abuso: la corrección en vivo puede disparar LLM. Límite por IP y, en
    # encuestas gated, exigir el token de acceso (evita enumerar respuestas
    # correctas o quemar la API key de la organización de forma anónima).
    await rate_limit(request, f"gradeq:{slug}", limit=40, window_s=60)
    s = await _visible(slug, session)
    if getattr(s, "access_mode", "public") != "public" and not _valid_access(s, payload.access_token):
        raise HTTPException(status_code=403, detail="Necesitás acceso para esta encuesta.")
    evaluation = s.evaluation or {}
    if not evaluation.get("enabled") or evaluation.get("feedbackTiming") != "immediate":
        raise HTTPException(status_code=404, detail="Immediate feedback not enabled")
    qcfg = (evaluation.get("questions") or {}).get(payload.name)
    if not qcfg or not qcfg.get("gradable"):
        raise HTTPException(status_code=404, detail="Question not gradable")

    points = float(qcfg.get("points", 1) or 0)
    qtype = extract_question_types(s.json_schema).get(payload.name, "text")
    try:
        if qcfg.get("grader", "auto") == "llm":
            from app.llm_calls import grade_open_answer
            ans = payload.answer
            student = ", ".join(str(a) for a in ans) if isinstance(ans, list) else ("" if ans is None else str(ans))
            raw = await grade_open_answer(
                language=s.language or "es", question_title=qcfg.get("title", payload.name),
                model_answer=qcfg.get("modelAnswer", ""), key_concepts=qcfg.get("keyConcepts", []),
                rubric=qcfg.get("rubric", []), max_points=points, student_answer=student,
            )
            awarded = max(0.0, min(points, float(raw.get("score", 0) or 0)))
            return {"name": payload.name, "verdict": raw.get("verdict"), "awarded": round(awarded, 3),
                    "points": points, "feedback": raw.get("feedback", "")}
        res = grade_deterministic(
            qcfg, qtype, payload.answer,
            extract_question_choices(s.json_schema).get(payload.name),
        )
        return {"name": payload.name, "verdict": res.get("verdict"), "awarded": res.get("awarded"),
                "points": points, "feedback": res.get("feedback", "")}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("live grade failed: %s", exc)
        raise HTTPException(status_code=502, detail="No se pudo corregir ahora")


def _elementos_publicos(schema: dict) -> list[dict]:
    return [
        el
        for p in (schema or {}).get("pages", []) or []
        if isinstance(p, dict)
        for el in p.get("elements", []) or []
        if isinstance(el, dict)
    ]
