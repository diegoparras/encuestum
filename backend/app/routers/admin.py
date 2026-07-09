import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Survey, SurveyResponse
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
