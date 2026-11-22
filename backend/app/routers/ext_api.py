"""API pública de Encuestum (`/api/v1/ext`), con claves por organización.

Pensada para integraciones (BI, CRM, scripts): listar encuestas, leer
respuestas de a páginas o desde una fecha, traer el resumen, y cargar
invitados. La especificación OpenAPI está en `/api/v1/ext/openapi.json` y la
documentación navegable en `/api/v1/ext/docs`.

Las claves se administran en `/api/v1/api-keys` (sesión de un admin)."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import api_keys
from app.api_keys import ApiContext, api_context
from app.audit import record_event, verify_response
from app.db import get_session
from app.deps import OrgContext, current_context
from app.hygiene import counted_only
from app.models import ROLE_ADMIN, ROLE_RANK, ApiKey, Survey, SurveyInvitee, SurveyResponse

router = APIRouter(prefix="/ext", tags=["API pública"])
keys_router = APIRouter(prefix="/api-keys", tags=["api-keys"])


# ── Administración de claves (sesión de admin) ──────────────────────────────


class KeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scope: str = Field(default="read", pattern="^(read|write)$")


def _require_admin(ctx: OrgContext) -> None:
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Requiere rol admin")


@keys_router.get("")
async def list_keys(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    _require_admin(ctx)
    rows = (await session.scalars(
        select(ApiKey).where(ApiKey.org_id == ctx.org.id).order_by(ApiKey.created_at.desc())
    )).all()
    return [api_keys.view(k) for k in rows]


@keys_router.post("", status_code=201)
async def create_key(payload: KeyIn, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Devuelve la clave completa UNA vez; después sólo se ve el prefijo."""
    _require_admin(ctx)
    clave, prefijo, h = api_keys.generate()
    k = ApiKey(org_id=ctx.org.id, name=payload.name.strip(), prefix=prefijo, key_hash=h,
               scope=payload.scope, created_by=ctx.user.id)
    session.add(k)
    await session.flush()
    record_event(session, action="api_key.created", org_id=ctx.org.id, actor=ctx.user,
                 detail={"key_id": str(k.id), "name": k.name, "scope": k.scope})
    await session.commit()
    await session.refresh(k)
    return {**api_keys.view(k), "key": clave}


@keys_router.delete("/{kid}", status_code=204)
async def revoke_key(kid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    _require_admin(ctx)
    k = await session.get(ApiKey, kid)
    if k is None or k.org_id != ctx.org.id:
        raise HTTPException(status_code=404, detail="Clave no encontrada")
    if k.revoked_at is None:
        k.revoked_at = datetime.now(timezone.utc)
        session.add(k)
        record_event(session, action="api_key.revoked", org_id=ctx.org.id, actor=ctx.user,
                     detail={"key_id": str(k.id), "name": k.name})
        await session.commit()


# ── API pública ─────────────────────────────────────────────────────────────


class SurveyOut(BaseModel):
    id: uuid.UUID
    title: Optional[str]
    slug: str
    status: str
    language: Optional[str]
    is_evaluation: bool
    anonymous: bool
    response_count: int
    created_at: datetime
    updated_at: datetime


class ResponseOut(BaseModel):
    id: uuid.UUID
    survey_id: uuid.UUID
    submitted_at: Optional[datetime]
    completed: bool
    answers: dict[str, Any]
    respondent_email: Optional[str]
    score: Optional[float]
    max_score: Optional[float]
    percent: Optional[float]
    needs_review: bool
    survey_version_id: Optional[uuid.UUID]
    integrity_ok: Optional[bool]
    hidden: dict[str, str] = {}


class ResponsesPage(BaseModel):
    items: List[ResponseOut]
    total: int
    next_offset: Optional[int]


async def _survey(sid: uuid.UUID, api: ApiContext, session: AsyncSession) -> Survey:
    s = await session.get(Survey, sid)
    if s is None or s.org_id != api.org.id or s.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Encuesta no encontrada")
    return s


@router.get("/surveys", response_model=List[SurveyOut], summary="Listar encuestas")
async def ext_list_surveys(
    status: Optional[str] = Query(None, pattern="^(draft|published|closed)$"),
    api: ApiContext = Depends(api_context),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Survey).where(Survey.org_id == api.org.id, Survey.deleted_at.is_(None))
    if status:
        stmt = stmt.where(Survey.status == status)
    surveys = (await session.scalars(stmt.order_by(Survey.created_at.desc()))).all()
    counts = dict((await session.execute(
        counted_only(select(SurveyResponse.survey_id, func.count()).where(
            SurveyResponse.survey_id.in_([s.id for s in surveys] or [uuid.uuid4()])
        )).group_by(SurveyResponse.survey_id)
    )).all())
    return [SurveyOut(
        id=s.id, title=s.title, slug=s.slug, status=s.status, language=s.language,
        is_evaluation=bool((s.evaluation or {}).get("enabled")), anonymous=bool(s.anonymous),
        response_count=counts.get(s.id, 0), created_at=s.created_at, updated_at=s.updated_at,
    ) for s in surveys]


@router.get("/surveys/{sid}", summary="Detalle de una encuesta (con su esquema)")
async def ext_get_survey(sid: uuid.UUID, api: ApiContext = Depends(api_context), session: AsyncSession = Depends(get_session)):
    s = await _survey(sid, api, session)
    return {
        "id": str(s.id), "title": s.title, "slug": s.slug, "status": s.status, "language": s.language,
        "json_schema": s.json_schema or {}, "opens_at": s.opens_at, "closes_at": s.closes_at,
        "access_mode": s.access_mode, "anonymous": bool(s.anonymous),
        "is_evaluation": bool((s.evaluation or {}).get("enabled")),
    }


@router.get("/surveys/{sid}/responses", response_model=ResponsesPage, summary="Respuestas (paginadas)")
async def ext_list_responses(
    sid: uuid.UUID,
    since: Optional[datetime] = Query(None, description="Sólo las enviadas después de esta fecha (ISO 8601)"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    api: ApiContext = Depends(api_context),
    session: AsyncSession = Depends(get_session),
):
    """Ordenadas por fecha de envío, de la más vieja a la más nueva: para
    sincronizar, guardá la última `submitted_at` y pedí `since=` esa fecha."""
    await _survey(sid, api, session)
    base = counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
    if since is not None:
        base = base.where(SurveyResponse.submitted_at > since)
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await session.scalars(
        base.order_by(SurveyResponse.submitted_at.asc(), SurveyResponse.id).offset(offset).limit(limit)
    )).all()
    items = [ResponseOut(
        id=r.id, survey_id=r.survey_id, submitted_at=r.submitted_at, completed=bool(r.completed),
        answers=r.answers or {}, respondent_email=r.respondent_email, score=r.score, max_score=r.max_score,
        percent=(r.grade or {}).get("percent"), needs_review=bool(r.needs_review),
        survey_version_id=r.survey_version_id, integrity_ok=verify_response(r),
        hidden=(r.meta or {}).get("hidden") or {},
    ) for r in rows]
    nxt = offset + len(items)
    return ResponsesPage(items=items, total=total or 0, next_offset=nxt if nxt < (total or 0) else None)


@router.get("/surveys/{sid}/summary", summary="Resumen por pregunta")
async def ext_summary(
    sid: uuid.UUID,
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    api: ApiContext = Depends(api_context),
    session: AsyncSession = Depends(get_session),
):
    from app.summarizing import build_summary

    s = await _survey(sid, api, session)
    responses = (await session.scalars(
        counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
    )).all()
    return build_summary(s.json_schema or {}, responses, date_from=date_from, date_to=date_to,
                         hidden_fields=s.hidden_fields)


class InviteeIn(BaseModel):
    email: EmailStr
    name: Optional[str] = Field(default=None, max_length=200)


class InviteesIn(BaseModel):
    invitees: List[InviteeIn] = Field(max_length=5000)
    send: bool = Field(default=False, description="Mandar la invitación por email a los nuevos")


@router.post("/surveys/{sid}/invitees", status_code=201, summary="Cargar invitados (clave de escritura)")
async def ext_add_invitees(
    sid: uuid.UUID, payload: InviteesIn, api: ApiContext = Depends(api_context), session: AsyncSession = Depends(get_session)
):
    api.require_write()
    s = await _survey(sid, api, session)
    if s.access_mode != "list":
        raise HTTPException(status_code=409, detail="La encuesta no es de acceso por lista de invitados.")
    existentes = set((await session.scalars(
        select(SurveyInvitee.email).where(SurveyInvitee.survey_id == sid)
    )).all())
    nuevos = []
    for it in payload.invitees:
        email = str(it.email).strip().lower()
        if email in existentes:
            continue
        existentes.add(email)
        inv = SurveyInvitee(survey_id=sid, email=email, name=it.name or None)
        session.add(inv)
        nuevos.append(inv)
    await session.flush()
    if payload.send:
        from app.config import get_settings
        from app.distribution import enqueue_invite

        if not get_settings().smtp_configured:
            raise HTTPException(status_code=400, detail="Falta configurar SMTP para enviar emails.")
        for inv in nuevos:
            enqueue_invite(session, s, inv)
            inv.sent_at = datetime.now(timezone.utc)
            session.add(inv)
    record_event(session, action="invitees.added", org_id=api.org.id, survey_id=sid,
                 detail={"count": len(nuevos), "via": f"api:{api.key.name}", "sent": payload.send})
    await session.commit()
    return {"created": len(nuevos), "invitees": [{"email": i.email, "code": i.code} for i in nuevos]}


@router.get("/surveys/{sid}/invitees/tracking", summary="Seguimiento de invitaciones")
async def ext_tracking(sid: uuid.UUID, api: ApiContext = Depends(api_context), session: AsyncSession = Depends(get_session)):
    from app.distribution import tracking_summary

    await _survey(sid, api, session)
    rows = (await session.scalars(select(SurveyInvitee).where(SurveyInvitee.survey_id == sid))).all()
    return tracking_summary(list(rows))
