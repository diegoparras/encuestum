import csv
import io
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
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


# Columns (name, title) for the real questions in a schema, skipping companion
# media elements and non-input display elements.
def _survey_columns(schema: dict) -> List[tuple]:
    cols: List[tuple] = []
    for page in (schema or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            name = el.get("name")
            if not name or name.endswith("__img") or name.endswith("__vid"):
                continue
            if el.get("type") in ("html", "image", "expression"):
                continue
            cols.append((name, el.get("title") or name))
    return cols


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(str(v) for v in value)
    if isinstance(value, dict):
        import json
        return json.dumps(value, ensure_ascii=False)
    return str(value)


_META = ["id", "submitted_at", "completed", "score", "max_score", "percent", "needs_review"]


def _export_rows(survey: Survey, responses: List[SurveyResponse]):
    cols = _survey_columns(survey.json_schema or {})
    header = _META + [title for (_n, title) in cols]
    rows = [header]
    for r in responses:
        answers = r.answers or {}
        grade = r.grade or {}
        meta = [
            str(r.id), r.submitted_at.isoformat() if r.submitted_at else "",
            "sí" if r.completed else "no",
            _cell(r.score), _cell(r.max_score), _cell(grade.get("percent")),
            "sí" if r.needs_review else "no",
        ]
        rows.append(meta + [_cell(answers.get(name)) for (name, _t) in cols])
    return rows

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
    rows = _export_rows(s, responses)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    base = (s.slug or "encuesta")

    if format == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Respuestas"
        for row in rows:
            ws.append(row)
        bio = io.BytesIO()
        wb.save(bio)
        bio.seek(0)
        return StreamingResponse(
            bio,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.xlsx"'},
        )

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerows(rows)
    # UTF-8 BOM so Excel opens accented text correctly.
    data = buf.getvalue().encode("utf-8-sig")
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{base}-{stamp}.csv"'},
    )
