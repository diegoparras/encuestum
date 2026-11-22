"""Lista de invitados de una encuesta (acceso por email + código): alta,
envío de enlaces, seguimiento (enviada/abierta/entró/respondió),
recordatorios y cupos. Separado de `admin.py` para que ese router quede en lo
que es de la encuesta en sí."""

import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import scopes
from app.audit import record_event
from app.db import get_session
from app.deps import OrgContext, current_context
from app.hygiene import counted_only
from app.models import SurveyInvitee, SurveyResponse, _utcnow
from app.routers.admin import _require_admin, _survey_or_404

router = APIRouter(prefix="/surveys", tags=["invitees"], dependencies=[Depends(scopes.guard)])


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


@router.get("/{sid}/quotas")
async def quotas_status(
    sid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Cuánto lleva cada cupo."""
    from app import fields as fields_mod

    s = await _survey_or_404(sid, ctx.org.id, session)
    previas = (await session.scalars(
        counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
    )).all()
    return fields_mod.quota_status(s.quotas, [fields_mod.answers_with_hidden(r) for r in previas])


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


