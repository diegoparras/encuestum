import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.models import Survey, SurveyResponse
from app.schemas import (
    VALID_STATUSES, ResponseItem, SurveyCreateRequest, SurveyDetail,
    SurveySummary, SurveyUpdateRequest,
)

router = APIRouter(prefix="/surveys", tags=["surveys"])


async def _survey_or_404(sid: uuid.UUID, session: AsyncSession) -> Survey:
    s = await session.get(Survey, sid)
    if not s:
        raise HTTPException(status_code=404, detail="Survey not found")
    return s


@router.post("", response_model=SurveyDetail)
async def create_survey(payload: SurveyCreateRequest, session: AsyncSession = Depends(get_session)):
    s = Survey(
        title=payload.title, json_schema=payload.json_schema or {},
        language=payload.language, theme=payload.theme, evaluation=payload.evaluation,
    )
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.get("", response_model=List[SurveySummary])
async def list_surveys(session: AsyncSession = Depends(get_session)):
    surveys = (await session.scalars(select(Survey).order_by(Survey.updated_at.desc()))).all()
    rows = (
        await session.execute(
            select(SurveyResponse.survey_id, func.count(SurveyResponse.id)).group_by(
                SurveyResponse.survey_id
            )
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
async def get_survey(sid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    return SurveyDetail.from_model(await _survey_or_404(sid, session))


@router.put("/{sid}", response_model=SurveyDetail)
async def update_survey(sid: uuid.UUID, payload: SurveyUpdateRequest, session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, session)
    if payload.status is not None and payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status. Expected {sorted(VALID_STATUSES)}")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(s, field, value)
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.post("/{sid}/publish", response_model=SurveyDetail)
async def publish_survey(sid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, session)
    s.status = "published"
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.post("/{sid}/close", response_model=SurveyDetail)
async def close_survey(sid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, session)
    s.status = "closed"
    session.add(s)
    await session.commit()
    await session.refresh(s)
    return SurveyDetail.from_model(s)


@router.delete("/{sid}", status_code=204)
async def delete_survey(sid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, session)
    await session.execute(delete(SurveyResponse).where(SurveyResponse.survey_id == sid))
    await session.delete(s)
    await session.commit()


@router.get("/{sid}/responses", response_model=List[ResponseItem])
async def list_responses(sid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, session)
    responses = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == sid)
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).all()
    return [ResponseItem.from_model(r) for r in responses]


@router.get("/{sid}/responses/{rid}", response_model=ResponseItem)
async def get_response(sid: uuid.UUID, rid: uuid.UUID, session: AsyncSession = Depends(get_session)):
    r = await session.get(SurveyResponse, rid)
    if not r or r.survey_id != sid:
        raise HTTPException(status_code=404, detail="Response not found")
    return ResponseItem.from_model(r)
