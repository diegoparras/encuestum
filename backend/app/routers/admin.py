import asyncio
import logging
import re
import uuid
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from pydantic import BaseModel, EmailStr, Field

from app.db import get_session
from app.deps import OrgContext, current_context
from app.exporting import CSV_MEDIA, XLSX_MEDIA, export_rows, rows_to_csv, sheets_to_xlsx
from app.audit import record_event
from app.hygiene import counted_only
from app.models import Survey, SurveyInvitee, SurveyResponse, _utcnow
from app.schemas import (
    VALID_STATUSES, ResponseItem, SurveyCreateRequest, SurveyDetail,
    SurveySummary, SurveyUpdateRequest,
)

router = APIRouter(prefix="/surveys", tags=["surveys"])

LOGGER = logging.getLogger(__name__)


def _normalize_slug(raw: str) -> str:
    """Link personalizado: minúsculas, letras/números/guiones, sin guiones al borde."""
    return re.sub(r"[^a-z0-9]+", "-", (raw or "").strip().lower()).strip("-")


async def _survey_or_404(
    sid: uuid.UUID, org_id: uuid.UUID, session: AsyncSession, *, include_deleted: bool = False
) -> Survey:
    """Una encuesta en la papelera es 404 para todo el resto de la app: no se
    edita, no se publica, no se exporta. Solo los endpoints de la papelera
    (restaurar / purgar) pasan include_deleted=True."""
    s = await session.get(Survey, sid)
    if not s or s.org_id != org_id:
        raise HTTPException(status_code=404, detail="Survey not found")
    if s.deleted_at is not None and not include_deleted:
        raise HTTPException(status_code=404, detail="Survey not found")
    return s


def _require_admin(ctx: OrgContext) -> None:
    """Operaciones destructivas / de exportación de PII: solo admin u owner."""
    from app.models import ROLE_ADMIN, ROLE_RANK

    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Requiere rol admin en la organización")


@router.post("", response_model=SurveyDetail)
async def create_survey(
    payload: SurveyCreateRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = Survey(
        org_id=ctx.org.id, created_by=ctx.user.id,
        title=payload.title, json_schema=payload.json_schema or {},
        language=payload.language, theme=payload.theme, evaluation=payload.evaluation,
    )
    session.add(s)
    await session.flush()
    record_event(session, action="survey.created", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id,
                 detail={"title": s.title})
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.get("", response_model=List[SurveySummary])
async def list_surveys(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    surveys = (
        await session.scalars(
            select(Survey)
            .where(Survey.org_id == ctx.org.id, Survey.deleted_at.is_(None))
            .order_by(Survey.updated_at.desc())
        )
    ).all()
    ids = [s.id for s in surveys]
    counts: dict = {}
    if ids:
        rows = (
            await session.execute(
                counted_only(select(SurveyResponse.survey_id, func.count(SurveyResponse.id)))
                .where(SurveyResponse.survey_id.in_(ids))
                .group_by(SurveyResponse.survey_id)
            )
        ).all()
        counts = {r[0]: r[1] for r in rows}
    return [
        SurveySummary(
            id=s.id, title=s.title, slug=s.slug, status=s.status, language=s.language,
            response_count=counts.get(s.id, 0),
            is_evaluation=bool(s.evaluation and s.evaluation.get("enabled")),
            created_at=s.created_at, updated_at=s.updated_at, folder_id=s.folder_id,
        )
        for s in surveys
    ]


@router.get("/{sid}", response_model=SurveyDetail)
async def get_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    return SurveyDetail.from_model(await _survey_or_404(sid, ctx.org.id, session))


@router.put("/{sid}", response_model=SurveyDetail)
async def update_survey(
    sid: uuid.UUID,
    payload: SurveyUpdateRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = await _survey_or_404(sid, ctx.org.id, session)
    if payload.status is not None and payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status. Expected {sorted(VALID_STATUSES)}")
    if payload.access_mode is not None and payload.access_mode not in {"public", "pin", "list"}:
        raise HTTPException(status_code=400, detail="access_mode inválido (public|pin|list)")
    if payload.results_mode is not None and payload.results_mode not in {"immediate", "on_release", "never"}:
        raise HTTPException(status_code=400, detail="results_mode inválido (immediate|on_release|never)")
    if payload.redirect_url:
        u = payload.redirect_url.strip()
        if not (u.startswith("http://") or u.startswith("https://")):
            raise HTTPException(status_code=400, detail="La URL de redirección debe empezar con http:// o https://")
    if payload.access_mode == "pin" and payload.access_pin is not None and len(payload.access_pin.strip()) < 4:
        raise HTTPException(status_code=400, detail="La clave (PIN) debe tener al menos 4 caracteres")

    # Link personalizado (slug): normalizar, validar longitud y unicidad global.
    if payload.slug is not None:
        norm = _normalize_slug(payload.slug)
        if not (3 <= len(norm) <= 64):
            raise HTTPException(
                status_code=400,
                detail="El link debe tener entre 3 y 64 caracteres (letras, números y guiones).",
            )
        if norm != s.slug:
            taken = await session.scalar(
                select(Survey.id).where(Survey.slug == norm, Survey.id != s.id)
            )
            if taken:
                raise HTTPException(status_code=409, detail="Ese link ya está en uso por otra encuesta.")
            s.slug = norm

    data = payload.model_dump(exclude_unset=True)
    # Control de concurrencia optimista. Antes ganaba el último que guardaba:
    # dos pestañas (o dos docentes) con el autosave prendido se pisaban sin
    # aviso. Sólo se controla cuando el pedido trae contenido editable, así que
    # cambiar el link o el acceso desde otra pantalla no bloquea al editor.
    base = data.pop("base_content_hash", None)
    snapshot = bool(data.pop("snapshot", None))
    toca_contenido = bool({"json_schema", "evaluation", "theme", "title"} & set(data))
    if base and toca_contenido:
        from app.audit import survey_content_hash

        actual = survey_content_hash(s)
        if base != actual:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "survey_conflict",
                    "message": "Otra pestaña u otra persona cambió esta encuesta mientras la "
                               "editabas. Recargá para ver la última versión.",
                    "content_hash": actual,
                    "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                },
            )
    # Privacidad y recordatorios: validados antes del loop genérico.
    if "retention_days" in data or "retention_action" in data:
        from app.privacy import clean_retention

        try:
            d, a = clean_retention(
                data.get("retention_days", s.retention_days),
                data.get("retention_action", s.retention_action),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        data["retention_days"], data["retention_action"] = d, a
    if "reminders" in data:
        from app.distribution import clean_reminders

        try:
            data["reminders"] = clean_reminders(data["reminders"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    if data.get("anonymous") is None:
        data.pop("anonymous", None)
    # org_id / created_by / slug are handled explicitly, never via the generic loop.
    data.pop("org_id", None)
    data.pop("created_by", None)
    data.pop("slug", None)
    cambios = sorted(f for f, v in data.items() if getattr(s, f, None) != v)
    for field, value in data.items():
        setattr(s, field, value)

    # Coherencia de fechas: la apertura no puede ser posterior o igual al cierre.
    if s.opens_at is not None and s.closes_at is not None:
        opens = s.opens_at if s.opens_at.tzinfo else s.opens_at.replace(tzinfo=timezone.utc)
        closes = s.closes_at if s.closes_at.tzinfo else s.closes_at.replace(tzinfo=timezone.utc)
        if opens >= closes:
            raise HTTPException(
                status_code=400,
                detail="La fecha de inicio debe ser anterior a la de cierre.",
            )

    if cambios:
        # Sólo QUÉ cambió, no el contenido: el contenido que alguien contestó
        # queda congelado en `survey_versions`. `access_pin` se nombra pero
        # nunca se copia al registro.
        detail: dict = {"fields": cambios}
        if "status" in cambios:
            detail["status"] = s.status
        record_event(session, action="survey.updated", org_id=ctx.org.id, actor=ctx.user,
                     survey_id=s.id, detail=detail)
    if {"json_schema", "evaluation"} & set(cambios):
        await _snapshot_editor(session, s, ctx, manual=snapshot)
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


_AUTOSNAPSHOT_EVERY_S = 15 * 60


async def _snapshot_editor(session, s, ctx, *, manual: bool) -> None:
    """Versión para el historial del editor. Con guardado manual, siempre (si
    el contenido es nuevo); con autoguardado, sólo si la última versión tiene
    más de 15 minutos: el historial no se llena de cada tecla."""
    from app.audit import ensure_survey_version
    from app.models import SurveyVersion

    if not manual:
        ultima = await session.scalar(
            select(SurveyVersion.created_at)
            .where(SurveyVersion.survey_id == s.id)
            .order_by(SurveyVersion.created_at.desc())
            .limit(1)
        )
        if ultima is not None:
            ultima = ultima if ultima.tzinfo else ultima.replace(tzinfo=timezone.utc)
            if (datetime.now(timezone.utc) - ultima).total_seconds() < _AUTOSNAPSHOT_EVERY_S:
                return
    await ensure_survey_version(session, s, label="guardado" if manual else "autoguardado", actor=ctx.user)


def _resumen_version(schema: dict) -> int:
    from app.summarizing import count_questions

    return count_questions(schema or {})


@router.get("/{sid}/versions")
async def list_versions(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Historial de versiones (estructura + corrección), la más nueva primero,
    con cuántas respuestas se dieron sobre cada una."""
    from app.models import SurveyVersion

    await _survey_or_404(sid, ctx.org.id, session)
    versiones = (
        await session.scalars(
            select(SurveyVersion).where(SurveyVersion.survey_id == sid).order_by(SurveyVersion.number.desc())
        )
    ).all()
    conteo = dict(
        (
            await session.execute(
                select(SurveyResponse.survey_version_id, func.count(SurveyResponse.id))
                .where(SurveyResponse.survey_id == sid)
                .group_by(SurveyResponse.survey_version_id)
            )
        ).all()
    )
    return [
        {
            "id": str(v.id),
            "number": v.number,
            "label": v.label,
            "created_by_email": v.created_by_email,
            "created_at": v.created_at.isoformat(),
            "questions": _resumen_version(v.json_schema),
            "responses": int(conteo.get(v.id, 0)),
        }
        for v in versiones
    ]


@router.get("/{sid}/versions/{vid}")
async def get_version(
    sid: uuid.UUID,
    vid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    from app.models import SurveyVersion

    await _survey_or_404(sid, ctx.org.id, session)
    v = await session.get(SurveyVersion, vid)
    if v is None or v.survey_id != sid:
        raise HTTPException(status_code=404, detail="Versión no encontrada")
    return {"id": str(v.id), "number": v.number, "label": v.label, "json_schema": v.json_schema,
            "evaluation": v.evaluation, "created_at": v.created_at.isoformat()}


@router.post("/{sid}/versions/{vid}/restore", response_model=SurveyDetail)
async def restore_version(
    sid: uuid.UUID,
    vid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Vuelve las preguntas y la corrección a las de una versión anterior. Lo
    que había antes queda guardado como versión, así que restaurar también se
    puede deshacer. Título, diseño y configuración no cambian."""
    import copy

    from app.audit import ensure_survey_version
    from app.models import SurveyVersion

    s = await _survey_or_404(sid, ctx.org.id, session)
    v = await session.get(SurveyVersion, vid)
    if v is None or v.survey_id != sid:
        raise HTTPException(status_code=404, detail="Versión no encontrada")
    antes = await ensure_survey_version(session, s, label="antes de restaurar", actor=ctx.user)
    s.json_schema = copy.deepcopy(v.json_schema or {})
    s.evaluation = copy.deepcopy(v.evaluation) if v.evaluation else None
    session.add(s)
    record_event(session, action="survey.version_restored", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=sid, detail={"restored": v.number, "previous": antes.number})
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.post("/{sid}/duplicate", response_model=SurveyDetail)
async def duplicate_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = await _survey_or_404(sid, ctx.org.id, session)
    copy = Survey(
        org_id=ctx.org.id, created_by=ctx.user.id,
        title=f"{s.title or 'Encuesta'} (copia)",
        json_schema=s.json_schema or {}, language=s.language,
        theme=s.theme, evaluation=s.evaluation,
        closes_at=s.closes_at, max_responses=s.max_responses,
        access_mode=s.access_mode, access_pin=s.access_pin,
        results_mode=s.results_mode, notify_emails=s.notify_emails,
        require_captcha=getattr(s, "require_captcha", False),
        anonymous=bool(getattr(s, "anonymous", False)),
        retention_days=s.retention_days, retention_action=s.retention_action,
        reminders=s.reminders,
        status="draft",  # copies start unpublished
    )
    session.add(copy)
    await session.flush()
    record_event(session, action="survey.duplicated", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=copy.id, detail={"from": str(s.id)})
    await session.commit()
    await session.refresh(copy)
    return SurveyDetail.from_model(copy)


@router.post("/{sid}/publish", response_model=SurveyDetail)
async def publish_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = await _survey_or_404(sid, ctx.org.id, session)
    s.status = "published"
    from app.audit import ensure_survey_version

    await ensure_survey_version(session, s, label="publicada", actor=ctx.user)
    session.add(s)
    record_event(session, action="survey.published", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.post("/{sid}/close", response_model=SurveyDetail)
async def close_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = await _survey_or_404(sid, ctx.org.id, session)
    s.status = "closed"
    session.add(s)
    record_event(session, action="survey.closed", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.delete("/{sid}", status_code=204)
async def delete_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Manda la encuesta a la papelera (soft-delete). No destruye nada: las
    respuestas se conservan y la encuesta se puede restaurar. Deja de listarse,
    de editarse y de responderse públicamente de inmediato."""
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session)
    s.deleted_at = datetime.now(timezone.utc)
    session.add(s)
    record_event(session, action="survey.trashed", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id)
    await session.commit()


@router.get("/trash/list", response_model=List[SurveySummary])
async def list_trash(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Encuestas en la papelera, las más recientemente borradas primero."""
    _require_admin(ctx)
    surveys = (
        await session.scalars(
            select(Survey)
            .where(Survey.org_id == ctx.org.id, Survey.deleted_at.is_not(None))
            .order_by(Survey.deleted_at.desc())
        )
    ).all()
    ids = [s.id for s in surveys]
    counts: dict = {}
    if ids:
        rows = (
            await session.execute(
                counted_only(select(SurveyResponse.survey_id, func.count(SurveyResponse.id)))
                .where(SurveyResponse.survey_id.in_(ids))
                .group_by(SurveyResponse.survey_id)
            )
        ).all()
        counts = {r[0]: r[1] for r in rows}
    return [
        SurveySummary(
            id=s.id, title=s.title, slug=s.slug, status=s.status, language=s.language,
            response_count=counts.get(s.id, 0),
            is_evaluation=bool(s.evaluation and s.evaluation.get("enabled")),
            created_at=s.created_at, updated_at=s.updated_at, folder_id=s.folder_id, deleted_at=s.deleted_at,
        )
        for s in surveys
    ]


@router.post("/{sid}/restore", response_model=SurveyDetail)
async def restore_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Saca la encuesta de la papelera. Vuelve con su estado y su link intactos."""
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session, include_deleted=True)
    s.deleted_at = None
    session.add(s)
    record_event(session, action="survey.restored", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.delete("/{sid}/purge", status_code=204)
async def purge_survey(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Borrado definitivo, irreversible: destruye la encuesta y sus respuestas.
    Solo se permite sobre encuestas que YA están en la papelera, para que nunca
    se pierdan datos con un solo click."""
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session, include_deleted=True)
    if s.deleted_at is None:
        raise HTTPException(
            status_code=409, detail="La encuesta debe estar en la papelera para borrarse del todo"
        )
    # Rastro ANTES de destruir: el `delete()` masivo no deja nada y la cascada
    # se lleva también `response_deletions`. `audit_events` no tiene FK a la
    # encuesta justamente para sobrevivir a esto.
    ids = (
        await session.scalars(select(SurveyResponse.id).where(SurveyResponse.survey_id == sid))
    ).all()
    record_event(
        session, action="survey.purged", org_id=ctx.org.id, actor=ctx.user, survey_id=sid,
        detail={"title": s.title, "responses_deleted": len(ids),
                "response_ids": [str(i) for i in ids[:5000]]},
    )
    await session.execute(delete(SurveyResponse).where(SurveyResponse.survey_id == sid))
    await session.delete(s)
    await session.commit()


@router.get("/{sid}/responses", response_model=List[ResponseItem])
async def list_responses(
    sid: uuid.UUID,
    response: Response,
    limit: Optional[int] = Query(None, ge=1, le=1000, description="Tamaño de página; sin él, todas"),
    offset: int = Query(0, ge=0),
    filter: str = Query("all", pattern="^(all|counted|needs_review|excluded|graded|ungraded)$"),
    q: Optional[str] = Query(None, max_length=200, description="Busca en el email o código de quien respondió"),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Respuestas de la encuesta, las más nuevas primero.

    Paginada con `limit`/`offset` (el total va en el header `X-Total-Count`),
    filtrable del lado del servidor. Sin `limit` devuelve todas, como antes:
    los llamadores viejos siguen funcionando, pero una encuesta con miles de
    respuestas tiene que pedirlas de a páginas."""
    from sqlalchemy import or_

    await _survey_or_404(sid, ctx.org.id, session)
    cond = [SurveyResponse.survey_id == sid]
    if filter == "needs_review":
        cond.append(SurveyResponse.needs_review == True)  # noqa: E712
    elif filter == "excluded":
        cond.append(or_(SurveyResponse.excluded == True, SurveyResponse.is_test == True))  # noqa: E712
    elif filter == "graded":
        cond.append(SurveyResponse.graded_at.is_not(None))
    elif filter == "ungraded":
        cond.append(SurveyResponse.graded_at.is_(None))
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        cond.append(or_(func.lower(SurveyResponse.respondent_email).like(like),
                        func.lower(SurveyResponse.respondent_code).like(like)))
    base = select(SurveyResponse).where(*cond)
    if filter == "counted":
        base = counted_only(base)
    total = int(await session.scalar(select(func.count()).select_from(base.subquery())) or 0)
    response.headers["X-Total-Count"] = str(total)
    stmt = base.order_by(SurveyResponse.submitted_at.desc(), SurveyResponse.id)
    if limit is not None:
        stmt = stmt.offset(offset).limit(limit)
    responses = (await session.scalars(stmt)).all()
    return [ResponseItem.from_model(r) for r in responses]


@router.get("/{sid}/responses/{rid}", response_model=ResponseItem)
async def get_response(
    sid: uuid.UUID,
    rid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    await _survey_or_404(sid, ctx.org.id, session)
    r = await session.get(SurveyResponse, rid)
    if not r or r.survey_id != sid:
        raise HTTPException(status_code=404, detail="Response not found")
    return ResponseItem.from_model(r)


@router.get("/{sid}/funnel")
async def funnel(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Embudo: vistas → comenzaron → completaron, con el punto de abandono por
    pregunta (última pregunta vista por quienes no terminaron)."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    return await _funnel_data(sid, s, session)


async def _funnel_data(sid: uuid.UUID, s, session: AsyncSession) -> dict:
    """Cálculo del embudo, reutilizable (endpoint /funnel + informe ejecutivo)."""
    from app.models import SurveyVisit
    views = int(
        await session.scalar(
            select(func.count(SurveyVisit.id)).where(SurveyVisit.survey_id == sid)
        )
        or 0
    )
    starts = int(
        await session.scalar(
            select(func.count(SurveyVisit.id)).where(
                SurveyVisit.survey_id == sid, SurveyVisit.started == True  # noqa: E712
            )
        )
        or 0
    )
    completions = int(
        await session.scalar(
            select(func.count(SurveyVisit.id)).where(
                SurveyVisit.survey_id == sid, SurveyVisit.completed == True  # noqa: E712
            )
        )
        or 0
    )

    # Abandonos: última pregunta vista de las visitas que empezaron y no terminaron.
    dropoff_rows = (
        await session.execute(
            select(SurveyVisit.last_question, func.count())
            .where(
                SurveyVisit.survey_id == sid,
                SurveyVisit.started == True,  # noqa: E712
                SurveyVisit.completed == False,  # noqa: E712
                SurveyVisit.last_question.isnot(None),
            )
            .group_by(SurveyVisit.last_question)
        )
    ).all()
    dropoff: dict[str, int] = {q: n for q, n in dropoff_rows}

    # Títulos para mostrar (nombre → título).
    titles: dict[str, str] = {}
    for page in (s.json_schema or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            if el.get("name"):
                titles[el["name"]] = el.get("title") or el["name"]

    responses = int(
        await session.scalar(
            counted_only(select(func.count(SurveyResponse.id)).where(SurveyResponse.survey_id == sid))
        )
        or 0
    )
    # Personas identificadas (invitados, alumnos desde Moodle) con una
    # respuesta a medio hacer guardada: empezaron y todavía pueden terminar.
    from app.models import SurveyDraft

    in_progress = int(
        await session.scalar(select(func.count(SurveyDraft.id)).where(SurveyDraft.survey_id == sid))
        or 0
    )
    # Tiempo de completado y dispositivo, de los metadatos que pone el
    # servidor al recibir (respuestas desde la 0026 en adelante).
    from app.quality import completion_seconds, device_of

    recibidas = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
        )
    ).all()
    dispositivos: dict[str, int] = {}
    for r in recibidas:
        d = device_of(r)
        if d:
            dispositivos[d] = dispositivos.get(d, 0) + 1
    return {
        "in_progress": in_progress,
        "completion_seconds": completion_seconds(recibidas),
        "devices": dispositivos,
        "views": views,
        "starts": starts,
        "completions": completions,
        "responses": responses,
        "start_rate": round(starts / views * 100, 1) if views else None,
        "completion_rate": round(completions / starts * 100, 1) if starts else None,
        "dropoff": sorted(
            (
                {"question": q, "title": titles.get(q, q), "count": n}
                for q, n in dropoff.items()
            ),
            key=lambda x: -x["count"],
        ),
    }


def _parse_summary_filters(filters: Optional[str]) -> list[dict]:
    import json

    if not filters:
        return []
    try:
        raw = json.loads(filters)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="filtros inválidos")
    if not isinstance(raw, list):
        return []
    try:
        return [
            {"name": str(f["name"]), "values": list(f.get("values") or [])}
            for f in raw
            if isinstance(f, dict) and f.get("name")
        ]
    except (TypeError, KeyError):
        raise HTTPException(status_code=422, detail="filtros inválidos")


async def _summary_for(sid, ctx, session, *, segment_by, filters, date_from, date_to):
    from app.summarizing import build_summary

    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=422, detail="El rango de fechas está invertido.")
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
        )
    ).all()
    return s, build_summary(
        s.json_schema or {}, responses, filters=_parse_summary_filters(filters),
        segment_by=segment_by, date_from=date_from, date_to=date_to,
    )


@router.get("/{sid}/summary")
async def response_summary(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
    segment_by: Optional[str] = Query(None),
    filters: Optional[str] = Query(None, description="JSON: [{name, values:[...]}]"),
    date_from: Optional[date] = Query(None, description="Desde (inclusive, UTC)"),
    date_to: Optional[date] = Query(None, description="Hasta (inclusive, UTC)"),
):
    """Per-question, chart-ready aggregation of all responses (the Resumen view).
    Con `segment_by` cruza cada pregunta por otra (cross-tab, con prueba chi²);
    con `filters` (JSON) restringe el universo a quienes respondieron ciertos
    valores; con `date_from`/`date_to`, a un rango de fechas."""
    _s, summary = await _summary_for(sid, ctx, session, segment_by=segment_by, filters=filters,
                                     date_from=date_from, date_to=date_to)
    return summary


@router.get("/{sid}/quality")
async def response_quality(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Respuestas con señales de baja calidad (apuradas, en línea recta,
    duplicadas) entre las que hoy cuentan. No excluye nada: lo decide quien
    analiza, con la exclusión reversible de siempre."""
    from app.quality import assess

    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
        )
    ).all()
    return assess(s.json_schema or {}, responses)


@router.get("/{sid}/summary/crosstab")
async def export_crosstab(
    sid: uuid.UUID,
    segment_by: str = Query(...),
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    filters: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """El cruce del resumen como planilla (conteos, % y p-valor por pregunta).
    Son agregados, no respuestas individuales: no requiere rol admin."""
    from app.summarizing import crosstab_rows

    s, summary = await _summary_for(sid, ctx, session, segment_by=segment_by, filters=filters,
                                    date_from=date_from, date_to=date_to)
    rows = crosstab_rows(summary)
    if not rows:
        raise HTTPException(status_code=422, detail="Esa pregunta no sirve para segmentar.")
    base = f"{s.slug or 'encuesta'}-cruce"
    if format == "xlsx":
        data = await asyncio.to_thread(sheets_to_xlsx, [("Cruce", rows)])
        return StreamingResponse(iter([data]), media_type=XLSX_MEDIA,
                                 headers={"Content-Disposition": f'attachment; filename="{base}.xlsx"'})
    data = await asyncio.to_thread(rows_to_csv, rows)
    return StreamingResponse(iter([data]), media_type=CSV_MEDIA,
                             headers={"Content-Disposition": f'attachment; filename="{base}.csv"'})


@router.get("/{sid}/report")
async def get_report(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Devuelve el informe ejecutivo cacheado (o null si nunca se generó)."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    return {"report": s.report}


@router.post("/{sid}/report")
async def generate_report(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Genera (y cachea) el informe ejecutivo por IA. Los números los calcula el
    servidor; la IA solo redacta la narrativa y cita evidencia textual."""
    from app.llm_calls import generate_executive_report
    from app.summarizing import build_report_context

    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
        )
    ).all()
    if not responses:
        raise HTTPException(status_code=409, detail="No hay respuestas para analizar")

    funnel_data = await _funnel_data(sid, s, session)
    context = build_report_context(s.json_schema or {}, responses, funnel=funnel_data)
    report = await generate_executive_report(
        language=s.language or "es", context=context
    )
    report = {**report, "generated_at": datetime.now(timezone.utc).isoformat(),
              "response_count": len(responses)}
    s.report = report
    session.add(s)
    await session.commit()
    return {"report": report}


async def _registrar_borrado(session: AsyncSession, ctx: OrgContext, s, r) -> None:
    """Deja rastro de un borrado antes de ejecutarlo (es irreversible)."""
    from app.identity import respondent_identity
    from app.models import ResponseDeletion

    quien, mail = respondent_identity(s.json_schema or {}, r.answers)
    record_event(
        session, action="response.deleted", org_id=ctx.org.id, actor=ctx.user,
        survey_id=s.id, response_id=r.id,
        detail={"respondent": r.respondent_email or quien or mail,
                "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
                "integrity_hash": r.integrity_hash},
    )
    session.add(
        ResponseDeletion(
            survey_id=s.id,
            response_id=r.id,
            deleted_by=ctx.user.id,
            deleted_by_email=ctx.user.email,
            respondent=r.respondent_email or quien or mail,
            submitted_at=r.submitted_at,
        )
    )


@router.delete("/{sid}/responses/{rid}", status_code=204)
async def delete_response(
    sid: uuid.UUID,
    rid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Borra una respuesta (p. ej. un pedido de baja de datos). Irreversible y
    solo para admins; queda registrada en `response_deletions`."""
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session)
    r = await session.get(SurveyResponse, rid)
    if r and r.survey_id == sid:
        await _registrar_borrado(session, ctx, s, r)
        await session.delete(r)
        await session.commit()


class BulkResponsesRequest(BaseModel):
    ids: List[uuid.UUID]
    # exclude/include sacan o devuelven la respuesta a los resultados (reversible).
    # test/untest la marcan como prueba. delete la destruye (solo admin).
    action: str = Field(pattern="^(exclude|include|test|untest|delete)$")


@router.post("/{sid}/responses/bulk")
async def bulk_responses(
    sid: uuid.UUID,
    payload: BulkResponsesRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Acciones sobre varias respuestas a la vez.

    Excluir/marcar es reversible y lo puede hacer cualquier miembro; borrar es
    irreversible y queda restringido a admins (y registrado)."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    if payload.action == "delete":
        _require_admin(ctx)
    if not payload.ids:
        return {"affected": 0}

    rows = (
        await session.scalars(
            select(SurveyResponse).where(
                SurveyResponse.survey_id == sid, SurveyResponse.id.in_(payload.ids)
            )
        )
    ).all()

    for r in rows:
        if payload.action == "delete":
            await _registrar_borrado(session, ctx, s, r)
            await session.delete(r)
            continue
        if payload.action == "exclude":
            r.excluded = True
        elif payload.action == "include":
            r.excluded = False
        elif payload.action == "test":
            r.is_test = True
        elif payload.action == "untest":
            r.is_test = False
        session.add(r)
        record_event(session, action=f"response.{payload.action}", org_id=ctx.org.id,
                     actor=ctx.user, survey_id=sid, response_id=r.id)

    await session.commit()
    return {"affected": len(rows)}


@router.get("/{sid}/deletions")
async def list_deletions(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Registro de borrados de esta encuesta (quién, qué y cuándo)."""
    _require_admin(ctx)
    from app.models import ResponseDeletion

    await _survey_or_404(sid, ctx.org.id, session)
    rows = (
        await session.scalars(
            select(ResponseDeletion)
            .where(ResponseDeletion.survey_id == sid)
            .order_by(ResponseDeletion.deleted_at.desc())
            .limit(200)
        )
    ).all()
    return [
        {
            "id": str(d.id),
            "response_id": str(d.response_id),
            "deleted_by_email": d.deleted_by_email,
            "respondent": d.respondent,
            "submitted_at": d.submitted_at.isoformat() if d.submitted_at else None,
            "deleted_at": d.deleted_at.isoformat(),
        }
        for d in rows
    ]


@router.get("/{sid}/audit")
async def survey_audit(
    sid: uuid.UUID,
    limit: int = Query(200, ge=1, le=1000),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Registro de actividad de la encuesta: quién hizo qué y cuándo (lo más
    reciente primero). Solo admins: incluye exportaciones y borrados."""
    _require_admin(ctx)
    from app.models import AuditEvent

    await _survey_or_404(sid, ctx.org.id, session)
    rows = (
        await session.scalars(
            select(AuditEvent)
            .where(AuditEvent.org_id == ctx.org.id, AuditEvent.survey_id == sid)
            .order_by(AuditEvent.created_at.desc())
            .limit(limit)
        )
    ).all()
    return [
        {
            "id": str(e.id),
            "action": e.action,
            "actor_email": e.actor_email,
            "response_id": str(e.response_id) if e.response_id else None,
            "detail": e.detail,
            "created_at": e.created_at.isoformat(),
        }
        for e in rows
    ]


@router.get("/{sid}/responses/{rid}/history")
async def response_history(
    sid: uuid.UUID,
    rid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Todo lo que le pasó a una respuesta: con qué versión se contestó, cada
    cambio de nota (de dónde, quién, de cuánto a cuánto) y los eventos sobre
    ella (exclusiones, marcas). Lo más antiguo primero, como una línea de tiempo."""
    from app.audit import verify_response
    from app.models import AuditEvent, GradeRevision, SurveyVersion

    await _survey_or_404(sid, ctx.org.id, session)
    r = await session.get(SurveyResponse, rid)
    if not r or r.survey_id != sid:
        raise HTTPException(status_code=404, detail="Response not found")
    numeros = {
        v.id: v.number
        for v in (
            await session.scalars(select(SurveyVersion).where(SurveyVersion.survey_id == sid))
        ).all()
    }
    revs = (
        await session.scalars(
            select(GradeRevision)
            .where(GradeRevision.response_id == rid)
            .order_by(GradeRevision.created_at.asc())
        )
    ).all()
    events = (
        await session.scalars(
            select(AuditEvent)
            .where(AuditEvent.org_id == ctx.org.id, AuditEvent.response_id == rid)
            .order_by(AuditEvent.created_at.asc())
        )
    ).all()
    from app.jobs import job_view
    from app.models import Job

    entregas = (
        await session.scalars(
            select(Job)
            .where(Job.response_id == rid, Job.kind.in_(("lms.grade", "webhook.deliver", "grade.response")))
            .order_by(Job.created_at.asc())
        )
    ).all()
    return {
        "response_id": str(r.id),
        "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        "deliveries": [job_view(j) for j in entregas],
        "answered_version": numeros.get(r.survey_version_id),
        "integrity": verify_response(r),
        "grade_revisions": [
            {
                "id": str(g.id),
                "source": g.source,
                "actor_email": g.actor_email,
                "score_before": g.score_before,
                "score_after": g.score_after,
                "max_score": g.max_score,
                "graded_with_version": numeros.get(g.survey_version_id),
                "model": (g.grade_after or {}).get("model"),
                "prompt_version": (g.grade_after or {}).get("prompt_version"),
                "note": g.note,
                "created_at": g.created_at.isoformat(),
            }
            for g in revs
        ],
        "events": [
            {
                "action": e.action,
                "actor_email": e.actor_email,
                "detail": e.detail,
                "created_at": e.created_at.isoformat(),
            }
            for e in events
        ],
    }


@router.get("/{sid}/deliveries")
async def survey_deliveries(
    sid: uuid.UUID,
    status: Optional[str] = Query(None, pattern="^(pending|running|done|failed)$"),
    limit: int = Query(200, ge=1, le=1000),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Entregas y tareas de esta encuesta (notas al LMS, webhooks, emails,
    recorrecciones), las más recientes primero. Con `status=failed`, lo que se
    rindió y necesita atención."""
    from app.jobs import job_view
    from app.models import Job

    await _survey_or_404(sid, ctx.org.id, session)
    stmt = select(Job).where(Job.survey_id == sid, Job.org_id.is_(None) | (Job.org_id == ctx.org.id))
    if status:
        stmt = stmt.where(Job.status == status)
    rows = (await session.scalars(stmt.order_by(Job.created_at.desc()).limit(limit))).all()
    return [job_view(j) for j in rows]


@router.post("/{sid}/deliveries/{job_id}/retry")
async def retry_delivery(
    sid: uuid.UUID,
    job_id: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Reintenta ya una entrega fallida (o que espera su próximo intento)."""
    from app.jobs import job_view, retry_now
    from app.models import JOB_DONE, JOB_RUNNING, Job

    await _survey_or_404(sid, ctx.org.id, session)
    j = await session.get(Job, job_id)
    if j is None or j.survey_id != sid or (j.org_id is not None and j.org_id != ctx.org.id):
        raise HTTPException(status_code=404, detail="Entrega no encontrada")
    if j.status in (JOB_DONE, JOB_RUNNING):
        raise HTTPException(status_code=409, detail="Esa entrega no está pendiente ni fallida")
    await retry_now(session, j)
    record_event(session, action="delivery.retried", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=sid, response_id=j.response_id, detail={"kind": j.kind})
    await session.commit()
    return job_view(j)


@router.get("/{sid}/export")
async def export_responses(
    sid: uuid.UUID,
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    include_excluded: bool = Query(False, description="Incluir excluidas y de prueba"),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(
                select(SurveyResponse).where(SurveyResponse.survey_id == sid),
                include_excluded=include_excluded,
                include_test=include_excluded,
            ).order_by(SurveyResponse.submitted_at.asc())
        )
    ).all()
    from app.models import SurveyVersion

    versions = {
        v.id: v.number
        for v in (
            await session.scalars(select(SurveyVersion).where(SurveyVersion.survey_id == sid))
        ).all()
    }
    rows = export_rows(s, responses, versions)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    base = s.slug or "encuesta"
    if format == "xlsx":
        data = await asyncio.to_thread(sheets_to_xlsx, [("Respuestas", rows)])
        media, ext = XLSX_MEDIA, "xlsx"
    else:
        data = await asyncio.to_thread(rows_to_csv, rows)
        media, ext = CSV_MEDIA, "csv"

    # Exportar saca datos personales de la plataforma: queda quién y cuándo, con
    # la huella SHA-256 del archivo exacto que se descargó. La misma huella va
    # en un header, así quien recibe el archivo puede comprobar que es ése.
    import hashlib

    raw = data.encode("utf-8") if isinstance(data, str) else data
    sha = hashlib.sha256(raw).hexdigest()
    record_event(session, action="responses.exported", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=sid, detail={"format": format, "rows": len(responses),
                                        "include_excluded": include_excluded, "sha256": sha})
    await session.commit()
    return StreamingResponse(
        iter([data]), media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.{ext}"',
                 "X-Encuestum-SHA256": sha},
    )


# ── Access control: invitees (email allowlist) and results release ───────────
class InviteeIn(BaseModel):
    email: EmailStr
    name: str | None = None


class InviteesBulkRequest(BaseModel):
    invitees: List[InviteeIn] = Field(max_length=5000)


class InviteeOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str | None
    code: str
    used_at: datetime | None
    sent_at: datetime | None
    opened_at: datetime | None = None
    responded_at: datetime | None = None
    reminders_sent: int = 0
    last_reminded_at: datetime | None = None
    created_at: datetime

    @classmethod
    def of(cls, i: SurveyInvitee) -> "InviteeOut":
        return cls(id=i.id, email=i.email, name=i.name, code=i.code,
                   used_at=i.used_at, sent_at=i.sent_at, opened_at=i.opened_at,
                   responded_at=i.responded_at, reminders_sent=i.reminders_sent or 0,
                   last_reminded_at=i.last_reminded_at, created_at=i.created_at)


@router.get("/{sid}/invitees", response_model=List[InviteeOut])
async def list_invitees(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    await _survey_or_404(sid, ctx.org.id, session)
    rows = (
        await session.scalars(
            select(SurveyInvitee).where(SurveyInvitee.survey_id == sid)
            .order_by(SurveyInvitee.created_at.asc())
        )
    ).all()
    return [InviteeOut.of(i) for i in rows]


@router.post("/{sid}/invitees", response_model=List[InviteeOut])
async def add_invitees(
    sid: uuid.UUID,
    payload: InviteesBulkRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    _require_admin(ctx)
    await _survey_or_404(sid, ctx.org.id, session)
    existing = {
        i.email
        for i in (
            await session.scalars(select(SurveyInvitee).where(SurveyInvitee.survey_id == sid))
        ).all()
    }
    created: List[SurveyInvitee] = []
    for item in payload.invitees:
        email = item.email.strip().lower()
        if not email or email in existing:
            continue
        existing.add(email)
        inv = SurveyInvitee(survey_id=sid, email=email, name=(item.name or None))
        session.add(inv)
        created.append(inv)
    await session.commit()
    for inv in created:
        await session.refresh(inv)
    return [InviteeOut.of(i) for i in created]


@router.delete("/{sid}/invitees/{iid}")
async def delete_invitee(
    sid: uuid.UUID,
    iid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    _require_admin(ctx)
    await _survey_or_404(sid, ctx.org.id, session)
    inv = await session.get(SurveyInvitee, iid)
    if inv and inv.survey_id == sid:
        await session.delete(inv)
        await session.commit()
    return {"detail": "Invitado eliminado"}


@router.post("/{sid}/invitees/send")
async def send_invitee_links(
    sid: uuid.UUID,
    only_unsent: bool = Query(True),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Email each invitee a magic link (survey URL with their email+code)."""
    _require_admin(ctx)
    from app.config import get_settings
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not get_settings().smtp_configured:
        raise HTTPException(status_code=400, detail="Falta configurar SMTP para enviar emails.")
    stmt = select(SurveyInvitee).where(SurveyInvitee.survey_id == sid)
    if only_unsent:
        stmt = stmt.where(SurveyInvitee.sent_at.is_(None))
    rows = (await session.scalars(stmt)).all()
    from app.distribution import enqueue_invite

    # Encolado en la misma transacción que marca `sent_at`: o quedan las dos
    # cosas o ninguna, y si el SMTP falla la cola reintenta.
    outbox = []
    for inv in rows:
        enqueue_invite(session, s, inv)
        outbox.append(inv.email)
        inv.sent_at = _utcnow()
        session.add(inv)
    record_event(session, action="invitees.sent", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=sid, detail={"count": len(outbox)})
    await session.commit()
    return {"sent": len(outbox), "total": len(rows)}


@router.get("/{sid}/invitees/tracking")
async def invitees_tracking(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Embudo de las invitaciones: enviadas → abiertas → clic → respondidas."""
    from app.distribution import clean_reminders, tracking_summary

    s = await _survey_or_404(sid, ctx.org.id, session)
    rows = (await session.scalars(select(SurveyInvitee).where(SurveyInvitee.survey_id == sid))).all()
    try:
        cfg = clean_reminders(s.reminders)
    except ValueError:
        cfg = None
    return {**tracking_summary(list(rows)), "reminders_config": cfg}


@router.post("/{sid}/invitees/remind")
async def remind_invitees(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Recordatorio YA a quienes recibieron la invitación y no respondieron
    (además de los automáticos, si están configurados)."""
    _require_admin(ctx)
    from app.config import get_settings
    from app.distribution import enqueue_invite

    s = await _survey_or_404(sid, ctx.org.id, session)
    if not get_settings().smtp_configured:
        raise HTTPException(status_code=400, detail="Falta configurar SMTP para enviar emails.")
    rows = (await session.scalars(select(SurveyInvitee).where(
        SurveyInvitee.survey_id == sid, SurveyInvitee.sent_at.is_not(None), SurveyInvitee.responded_at.is_(None),
    ))).all()
    ahora = _utcnow()
    for inv in rows:
        enqueue_invite(session, s, inv, reminder=True)
        inv.reminders_sent = (inv.reminders_sent or 0) + 1
        inv.last_reminded_at = ahora
        session.add(inv)
    record_event(session, action="invitees.reminded", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=sid, detail={"count": len(rows), "manual": True})
    await session.commit()
    return {"sent": len(rows)}


@router.post("/{sid}/release-results", response_model=SurveyDetail)
async def release_results(
    sid: uuid.UUID,
    released: bool = Query(True),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session)
    s.results_released = released
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)
