import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.models import Survey, SurveyResponse
from app.schemas import GradeQuestionRequest, PublicSurvey, SubmitResponseRequest, public_evaluation_meta
from app.grading import extract_question_types, grade_deterministic, grade_response
from app.models import _utcnow
from app.webhooks import schedule_response_delivery

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/public", tags=["public"])


async def _visible(slug: str, session: AsyncSession) -> Survey:
    """A survey that has been published at least once (published or closed).
    Drafts / unknown slugs are 404 — they never existed publicly."""
    s = await session.scalar(select(Survey).where(Survey.slug == slug))
    if not s or s.status == "draft":
        raise HTTPException(status_code=404, detail="Survey not available")
    return s


async def _response_count(survey_id, session: AsyncSession) -> int:
    from sqlalchemy import func

    return int(
        await session.scalar(
            select(func.count(SurveyResponse.id)).where(SurveyResponse.survey_id == survey_id)
        )
        or 0
    )


async def _availability(s: Survey, session: AsyncSession) -> tuple[bool, str | None]:
    from datetime import timezone

    if s.status == "closed":
        return False, "Esta encuesta fue cerrada."
    if s.closes_at is not None:
        closes = s.closes_at
        if closes.tzinfo is None:  # SQLite returns naive datetimes
            closes = closes.replace(tzinfo=timezone.utc)
        if _utcnow() > closes:
            return False, "Esta encuesta cerró por fecha."
    if s.max_responses:
        if await _response_count(s.id, session) >= s.max_responses:
            return False, "Esta encuesta alcanzó el máximo de respuestas."
    return True, None


def _titles(schema: dict) -> dict:
    out = {}
    for p in (schema or {}).get("pages", []) or []:
        for el in p.get("elements", []) or []:
            if el.get("name"):
                out[el["name"]] = el.get("title") or el["name"]
    return out


def _respondent_view(grade: dict, evaluation: dict, schema: dict) -> dict:
    titles = _titles(schema)
    show = bool(evaluation.get("showScoreToRespondent", True))
    questions = [
        {
            "title": titles.get(q["name"], q["name"]),
            "verdict": q.get("verdict"), "awarded": q.get("awarded"),
            "points": q.get("points"), "feedback": q.get("feedback"),
        }
        for q in grade.get("questions", [])
    ]
    view = {"questions": questions, "needs_review": grade.get("needs_review", False)}
    if show:
        view.update({k: grade.get(k) for k in ("total", "max", "percent", "passed")})
    return view


@router.get("/{slug}", response_model=PublicSurvey)
async def get_public_survey(slug: str, session: AsyncSession = Depends(get_session)):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    return PublicSurvey(
        slug=s.slug, title=s.title, language=s.language,
        # When closed, don't ship the form — just the reason.
        json_schema=(s.json_schema or {}) if available else {},
        theme=s.theme,
        evaluation=public_evaluation_meta(s.evaluation) if available else None,
        available=available, closed_reason=reason,
    )


@router.post("/{slug}/submit", status_code=201)
async def submit(slug: str, payload: SubmitResponseRequest, session: AsyncSession = Depends(get_session)):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")
    r = SurveyResponse(
        survey_id=s.id, answers=payload.answers or {}, completed=payload.completed, meta=payload.meta
    )
    session.add(r)
    await session.commit()

    evaluation = s.evaluation or {}
    grade = None
    if evaluation.get("enabled"):
        try:
            grade = await grade_response(
                evaluation=evaluation, answers=r.answers,
                question_types=extract_question_types(s.json_schema), language=s.language or "es",
            )
            r.grade = grade
            r.score = grade.get("total")
            r.max_score = grade.get("max")
            r.needs_review = bool(grade.get("needs_review"))
            r.graded_at = _utcnow()
            session.add(r)
            await session.commit()
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("grading failed for %s: %s", r.id, exc)
            r.needs_review = True
            session.add(r)
            await session.commit()
            grade = None

    # Fire webhooks with the final (graded) state — never blocks the respondent.
    schedule_response_delivery(s.id, r.id)

    if grade is None:
        return {"id": str(r.id), "status": "recorded"}
    if evaluation.get("feedbackTiming", "onComplete") == "never":
        return {"id": str(r.id), "status": "recorded"}
    return {"id": str(r.id), "status": "graded", "result": _respondent_view(grade, evaluation, s.json_schema or {})}


@router.post("/{slug}/grade-question")
async def grade_question(slug: str, payload: GradeQuestionRequest, session: AsyncSession = Depends(get_session)):
    s = await _visible(slug, session)
    evaluation = s.evaluation or {}
    if not evaluation.get("enabled") or evaluation.get("feedbackTiming") != "immediate":
        raise HTTPException(status_code=404, detail="Immediate feedback not enabled")
    qcfg = (evaluation.get("questions") or {}).get(payload.name)
    if not qcfg or not qcfg.get("gradable"):
        raise HTTPException(status_code=404, detail="Question not gradable")

    points = float(qcfg.get("points", 1) or 0)
    qtype = extract_question_types(s.json_schema).get(payload.name, "text")
    try:
        if qcfg.get("grader", "auto") == "llm":
            from app.llm_calls import grade_open_answer
            ans = payload.answer
            student = ", ".join(str(a) for a in ans) if isinstance(ans, list) else ("" if ans is None else str(ans))
            raw = await grade_open_answer(
                language=s.language or "es", question_title=qcfg.get("title", payload.name),
                model_answer=qcfg.get("modelAnswer", ""), key_concepts=qcfg.get("keyConcepts", []),
                rubric=qcfg.get("rubric", []), max_points=points, student_answer=student,
            )
            awarded = max(0.0, min(points, float(raw.get("score", 0) or 0)))
            return {"name": payload.name, "verdict": raw.get("verdict"), "awarded": round(awarded, 3),
                    "points": points, "feedback": raw.get("feedback", "")}
        res = grade_deterministic(qcfg, qtype, payload.answer)
        return {"name": payload.name, "verdict": res.get("verdict"), "awarded": res.get("awarded"),
                "points": points, "feedback": res.get("feedback", "")}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("live grade failed: %s", exc)
        raise HTTPException(status_code=502, detail="No se pudo corregir ahora")
