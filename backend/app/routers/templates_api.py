"""Plantillas propias de la organización: guardar una encuesta como plantilla
y crear encuestas nuevas a partir de ella."""

from __future__ import annotations

import copy
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import scopes
from app.audit import record_event
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Survey, SurveyTemplate
from app.schemas import SurveyDetail

router = APIRouter(prefix="/templates", tags=["templates"], dependencies=[Depends(scopes.guard)])


class FromSurvey(BaseModel):
    survey_id: uuid.UUID
    title: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = Field(default=None, max_length=1000)
    category: Optional[str] = Field(default=None, max_length=80)


def _view(t: SurveyTemplate) -> dict:
    preguntas = sum(len(p.get("elements") or []) for p in (t.json_schema or {}).get("pages", []) or []
                    if isinstance(p, dict))
    return {"id": str(t.id), "title": t.title, "description": t.description, "category": t.category,
            "questions": preguntas, "is_evaluation": bool((t.evaluation or {}).get("enabled")),
            "language": t.language, "uses": t.uses, "created_at": t.created_at.isoformat()}


@router.get("")
async def list_templates(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    rows = (await session.scalars(
        select(SurveyTemplate).where(SurveyTemplate.org_id == ctx.org.id).order_by(SurveyTemplate.created_at.desc())
    )).all()
    return [_view(t) for t in rows]


@router.post("", status_code=201)
async def save_as_template(payload: FromSurvey, ctx: OrgContext = Depends(current_context),
                           session: AsyncSession = Depends(get_session)):
    s = await session.get(Survey, payload.survey_id)
    if s is None or s.org_id != ctx.org.id or s.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Encuesta no encontrada")
    t = SurveyTemplate(
        org_id=ctx.org.id, title=(payload.title or s.title or "Plantilla").strip()[:200],
        description=(payload.description or "").strip() or None,
        category=(payload.category or "").strip() or None,
        json_schema=copy.deepcopy(s.json_schema or {}), evaluation=copy.deepcopy(s.evaluation),
        theme=copy.deepcopy(s.theme), language=s.language, created_by=ctx.user.id,
    )
    session.add(t)
    await session.flush()
    record_event(session, action="template.created", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id,
                 detail={"template_id": str(t.id), "title": t.title})
    await session.commit()
    await session.refresh(t)
    return _view(t)


async def _template(tid: uuid.UUID, ctx: OrgContext, session: AsyncSession) -> SurveyTemplate:
    t = await session.get(SurveyTemplate, tid)
    if t is None or t.org_id != ctx.org.id:
        raise HTTPException(status_code=404, detail="Plantilla no encontrada")
    return t


@router.get("/{tid}")
async def get_template(tid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    t = await _template(tid, ctx, session)
    return {**_view(t), "json_schema": t.json_schema, "evaluation": t.evaluation, "theme": t.theme}


@router.post("/{tid}/use", response_model=SurveyDetail, status_code=201)
async def use_template(tid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    t = await _template(tid, ctx, session)
    s = Survey(org_id=ctx.org.id, created_by=ctx.user.id, title=t.title,
               json_schema=copy.deepcopy(t.json_schema or {}), evaluation=copy.deepcopy(t.evaluation),
               theme=copy.deepcopy(t.theme), language=t.language, status="draft")
    session.add(s)
    t.uses = (t.uses or 0) + 1
    session.add(t)
    await session.flush()
    record_event(session, action="survey.created", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id,
                 detail={"from_template": str(t.id)})
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.delete("/{tid}", status_code=204)
async def delete_template(tid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    t = await _template(tid, ctx, session)
    await session.delete(t)
    await session.commit()
