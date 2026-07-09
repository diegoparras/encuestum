"""Hybrid grading engine for survey/assessment responses.

Deterministic question types (single/multiple choice, boolean, exact text,
numeric with tolerance) are graded in pure Python — free and instant, no LLM
call. Open-ended questions are graded by the LLM against a rubric, optionally
with a second "double-pass" opinion; disagreement, low confidence, prompt
injection, or a blank answer route the response to the human-review queue
instead of trusting a guessed score.

The ``grader`` callable is injected so the aggregation logic can be unit-tested
without a real model.
"""

from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.llm_calls import grade_open_answer

GraderFn = Callable[..., Awaitable[dict]]

# Passes disagree if scores differ by more than this fraction of the max points.
_DISAGREE_FRACTION = 0.2


def extract_question_types(json_schema: Optional[dict]) -> Dict[str, str]:
    """Map question name → normalized type ('email' distinguished from 'text')."""
    types: Dict[str, str] = {}
    if not isinstance(json_schema, dict):
        return types
    for page in json_schema.get("pages", []) or []:
        for el in page.get("elements", []) or []:
            name = el.get("name")
            if not name:
                continue
            t = el.get("type")
            if t == "text" and el.get("inputType") == "email":
                t = "email"
            types[name] = t or "text"
    return types


def _normalize_text(value: Any, case_sensitive: bool) -> str:
    s = "" if value is None else str(value)
    s = s.strip()
    return s if case_sensitive else s.lower()


def _as_number(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _verdict(awarded: float, points: float) -> str:
    if points <= 0:
        return "ungraded"
    if awarded >= points:
        return "correct"
    if awarded <= 0:
        return "incorrect"
    return "partial"


def grade_deterministic(qcfg: dict, qtype: str, answer: Any) -> dict:
    """Grade a single deterministic question. Returns a per-question result."""
    points = float(qcfg.get("points", 1) or 0)
    blank = answer is None or (isinstance(answer, (list, str)) and len(answer) == 0)

    # Image-choice questions grade exactly like their text counterparts (choice
    # values are the option labels): multi-select → checkbox, single → radiogroup.
    if qtype == "imagepicker":
        qtype = "checkbox" if qcfg.get("multiSelect") else "radiogroup"

    awarded = 0.0
    detail = ""

    if blank:
        detail = "Sin respuesta."
    elif qtype == "checkbox":
        correct = qcfg.get("correct") or []
        correct_set = {str(c) for c in correct}
        answer_set = {str(a) for a in (answer if isinstance(answer, list) else [answer])}
        hits = len(correct_set & answer_set)
        wrong = len(answer_set - correct_set)
        if qcfg.get("partialCredit"):
            frac = (hits - wrong) / max(1, len(correct_set))
            awarded = max(0.0, min(1.0, frac)) * points
            detail = f"{hits} correctas, {wrong} incorrectas."
        else:
            awarded = points if answer_set == correct_set else 0.0
    elif qtype in ("radiogroup", "dropdown", "text", "email", "comment"):
        correct = qcfg.get("correct")
        acceptable = correct if isinstance(correct, list) else [correct]
        cs = bool(qcfg.get("caseSensitive"))
        norm_answer = _normalize_text(answer, cs)
        awarded = (
            points
            if any(_normalize_text(c, cs) == norm_answer for c in acceptable)
            else 0.0
        )
    elif qtype in ("rating", "number"):
        correct_n = _as_number(qcfg.get("correct"))
        answer_n = _as_number(answer)
        tol = float(qcfg.get("tolerance", 0) or 0)
        if correct_n is not None and answer_n is not None:
            awarded = points if abs(answer_n - correct_n) <= tol else 0.0
    elif qtype == "boolean":
        awarded = points if bool(answer) == bool(qcfg.get("correct")) else 0.0
    else:
        # Unknown deterministic type — defer to a human rather than guess.
        return {
            "awarded": 0.0,
            "verdict": "ungraded",
            "criteria": [],
            "feedback": "Tipo de pregunta no corregible automáticamente.",
            "evidence": [],
            "confidence": 0.0,
            "needs_review": True,
            "injection_flag": False,
        }

    return {
        "awarded": round(awarded, 3),
        "verdict": _verdict(awarded, points),
        "criteria": [],
        "feedback": detail,
        "evidence": [],
        "confidence": 1.0,
        "needs_review": bool(blank and qcfg.get("required", False)),
        "injection_flag": False,
    }


def build_ai_criteria(ai: Optional[dict]) -> Optional[str]:
    """Turn the teacher's grading wizard answers into a criteria block for the
    LLM grader. Returns None when disabled or empty."""
    if not ai or not ai.get("enabled"):
        return None
    parts: List[str] = []
    strict = (ai.get("strictness") or "").strip()
    if strict:
        parts.append(f"Nivel de exigencia: {strict}.")
    focus = ai.get("focus") or []
    if isinstance(focus, list) and focus:
        parts.append("Priorizá especialmente: " + ", ".join(str(f) for f in focus) + ".")
    tone = (ai.get("tone") or "").strip()
    if tone:
        parts.append(f"Tono del feedback: {tone}.")
    instr = (ai.get("instructions") or "").strip()
    if instr:
        parts.append(instr)
    text = "\n".join(parts).strip()
    return text or None


def _combine_passes(passes: List[dict], points: float, review_threshold: float) -> dict:
    scores = [float(p.get("score", 0) or 0) for p in passes]
    verdicts = [p.get("verdict") for p in passes]
    awarded = sum(scores) / len(scores)
    awarded = max(0.0, min(points, awarded))

    disagree = (max(scores) - min(scores)) > _DISAGREE_FRACTION * max(points, 1)
    disagree = disagree or len(set(verdicts)) > 1

    rep = max(passes, key=lambda p: float(p.get("confidence", 0) or 0))
    needs_review = (
        disagree
        or any(bool(p.get("needs_review")) for p in passes)
        or any(bool(p.get("injection_flag")) for p in passes)
        or float(rep.get("confidence", 0) or 0) < review_threshold
    )
    return {
        "awarded": round(awarded, 3),
        "verdict": _verdict(awarded, points),
        "criteria": rep.get("criteria", []),
        "feedback": rep.get("feedback", ""),
        "evidence": rep.get("evidence", []),
        "confidence": float(rep.get("confidence", 0) or 0),
        "needs_review": needs_review,
        "injection_flag": any(bool(p.get("injection_flag")) for p in passes),
        "passes": passes if len(passes) > 1 else None,
    }


async def grade_response(
    *,
    evaluation: dict,
    answers: dict,
    question_types: Dict[str, str],
    language: str = "es",
    grader: Optional[GraderFn] = None,
) -> dict:
    """Grade one response against the survey's evaluation config.

    Returns the aggregate grade dict stored on ``SurveyResponseModel.grade``.
    ``grader`` defaults to the real LLM call; injectable for tests.
    """
    # Resolve at call time (not as a default arg) so tests can monkeypatch the
    # module-level ``grade_open_answer``.
    if grader is None:
        grader = grade_open_answer
    q_configs: Dict[str, dict] = (evaluation or {}).get("questions", {}) or {}
    review_threshold = float((evaluation or {}).get("reviewThreshold", 0.6) or 0.6)
    double_pass = bool((evaluation or {}).get("doublePass", False))
    passing_pct = float((evaluation or {}).get("passingScore", 60) or 0)
    ai_criteria = build_ai_criteria((evaluation or {}).get("aiCriteria"))

    results: List[dict] = []
    total = 0.0
    max_total = 0.0
    used_llm = False
    used_auto = False

    for name, qcfg in q_configs.items():
        if not qcfg.get("gradable"):
            continue
        points = float(qcfg.get("points", 1) or 0)
        qtype = question_types.get(name, "text")
        answer = answers.get(name)
        grader_mode = qcfg.get("grader", "auto")

        if grader_mode == "llm":
            used_llm = True
            student_answer = _stringify_answer(answer)
            passes: List[dict] = []
            n_passes = 2 if double_pass else 1
            try:
                for _ in range(n_passes):
                    passes.append(
                        await grader(
                            language=language,
                            question_title=qcfg.get("title", name),
                            model_answer=qcfg.get("modelAnswer", ""),
                            key_concepts=qcfg.get("keyConcepts", []),
                            rubric=qcfg.get("rubric", []),
                            max_points=points,
                            student_answer=student_answer,
                            criteria=ai_criteria,
                        )
                    )
                combined = _combine_passes(passes, points, review_threshold)
            except Exception:
                # An LLM failure on one open question must not void the whole
                # response's grade — defer just this one to human review.
                combined = {
                    "awarded": 0.0,
                    "verdict": "ungraded",
                    "criteria": [],
                    "feedback": "No se pudo corregir automáticamente; pendiente de revisión.",
                    "evidence": [],
                    "confidence": 0.0,
                    "needs_review": True,
                    "injection_flag": False,
                }
        else:
            used_auto = True
            combined = grade_deterministic(qcfg, qtype, answer)

        awarded = float(combined.get("awarded", 0) or 0)
        total += awarded
        max_total += points

        results.append(
            {
                "name": name,
                "type": qtype,
                "grader": grader_mode,
                "points": points,
                **combined,
            }
        )

    percent = (total / max_total * 100.0) if max_total > 0 else 0.0
    needs_review = any(r.get("needs_review") for r in results)

    graded_by = "+".join(
        [x for x, on in [("auto", used_auto), ("llm", used_llm)] if on]
    ) or "none"

    model_name = None
    if used_llm:
        try:
            from app.llm import _model

            model_name = _model()
        except Exception:
            model_name = None

    return {
        "total": round(total, 3),
        "max": round(max_total, 3),
        "percent": round(percent, 1),
        "passed": percent >= passing_pct if max_total > 0 else None,
        "questions": results,
        "needs_review": needs_review,
        "graded_by": graded_by,
        "model": model_name,
        "overridden": False,
        "version": 1,
    }


def _stringify_answer(answer: Any) -> str:
    if answer is None:
        return ""
    if isinstance(answer, list):
        return ", ".join(str(a) for a in answer)
    return str(answer)
