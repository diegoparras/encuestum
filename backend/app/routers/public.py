import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.models import Survey, SurveyResponse, SurveyInvitee
from app.schemas import (
    GradeQuestionRequest,
    PublicSurvey,
    ResultLookupRequest,
    SubmitResponseRequest,
    SurveyAccessRequest,
    public_evaluation_meta,
)
from app.grading import extract_question_types, grade_deterministic, grade_response
from app.models import _utcnow
from app.security import create_purpose_token, read_purpose_token
from app.webhooks import schedule_response_delivery

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/public", tags=["public"])

_ACCESS_PURPOSE = "survey_access"


def _branding_theme(theme: dict | None) -> dict | None:
    """Only the visual bits are safe to show on the access gate (no schema)."""
    return theme


async def _find_invitee(session: AsyncSession, survey_id, email: str, code: str) -> SurveyInvitee | None:
    email = (email or "").strip().lower()
    code = (code or "").strip().upper()
    if not email or not code:
        return None
    inv = (
        await session.scalars(
            select(SurveyInvitee).where(
                SurveyInvitee.survey_id == survey_id, SurveyInvitee.email == email
            )
        )
    ).first()
    if inv and inv.code.upper() == code:
        return inv
    return None


def _valid_access(s: Survey, token: str | None) -> bool:
    """Public surveys need no token; gated ones require a token minted for this slug."""
    if getattr(s, "access_mode", "public") == "public":
        return True
    if not token:
        return False
    data = read_purpose_token(_ACCESS_PURPOSE, token)
    return bool(data and data.get("slug") == s.slug)


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


def _public_payload(s: Survey, available: bool, reason: str | None, gated: bool) -> PublicSurvey:
    show_form = available and not gated
    return PublicSurvey(
        slug=s.slug, title=s.title, language=s.language,
        json_schema=(s.json_schema or {}) if show_form else {},
        theme=s.theme,  # theme carries branding; safe to show on the gate
        evaluation=public_evaluation_meta(s.evaluation) if show_form else None,
        available=available, closed_reason=reason,
        access_mode=getattr(s, "access_mode", "public"), gated=gated,
        thankyou_message=getattr(s, "thankyou_message", None),
        redirect_url=getattr(s, "redirect_url", None),
    )


@router.get("/{slug}", response_model=PublicSurvey)
async def get_public_survey(
    slug: str, access_token: str | None = None, session: AsyncSession = Depends(get_session)
):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    gated = available and not _valid_access(s, access_token)
    return _public_payload(s, available, reason, gated)


@router.post("/{slug}/access")
async def survey_access(
    slug: str, payload: SurveyAccessRequest, session: AsyncSession = Depends(get_session)
):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")

    mode = getattr(s, "access_mode", "public")
    token_data: dict = {"slug": s.slug, "mode": mode}

    if mode == "public":
        pass
    elif mode == "pin":
        if not s.access_pin or (payload.pin or "").strip() != s.access_pin:
            raise HTTPException(status_code=403, detail="Clave incorrecta")
    elif mode == "list":
        inv = await _find_invitee(session, s.id, payload.email or "", payload.code or "")
        if not inv:
            raise HTTPException(status_code=403, detail="Email o código inválido")
        if inv.used_at is None:
            inv.used_at = _utcnow()
            session.add(inv)
            await session.commit()
        token_data.update({"email": inv.email, "code": inv.code})
    else:
        raise HTTPException(status_code=400, detail="Modo de acceso desconocido")

    token = create_purpose_token(_ACCESS_PURPOSE, token_data, ttl_hours=12)
    return {"access_token": token, "survey": _public_payload(s, True, None, gated=False)}


@router.post("/{slug}/submit", status_code=201)
async def submit(slug: str, payload: SubmitResponseRequest, session: AsyncSession = Depends(get_session)):
    s = await _visible(slug, session)
    available, reason = await _availability(s, session)
    if not available:
        raise HTTPException(status_code=403, detail=reason or "Esta encuesta está cerrada.")

    # Gated surveys require a valid access token; capture respondent identity.
    resp_email = resp_code = None
    if getattr(s, "access_mode", "public") != "public":
        if not _valid_access(s, payload.access_token):
            raise HTTPException(status_code=403, detail="Necesitás acceso para responder esta encuesta.")
        data = read_purpose_token(_ACCESS_PURPOSE, payload.access_token or "") or {}
        resp_email, resp_code = data.get("email"), data.get("code")

    r = SurveyResponse(
        survey_id=s.id, answers=payload.answers or {}, completed=payload.completed, meta=payload.meta,
        respondent_email=resp_email, respondent_code=resp_code,
    )
    session.add(r)
    await session.commit()

    evaluation = s.evaluation or {}
    grade = None
    if evaluation.get("enabled"):
        try:
            from app.ai_config import resolve_provider
            from app.ai_usage import track_ai_call
            provider = await resolve_provider(session, s.org_id)
            async with track_ai_call(session, provider, s.org_id, "grade", s.id):
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
    # Email the owner(s) if configured (fire-and-forget).
    if getattr(s, "notify_emails", None):
        from app.notify import schedule_response_notification
        schedule_response_notification(
            s.notify_emails, s.title, s.id, await _response_count(s.id, session)
        )

    if grade is None:
        return {"id": str(r.id), "status": "recorded"}

    # Whether the respondent sees their correction now depends on results_mode.
    results_mode = getattr(s, "results_mode", "immediate")
    if results_mode == "immediate":
        return {"id": str(r.id), "status": "graded",
                "result": _respondent_view(grade, evaluation, s.json_schema or {})}
    if results_mode == "on_release":
        return {"id": str(r.id), "status": "recorded", "results_pending": True,
                "can_check": getattr(s, "access_mode", "public") == "list"}
    # never
    return {"id": str(r.id), "status": "recorded"}


@router.post("/{slug}/result")
async def lookup_result(
    slug: str, payload: ResultLookupRequest, session: AsyncSession = Depends(get_session)
):
    """A respondent (email-list access) comes back with their code to see their
    correction — once the owner has released results (or immediately)."""
    s = await _visible(slug, session)
    if getattr(s, "access_mode", "public") != "list":
        raise HTTPException(status_code=404, detail="Esta encuesta no permite consultar resultados")
    inv = await _find_invitee(session, s.id, payload.email, payload.code)
    if not inv:
        raise HTTPException(status_code=403, detail="Email o código inválido")

    results_mode = getattr(s, "results_mode", "immediate")
    if results_mode == "never":
        raise HTTPException(status_code=403, detail="Los resultados no están disponibles.")
    if results_mode == "on_release" and not getattr(s, "results_released", False):
        return {"status": "pending", "detail": "Los resultados todavía no fueron publicados."}

    r = (
        await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == s.id, SurveyResponse.respondent_code == inv.code)
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).first()
    if not r:
        raise HTTPException(status_code=404, detail="No encontramos tu respuesta")
    if not r.grade:
        return {"status": "pending", "detail": "Tu respuesta todavía no fue corregida."}
    return {"status": "graded", "result": _respondent_view(r.grade, s.evaluation or {}, s.json_schema or {})}


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
