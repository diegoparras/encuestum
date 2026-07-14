import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from pydantic import BaseModel, EmailStr, Field

from app.db import get_session
from app.deps import OrgContext, current_context
from app.email import build_url, send_email
from app.exporting import CSV_MEDIA, XLSX_MEDIA, export_rows, rows_to_csv, sheets_to_xlsx
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
                select(SurveyResponse.survey_id, func.count(SurveyResponse.id))
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
            created_at=s.created_at, updated_at=s.updated_at,
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
    # org_id / created_by / slug are handled explicitly, never via the generic loop.
    data.pop("org_id", None)
    data.pop("created_by", None)
    data.pop("slug", None)
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

    session.add(s)
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
        status="draft",  # copies start unpublished
    )
    session.add(copy)
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
    session.add(s)
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
                select(SurveyResponse.survey_id, func.count(SurveyResponse.id))
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
            created_at=s.created_at, updated_at=s.updated_at, deleted_at=s.deleted_at,
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
    await session.execute(delete(SurveyResponse).where(SurveyResponse.survey_id == sid))
    await session.delete(s)
    await session.commit()


@router.get("/{sid}/responses", response_model=List[ResponseItem])
async def list_responses(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == sid)
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).all()
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
    from app.models import SurveyVisit
    s = await _survey_or_404(sid, ctx.org.id, session)
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
            select(func.count(SurveyResponse.id)).where(SurveyResponse.survey_id == sid)
        )
        or 0
    )
    return {
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


@router.get("/{sid}/summary")
async def response_summary(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
    segment_by: Optional[str] = Query(None),
    filters: Optional[str] = Query(None, description="JSON: [{name, values:[...]}]"),
):
    """Per-question, chart-ready aggregation of all responses (the Resumen view).
    Con `segment_by` cruza cada pregunta por otra (cross-tab); con `filters`
    (JSON) restringe el universo a quienes respondieron ciertos valores."""
    import json

    from app.summarizing import build_summary

    s = await _survey_or_404(sid, ctx.org.id, session)
    parsed_filters: list[dict] = []
    if filters:
        try:
            raw = json.loads(filters)
            if isinstance(raw, list):
                parsed_filters = [
                    {"name": str(f["name"]), "values": list(f.get("values") or [])}
                    for f in raw
                    if isinstance(f, dict) and f.get("name")
                ]
        except (ValueError, TypeError, KeyError):
            raise HTTPException(status_code=422, detail="filtros inválidos")
    responses = (
        await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == sid)
        )
    ).all()
    return build_summary(
        s.json_schema or {}, responses, filters=parsed_filters, segment_by=segment_by
    )


@router.delete("/{sid}/responses/{rid}", status_code=204)
async def delete_response(
    sid: uuid.UUID,
    rid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Delete a single response (e.g. a respondent's data-removal request)."""
    _require_admin(ctx)
    await _survey_or_404(sid, ctx.org.id, session)
    r = await session.get(SurveyResponse, rid)
    if r and r.survey_id == sid:
        await session.delete(r)
        await session.commit()


@router.get("/{sid}/export")
async def export_responses(
    sid: uuid.UUID,
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    _require_admin(ctx)
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == sid)
            .order_by(SurveyResponse.submitted_at.asc())
        )
    ).all()
    rows = export_rows(s, responses)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    base = s.slug or "encuesta"

    if format == "xlsx":
        data = await asyncio.to_thread(sheets_to_xlsx, [("Respuestas", rows)])
        return StreamingResponse(
            iter([data]), media_type=XLSX_MEDIA,
            headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.xlsx"'},
        )
    csv_data = await asyncio.to_thread(rows_to_csv, rows)
    return StreamingResponse(
        iter([csv_data]), media_type=CSV_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.csv"'},
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
    created_at: datetime

    @classmethod
    def of(cls, i: SurveyInvitee) -> "InviteeOut":
        return cls(id=i.id, email=i.email, name=i.name, code=i.code,
                   used_at=i.used_at, sent_at=i.sent_at, created_at=i.created_at)


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
    title = s.title or "una encuesta"

    # Recolectá los emails a enviar y marcá sent_at antes de responder; el envío
    # SMTP (bloqueante) se dispara fire-and-forget para no colgar el request.
    outbox: list[tuple[str, str, str]] = []
    subject = f"Invitación: {title}"
    for inv in rows:
        link = build_url(f"/s/{s.slug}", email=inv.email, code=inv.code)
        text = (
            f"Hola{(' ' + inv.name) if inv.name else ''},\n\n"
            f"Fuiste invitado/a a responder «{title}».\n"
            f"Ingresá con este enlace:\n{link}\n\n"
            f"Tu código de acceso es: {inv.code}\n"
        )
        outbox.append((inv.email, subject, text))
        inv.sent_at = _utcnow()
        session.add(inv)
    await session.commit()

    if outbox:
        try:
            asyncio.get_running_loop().create_task(_dispatch_invitee_emails(outbox))
        except RuntimeError:
            pass
    return {"sent": len(outbox), "total": len(rows)}


async def _dispatch_invitee_emails(outbox: list[tuple[str, str, str]]) -> None:
    """Send queued invitee emails in the background (no DB access here)."""
    for email, subject, text in outbox:
        try:
            await send_email(email, subject, text)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("envío de invitación a %s falló: %s", email, exc)


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
