"""Colaboración: comentarios sobre la encuesta o sus preguntas, y el ajuste de
la organización que exige aprobación para publicar."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import scopes
from app.audit import record_event
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Survey, SurveyComment
from app.routers.admin import _survey_or_404

router = APIRouter(prefix="/surveys", tags=["comments"], dependencies=[Depends(scopes.guard)])
workflow_router = APIRouter(prefix="/workflow", tags=["workflow"])


def _view(c: SurveyComment) -> dict:
    return {"id": str(c.id), "question": c.question, "body": c.body, "author": c.author_email,
            "resolved": c.resolved_at is not None, "created_at": c.created_at.isoformat()}


@router.get("/{sid}/comments")
async def list_comments(sid: uuid.UUID, ctx: OrgContext = Depends(current_context),
                        session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    rows = (await session.scalars(
        select(SurveyComment).where(SurveyComment.survey_id == sid).order_by(SurveyComment.created_at)
    )).all()
    return [_view(c) for c in rows]


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    question: Optional[str] = Field(default=None, max_length=200)


@router.post("/{sid}/comments", status_code=201)
async def add_comment(sid: uuid.UUID, payload: CommentIn, ctx: OrgContext = Depends(current_context),
                      session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    c = SurveyComment(survey_id=sid, question=payload.question or None, body=payload.body.strip(),
                      author_id=ctx.user.id, author_email=ctx.user.email)
    session.add(c)
    await session.commit()
    await session.refresh(c)
    return _view(c)


async def _comment(sid, cid, session) -> SurveyComment:
    c = await session.get(SurveyComment, cid)
    if c is None or c.survey_id != sid:
        raise HTTPException(status_code=404, detail="Comentario no encontrado")
    return c


@router.post("/{sid}/comments/{cid}/resolve")
async def resolve_comment(sid: uuid.UUID, cid: uuid.UUID, resolved: bool = True,
                          ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    c = await _comment(sid, cid, session)
    c.resolved_at = datetime.now(timezone.utc) if resolved else None
    session.add(c)
    await session.commit()
    return _view(c)


@router.delete("/{sid}/comments/{cid}", status_code=204)
async def delete_comment(sid: uuid.UUID, cid: uuid.UUID, ctx: OrgContext = Depends(current_context),
                         session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    c = await _comment(sid, cid, session)
    if c.author_id != ctx.user.id and not scopes.is_admin(ctx):
        raise HTTPException(status_code=403, detail="Sólo quien lo escribió (o un admin) puede borrarlo.")
    await session.delete(c)
    await session.commit()


class WorkflowIn(BaseModel):
    require_publish_approval: bool


@workflow_router.get("")
async def get_workflow(ctx: OrgContext = Depends(current_context)):
    return {"require_publish_approval": bool(ctx.org.require_publish_approval)}


@workflow_router.put("")
async def set_workflow(payload: WorkflowIn, ctx: OrgContext = Depends(current_context),
                       session: AsyncSession = Depends(get_session)):
    if not scopes.is_admin(ctx):
        raise HTTPException(status_code=403, detail="Requiere rol admin")
    ctx.org.require_publish_approval = payload.require_publish_approval
    session.add(ctx.org)
    record_event(session, action="org.workflow_changed", org_id=ctx.org.id, actor=ctx.user,
                 detail={"require_publish_approval": payload.require_publish_approval})
    await session.commit()
    return {"require_publish_approval": payload.require_publish_approval}


@workflow_router.get("/pending")
async def pending_approvals(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Encuestas esperando aprobación para publicarse."""
    rows = (await session.scalars(
        select(Survey).where(Survey.org_id == ctx.org.id, Survey.deleted_at.is_(None), Survey.approval.is_not(None))
    )).all()
    return [{"id": str(s.id), "title": s.title, **(s.approval or {})}
            for s in rows if (s.approval or {}).get("state") == "pending"]
