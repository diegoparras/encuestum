import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Survey, SurveyResponse, _utcnow
from app.schemas import GenerateQuestionsRequest, OverrideRequest, ResponseItem
from app.grading import extract_question_types, grade_response

router = APIRouter(prefix="/surveys", tags=["evaluation"])


async def _survey_or_404(sid, org_id, session):
    s = await session.get(Survey, sid)
    if not s or s.org_id != org_id:
        raise HTTPException(status_code=404, detail="Survey not found")
    return s


async def _response_or_404(sid, rid, session):
    r = await session.get(SurveyResponse, rid)
    if not r or r.survey_id != sid:
        raise HTTPException(status_code=404, detail="Response not found")
    return r


async def _grade_and_store(s, r, session):
    grade = await grade_response(
        evaluation=s.evaluation or {}, answers=r.answers or {},
        question_types=extract_question_types(s.json_schema), language=s.language or "es",
    )
    r.grade = grade
    r.score = grade.get("total")
    r.max_score = grade.get("max")
    r.needs_review = bool(grade.get("needs_review"))
    r.graded_at = _utcnow()
    session.add(r)
    return r


@router.post("/{sid}/responses/{rid}/grade", response_model=ResponseItem)
async def grade_one(sid: uuid.UUID, rid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not (s.evaluation or {}).get("enabled"):
        raise HTTPException(status_code=400, detail="Survey is not an assessment")
    r = await _response_or_404(sid, rid, session)
    await _grade_and_store(s, r, session)
    await session.commit()
    await session.refresh(r)
    return ResponseItem.from_model(r)


@router.post("/{sid}/grade-all")
async def grade_all(sid: uuid.UUID, only_ungraded: bool = True, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not (s.evaluation or {}).get("enabled"):
        raise HTTPException(status_code=400, detail="Survey is not an assessment")
    stmt = select(SurveyResponse).where(SurveyResponse.survey_id == sid)
    if only_ungraded:
        stmt = stmt.where(SurveyResponse.graded_at.is_(None))
    responses = (await session.scalars(stmt)).all()
    graded = 0
    for r in responses:
        try:
            await _grade_and_store(s, r, session)
            graded += 1
        except Exception:
            r.needs_review = True
            session.add(r)
    await session.commit()
    return {"graded": graded, "total": len(responses)}


@router.get("/{sid}/review-queue", response_model=List[ResponseItem])
async def review_queue(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == sid)
            .where(SurveyResponse.needs_review == True)  # noqa: E712
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).all()
    return [ResponseItem.from_model(r) for r in responses]


@router.post("/{sid}/responses/{rid}/override", response_model=ResponseItem)
async def override_grade(sid: uuid.UUID, rid: uuid.UUID, payload: OverrideRequest, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    r = await _response_or_404(sid, rid, session)
    grade = dict(r.grade or {})
    questions = [dict(q) for q in grade.get("questions", [])]
    if payload.awards:
        for q in questions:
            if q["name"] in payload.awards:
                pts = float(q.get("points", 0) or 0)
                awarded = max(0.0, min(pts, float(payload.awards[q["name"]])))
                q["awarded"] = round(awarded, 3)
                q["verdict"] = "correct" if awarded >= pts and pts > 0 else "incorrect" if awarded <= 0 else "partial"
                q["needs_review"] = False
    total = payload.total if payload.total is not None else sum(float(q.get("awarded", 0) or 0) for q in questions)
    max_total = float(grade.get("max", 0) or 0)
    grade["questions"] = questions
    grade["total"] = round(float(total), 3)
    grade["percent"] = round(total / max_total * 100.0, 1) if max_total > 0 else 0.0
    grade["needs_review"] = (not payload.clear_review) and grade.get("needs_review", False)
    grade["overridden"] = True
    if payload.note:
        grade["override_note"] = payload.note
    r.grade = grade
    r.score = grade["total"]
    r.needs_review = grade["needs_review"]
    if r.graded_at is None:
        r.graded_at = _utcnow()
    session.add(r)
    await session.commit()
    await session.refresh(r)
    return ResponseItem.from_model(r)


@router.get("/{sid}/analytics")
async def analytics(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (await session.scalars(select(SurveyResponse).where(SurveyResponse.survey_id == sid))).all()
    graded = [r for r in responses if r.grade]
    buckets = [0] * 10
    percents, passed = [], 0
    for r in graded:
        pct = float((r.grade or {}).get("percent", 0) or 0)
        percents.append(pct)
        buckets[min(9, int(pct // 10))] += 1
        if (r.grade or {}).get("passed"):
            passed += 1
    q_agg: dict = {}
    for r in graded:
        for q in (r.grade or {}).get("questions", []):
            a = q_agg.setdefault(q.get("name"), {"name": q.get("name"), "n": 0, "sum_awarded": 0.0, "sum_points": 0.0, "correct": 0})
            a["n"] += 1
            a["sum_awarded"] += float(q.get("awarded", 0) or 0)
            a["sum_points"] += float(q.get("points", 0) or 0)
            if q.get("verdict") == "correct":
                a["correct"] += 1
    per_question = [
        {"name": a["name"], "responses": a["n"],
         "avg_score_pct": round(a["sum_awarded"] / a["sum_points"] * 100, 1) if a["sum_points"] > 0 else None,
         "correct_rate": round(a["correct"] / a["n"] * 100, 1) if a["n"] else 0}
        for a in q_agg.values()
    ]
    return {
        "is_evaluation": bool((s.evaluation or {}).get("enabled")),
        "responses": len(responses), "graded": len(graded),
        "needs_review": sum(1 for r in responses if r.needs_review),
        "avg_percent": round(sum(percents) / len(percents), 1) if percents else None,
        "pass_rate": round(passed / len(graded) * 100, 1) if graded else None,
        "score_distribution": buckets, "per_question": per_question,
    }


def _open_titles(schema: dict) -> dict:
    out = {}
    for p in (schema or {}).get("pages", []) or []:
        for el in p.get("elements", []) or []:
            if el.get("type") in ("comment", "text") and el.get("inputType") != "email" and el.get("name"):
                out[el["name"]] = el.get("title") or el["name"]
    return out


@router.get("/{sid}/insights")
async def get_insights(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    return s.insights or {"questions": []}


@router.post("/{sid}/insights")
async def generate_insights(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    from app.llm_calls import summarize_open_responses
    titles = _open_titles(s.json_schema)
    if not titles:
        raise HTTPException(status_code=400, detail="No open-text questions to summarize")
    responses = (await session.scalars(select(SurveyResponse).where(SurveyResponse.survey_id == sid))).all()
    out = []
    for name, title in titles.items():
        answers = [v.strip() for r in responses if isinstance((v := (r.answers or {}).get(name)), str) and v.strip()]
        if not answers:
            continue
        summary = await summarize_open_responses(question_title=title, language=s.language or "es", answers=answers)
        out.append({"name": name, "title": title, "n": len(answers), "summary": summary})
    insights = {"generated_at": _utcnow().isoformat(), "questions": out}
    s.insights = insights
    session.add(s)
    await session.commit()
    return insights


@router.post("/{sid}/generate-questions")
async def generate_questions(sid: uuid.UUID, payload: GenerateQuestionsRequest, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    from app.llm_calls import generate_survey_questions
    return await generate_survey_questions(
        topic=payload.topic, count=max(1, min(20, payload.count)), types=payload.types,
        language=payload.language, difficulty=payload.difficulty, context=payload.context,
    )
