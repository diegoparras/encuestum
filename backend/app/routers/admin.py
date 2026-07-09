import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from pydantic import BaseModel, EmailStr

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


async def _survey_or_404(sid: uuid.UUID, org_id: uuid.UUID, session: AsyncSession) -> Survey:
    s = await session.get(Survey, sid)
    if not s or s.org_id != org_id:
        raise HTTPException(status_code=404, detail="Survey not found")
    return s


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
            select(Survey).where(Survey.org_id == ctx.org.id).order_by(Survey.updated_at.desc())
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
    data = payload.model_dump(exclude_unset=True)
    # org_id / created_by are never client-settable.
    data.pop("org_id", None)
    data.pop("created_by", None)
    for field, value in data.items():
        setattr(s, field, value)
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
    s = await _survey_or_404(sid, ctx.org.id, session)
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


@router.get("/{sid}/summary")
async def response_summary(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Per-question, chart-ready aggregation of all responses (the Resumen view)."""
    from app.summarizing import build_summary
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == sid)
        )
    ).all()
    return build_summary(s.json_schema or {}, responses)


@router.delete("/{sid}/responses/{rid}", status_code=204)
async def delete_response(
    sid: uuid.UUID,
    rid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Delete a single response (e.g. a respondent's data-removal request)."""
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
        data = sheets_to_xlsx([("Respuestas", rows)])
        return StreamingResponse(
            iter([data]), media_type=XLSX_MEDIA,
            headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.xlsx"'},
        )
    return StreamingResponse(
        iter([rows_to_csv(rows)]), media_type=CSV_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.csv"'},
    )


# ── Access control: invitees (email allowlist) and results release ───────────
class InviteeIn(BaseModel):
    email: EmailStr
    name: str | None = None


class InviteesBulkRequest(BaseModel):
    invitees: List[InviteeIn]


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
    from app.config import get_settings
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not get_settings().smtp_configured:
        raise HTTPException(status_code=400, detail="Falta configurar SMTP para enviar emails.")
    stmt = select(SurveyInvitee).where(SurveyInvitee.survey_id == sid)
    if only_unsent:
        stmt = stmt.where(SurveyInvitee.sent_at.is_(None))
    rows = (await session.scalars(stmt)).all()
    sent = 0
    title = s.title or "una encuesta"
    for inv in rows:
        link = build_url(f"/s/{s.slug}", email=inv.email, code=inv.code)
        text = (
            f"Hola{(' ' + inv.name) if inv.name else ''},\n\n"
            f"Fuiste invitado/a a responder «{title}».\n"
            f"Ingresá con este enlace:\n{link}\n\n"
            f"Tu código de acceso es: {inv.code}\n"
        )
        try:
            await send_email(inv.email, f"Invitación: {title}", text)
            inv.sent_at = _utcnow()
            session.add(inv)
            sent += 1
        except Exception:  # noqa: BLE001
            continue
    await session.commit()
    return {"sent": sent, "total": len(rows)}


@router.post("/{sid}/release-results", response_model=SurveyDetail)
async def release_results(
    sid: uuid.UUID,
    released: bool = Query(True),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    s = await _survey_or_404(sid, ctx.org.id, session)
    s.results_released = released
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)
