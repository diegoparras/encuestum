import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field as PydField
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.hygiene import counted_only
from app.models import Survey, SurveyResponse, _utcnow
from app.schemas import GenerateQuestionsRequest, OverrideRequest, ResponseItem
from app.grading import (
    extract_question_choices,
    extract_question_types,
    grade_response,
)

router = APIRouter(prefix="/surveys", tags=["evaluation"])


async def _survey_or_404(sid, org_id, session):
    s = await session.get(Survey, sid)
    if not s or s.org_id != org_id or s.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Survey not found")
    return s


async def _response_or_404(sid, rid, session):
    r = await session.get(SurveyResponse, rid)
    if not r or r.survey_id != sid:
        raise HTTPException(status_code=404, detail="Response not found")
    return r


def _verdict_for(awarded: float, pts: float) -> str:
    return "correct" if awarded >= pts and pts > 0 else "incorrect" if awarded <= 0 else "partial"


def _recalcular_totales(grade: dict, evaluation: dict | None) -> dict:
    """Total, porcentaje y aprobado coherentes con lo que hay en `questions`.

    Antes el override cambiaba el total pero dejaba `passed` como estaba: una
    nota subida a mano de 40 a 90 seguía contando como desaprobada en las
    estadísticas. Un total fijado a mano (`manual_total`) pisa la suma."""
    questions = grade.get("questions", []) or []
    max_total = float(grade.get("max", 0) or 0)
    total = sum(float(q.get("awarded", 0) or 0) for q in questions)
    if grade.get("manual_total") is not None:
        total = float(grade["manual_total"])
        if max_total > 0:
            total = max(0.0, min(max_total, total))
    grade["total"] = round(total, 3)
    pct = (total / max_total * 100.0) if max_total > 0 else 0.0
    grade["percent"] = round(pct, 1)
    passing = float((evaluation or {}).get("passingScore", 60) or 0)
    grade["passed"] = pct >= passing if max_total > 0 else None
    return grade


def _conservar_ediciones(anterior: dict | None, nuevo: dict, evaluation: dict | None = None) -> dict:
    """Recorregir no puede borrar lo que hizo un humano.

    Volver a corregir reemplaza el `grade` entero. Lo que un docente puso a
    mano es trabajo suyo y antes desaparecía sin dejar rastro:

    * el comentario editado de una pregunta (`feedback_edited`);
    * el puntaje asignado a mano a una pregunta (`manual_award`), que se
      conserva acotado a los puntos que la pregunta vale AHORA;
    * el total fijado a mano (`manual_total`) y la nota del override.

    La aprobación de comentarios, en cambio, NO se conserva: la corrección
    cambió, así que el visto bueno anterior ya no dice nada sobre esta."""
    previas = {q.get("name"): q for q in (anterior or {}).get("questions", []) or []}
    hubo_manual = False
    for q in nuevo.get("questions", []) or []:
        prev = previas.get(q.get("name"))
        if not prev:
            continue
        texto = str(prev.get("feedback_edited") or "").strip()
        if texto:
            q["feedback_edited"] = texto
        if prev.get("manual_award"):
            pts = float(q.get("points", 0) or 0)
            awarded = max(0.0, min(pts, float(prev.get("awarded", 0) or 0)))
            q["awarded"] = round(awarded, 3)
            q["verdict"] = _verdict_for(awarded, pts)
            q["needs_review"] = False
            q["manual_award"] = True
            hubo_manual = True
    if (anterior or {}).get("manual_total") is not None:
        nuevo["manual_total"] = anterior["manual_total"]
        hubo_manual = True
    if hubo_manual:
        nuevo["overridden"] = True
        if (anterior or {}).get("override_note"):
            nuevo["override_note"] = anterior["override_note"]
        nuevo["needs_review"] = any(q.get("needs_review") for q in nuevo.get("questions", []) or [])
        _recalcular_totales(nuevo, evaluation)
    return nuevo


def _sin_ediciones_manuales(grade: dict | None) -> dict | None:
    """El `grade` anterior sin lo manual: para recorregir descartándolo."""
    if not grade:
        return grade
    g = dict(grade)
    g.pop("manual_total", None)
    g["questions"] = [
        {k: v for k, v in q.items() if k != "manual_award"} for q in g.get("questions", []) or []
    ]
    return g


async def _grade_and_store(s, r, session, *, source: str = "regrade", actor=None, discard_manual: bool = False):
    from app.audit import ensure_survey_version, record_grade_revision

    version = await ensure_survey_version(session, s)
    anterior = r.grade
    grade = await grade_response(
        evaluation=s.evaluation or {}, answers=r.answers or {},
        question_types=extract_question_types(s.json_schema),
        question_choices=extract_question_choices(s.json_schema),
        language=s.language or "es",
    )
    grade["graded_with_version"] = version.number
    base = _sin_ediciones_manuales(anterior) if discard_manual else anterior
    grade = _conservar_ediciones(base, grade, s.evaluation)
    r.grade = grade
    r.score = grade.get("total")
    r.max_score = grade.get("max")
    r.needs_review = bool(grade.get("needs_review"))
    r.graded_at = _utcnow()
    session.add(r)
    record_grade_revision(
        session, r, source=source, grade_before=anterior, actor=actor,
        survey_version_id=version.id,
        note="Se descartaron las correcciones manuales" if discard_manual and anterior else None,
    )
    return r


def _vino_de_un_lms(r: SurveyResponse) -> bool:
    """Si la respuesta tiene a dónde devolverle la nota.

    Son DOS orígenes, no uno: un `LtiResourceLink` (camino `mod_lti`, la nota
    vuelve por AGS) o un sitio del módulo nativo (camino `mod_encuestum`, la
    nota vuelve por el servicio web de Moodle). Filtrar sólo por `lti_link_id`
    excluía al módulo **por construcción**: una respuesta del módulo tiene
    `lti_link_id` en NULL siempre, y lo garantiza el motor con el CHECK
    `ck_survey_responses_un_solo_origen` (ver `app/models.py`). O sea que la
    instalación que la Fase A viene a habilitar -- sólo el módulo nativo --
    nunca republicaba una nota recorregida, y sin ningún error visible.

    Qué transporte le corresponde a cada una no se decide acá: lo decide
    `_origen` en `app/lti/ags.py`, que es el único lugar que lo sabe."""
    return r.lti_link_id is not None or r.mod_site_id is not None


def _agendar_nota(*response_ids: uuid.UUID) -> None:
    """Avisa al LMS de una nota que se corrigió o corrigió de nuevo fuera del
    submit original -- override manual, re-corrida individual o masiva.

    No se llama `_schedule_lti_score` porque no es sólo de LTI: `schedule_score`
    es el disparador único de los DOS transportes (AGS y el servicio web de
    `mod_encuestum`), y quién publica lo decide `_deliver`.

    Gateado en `LTI_ENABLED` **o** `MOD_ENABLED`, igual que el único otro
    trigger (`submit()`, vía `_lti_context` en `public.py`, que mira las dos):
    una respuesta puede seguir teniendo `lti_link_id`/`mod_site_id` mucho
    después de que la instancia apagara la integración -- ese dato no se borra
    solo -- y sin este chequeo una corrección manual sobre esa respuesta vieja
    seguiría mandando un POST saliente al LMS con la integración apagada.
    "Apagado" tiene que significar que nada de este módulo le habla al LMS, no
    sólo que no se generen links nuevos.

    Es un `or` y no un `and` de la bandera con el origen de cada respuesta
    porque la bandera fina la aplica `_origen` (`app/lti/ags.py`), que ya tiene
    la fila cargada y sabe por qué transporte iba a salir: con `MOD_ENABLED=1`
    y `LTI_ENABLED=0`, agendar una respuesta LTI acá no publica nada -- ese
    gate corta después, del lado del transporte.

    `schedule_score` ya vive detrás de un import perezoso en todos los otros
    puntos que la disparan (`public.py::submit`), así que se mantiene acá:
    importar `app.lti.ags` en el tope de este módulo lo cargaría siempre, la
    integración esté prendida o no."""
    ajustes = get_settings()
    if not (ajustes.lti_enabled or ajustes.mod_enabled):
        return
    from app.lti.ags import schedule_score

    for rid in response_ids:
        schedule_score(rid)


@router.post("/{sid}/responses/{rid}/grade", response_model=ResponseItem)
async def grade_one(sid: uuid.UUID, rid: uuid.UUID, discard_manual: bool = False, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Vuelve a corregir una respuesta. Lo que un docente corrigió a mano se
    conserva salvo `discard_manual=true`, y el cambio queda en el historial."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not (s.evaluation or {}).get("enabled"):
        raise HTTPException(status_code=400, detail="Survey is not an assessment")
    r = await _response_or_404(sid, rid, session)
    from app.ai_config import resolve_provider
    from app.ai_usage import track_ai_call
    provider = await resolve_provider(session, ctx.org.id)
    async with track_ai_call(session, provider, ctx.org.id, "grade", sid, ctx.user.id, response_id=r.id):
        await _grade_and_store(s, r, session, actor=ctx.user, discard_manual=discard_manual)
    await session.commit()
    await session.refresh(r)
    # Una corrección individual también puede corregir una nota que ya se
    # había mandado al LMS (o entregar la primera vez que quedó sin enviar --
    # ver el finding de "grade passback con un solo trigger" del review): sin
    # esto, Moodle se queda mostrando la nota vieja hasta que algo más la
    # dispare.
    if _vino_de_un_lms(r):
        _agendar_nota(r.id)
    return ResponseItem.from_model(r)


@router.post("/{sid}/grade-all")
async def grade_all(sid: uuid.UUID, only_ungraded: bool = True, discard_manual: bool = False, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Corrige (o vuelve a corregir) todas las respuestas. Las correcciones
    manuales se conservan salvo `discard_manual=true`; cada respuesta deja su
    revisión en el historial y su propio registro de consumo de IA."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    if not (s.evaluation or {}).get("enabled"):
        raise HTTPException(status_code=400, detail="Survey is not an assessment")
    stmt = counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
    if only_ungraded:
        stmt = stmt.where(SurveyResponse.graded_at.is_(None))
    responses = (await session.scalars(stmt)).all()
    from app.ai_config import resolve_provider
    from app.ai_usage import track_ai_call
    provider = await resolve_provider(session, ctx.org.id)
    graded = 0
    a_notificar: list[uuid.UUID] = []
    for r in responses:
        try:
            async with track_ai_call(session, provider, ctx.org.id, "grade", sid, ctx.user.id, response_id=r.id):
                await _grade_and_store(s, r, session, actor=ctx.user, discard_manual=discard_manual)
            graded += 1
            if _vino_de_un_lms(r):
                a_notificar.append(r.id)
        except Exception:
            r.needs_review = True
            session.add(r)
    from app.audit import record_event

    record_event(
        session, action="grades.regrade_all", org_id=ctx.org.id, actor=ctx.user, survey_id=sid,
        detail={"graded": graded, "total": len(responses), "only_ungraded": only_ungraded,
                "discard_manual": discard_manual},
    )
    await session.commit()
    # Recién después del commit: si se agendara adentro del loop, una
    # entrega en background podría leer la fila antes de que este commit la
    # persista.
    if a_notificar:
        _agendar_nota(*a_notificar)
    return {"graded": graded, "total": len(responses)}


@router.get("/{sid}/review-queue", response_model=List[ResponseItem])
async def review_queue(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
            .where(SurveyResponse.needs_review == True)  # noqa: E712
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).all()
    return [ResponseItem.from_model(r) for r in responses]


@router.post("/{sid}/responses/{rid}/override", response_model=ResponseItem)
async def override_grade(sid: uuid.UUID, rid: uuid.UUID, payload: OverrideRequest, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    r = await _response_or_404(sid, rid, session)
    anterior = r.grade
    grade = dict(r.grade or {})
    questions = [dict(q) for q in grade.get("questions", [])]
    if payload.feedback is not None:
        # Texto vacío = borrar la edición y volver al comentario original. Para
        # que no se vea nada está el visto bueno, no un comentario en blanco.
        for q in questions:
            if q["name"] in payload.feedback:
                texto = (payload.feedback[q["name"]] or "").strip()
                if texto:
                    q["feedback_edited"] = texto
                else:
                    q.pop("feedback_edited", None)
    if payload.approve_feedback is not None:
        grade["feedback_approved"] = bool(payload.approve_feedback)
    if payload.awards:
        for q in questions:
            if q["name"] in payload.awards:
                pts = float(q.get("points", 0) or 0)
                awarded = max(0.0, min(pts, float(payload.awards[q["name"]])))
                q["awarded"] = round(awarded, 3)
                q["verdict"] = _verdict_for(awarded, pts)
                q["needs_review"] = False
                # Marca de "lo puso un humano": recorregir lo respeta (ver
                # `_conservar_ediciones`).
                q["manual_award"] = True
    grade["questions"] = questions
    if payload.total is not None:
        grade["manual_total"] = float(payload.total)
    _recalcular_totales(grade, s.evaluation)
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
    from app.audit import record_grade_revision

    record_grade_revision(
        session, r, source="manual", grade_before=anterior, actor=ctx.user,
        survey_version_id=r.survey_version_id, note=payload.note,
    )
    await session.commit()
    await session.refresh(r)
    # El override es precisamente el workflow de `needs_review`: un docente
    # corrigiendo una nota de IA. Sin esto, esa corrección nunca llegaba al
    # libro de calificaciones del LMS -- Moodle seguía mostrando la nota
    # original.
    if _vino_de_un_lms(r):
        _agendar_nota(r.id)
    return ResponseItem.from_model(r)


@router.get("/{sid}/gradebook")
async def gradebook(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Per-respondent grades (planilla de notas). Identifica a cada persona por
    el invitado (access=list) y, si no hay, por lo que respondió (nombre/mail)."""
    from app.identity import identity_fields, respondent_identity
    from app.models import SurveyInvitee
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (
        await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid))
            .order_by(SurveyResponse.submitted_at.desc())
        )
    ).all()
    invitees = (
        await session.scalars(select(SurveyInvitee).where(SurveyInvitee.survey_id == sid))
    ).all()
    names = {i.code.upper(): (i.name or i.email) for i in invitees}
    emails = {i.code.upper(): i.email for i in invitees}

    passing = float((s.evaluation or {}).get("passingScore", 60) or 60)
    fields = identity_fields(s.json_schema or {})
    rows = []
    for r in responses:
        g = r.grade or {}
        code = (r.respondent_code or "").upper()
        pct = g.get("percent")
        # Sin invitado, la identidad sale de las propias respuestas.
        ans_name, ans_email = respondent_identity(s.json_schema or {}, r.answers, fields=fields)
        # Una respuesta sin puntaje posible (max_score 0) no está desaprobada:
        # está SIN EVALUAR. Contarla como reprobada ensucia las estadísticas.
        scorable = float(r.max_score or 0) > 0
        rows.append({
            "response_id": str(r.id),
            "name": names.get(code) or r.respondent_email or ans_name or ans_email or "Anónimo",
            "email": emails.get(code) or r.respondent_email or ans_email,
            "code": r.respondent_code,
            "score": r.score, "max_score": r.max_score,
            "percent": pct,
            "scorable": scorable,
            "passed": (scorable and pct is not None and float(pct) >= passing),
            "needs_review": r.needs_review,
            "graded": r.grade is not None,
            "submitted_at": r.submitted_at.isoformat(),
        })
    return {
        "is_evaluation": bool((s.evaluation or {}).get("enabled")),
        "passing_score": passing,
        "count": len(rows),
        "rows": rows,
    }


@router.get("/{sid}/analytics")
async def analytics(sid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    responses = (await session.scalars(counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid)))).all()
    # Solo entran a las estadísticas las respuestas realmente evaluables: una con
    # max_score 0 (p. ej. se respondió antes de que hubiera preguntas puntuadas)
    # no está desaprobada, está sin evaluar, y hundía el promedio y el % de
    # aprobación.
    graded = [r for r in responses if r.grade and float(r.max_score or 0) > 0]
    unscorable = sum(1 for r in responses if r.grade and float(r.max_score or 0) <= 0)
    buckets = [0] * 10
    percents, passed = [], 0
    for r in graded:
        pct = float((r.grade or {}).get("percent", 0) or 0)
        percents.append(pct)
        buckets[min(9, int(pct // 10))] += 1
        if (r.grade or {}).get("passed"):
            passed += 1
    q_agg: dict = {}
    # Las respuestas dadas a cada pregunta, para el desglose por opción.
    dadas: Dict[str, list] = {}
    for r in graded:
        for nombre_q, valor in (r.answers or {}).items():
            dadas.setdefault(nombre_q, []).append(valor)
        for q in (r.grade or {}).get("questions", []):
            a = q_agg.setdefault(q.get("name"), {"name": q.get("name"), "n": 0, "sum_awarded": 0.0, "sum_points": 0.0, "correct": 0})
            a["n"] += 1
            a["sum_awarded"] += float(q.get("awarded", 0) or 0)
            a["sum_points"] += float(q.get("points", 0) or 0)
            if q.get("verdict") == "correct":
                a["correct"] += 1
    # El título real de cada pregunta. La tabla listaba el nombre interno
    # (`radiogroup_4`), que no le dice nada a quien corrige: para saber de qué
    # pregunta hablaba había que ir a buscarla al editor.
    q_configs_ev: dict = (s.evaluation or {}).get("questions", {}) or {}
    ficha = {}
    nro = 0
    for page in (s.json_schema or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            nombre = el.get("name") if isinstance(el, dict) else None
            # Las piezas de media acompañan a una pregunta, no son una pregunta:
            # numerarlas correría todo respecto de lo que ve quien responde.
            if not nombre or nombre.endswith("__img") or nombre.endswith("__vid"):
                continue
            nro += 1
            ficha[nombre] = (nro, el.get("title") or nombre, el.get("type") or "")
    # El número es la posición en la ENCUESTA, no un contador de esta tabla: acá
    # sólo aparecen las preguntas puntuadas, así que un 1,2,3 propio no
    # coincidiría con el editor ni con el orden que ve quien responde.
    vacio = (None, "", "")
    per_question = [
        {"name": a["name"],
         "number": ficha.get(a["name"], vacio)[0],
         "title": ficha.get(a["name"], (None, a["name"], ""))[1],
         "type": ficha.get(a["name"], vacio)[2],
         "breakdown": desglose_por_opcion(
             q_configs_ev.get(a["name"], {}) or {},
             ficha.get(a["name"], vacio)[2],
             dadas.get(a["name"], []),
         ),
         "responses": a["n"],
         "avg_score_pct": round(a["sum_awarded"] / a["sum_points"] * 100, 1) if a["sum_points"] > 0 else None,
         "correct_rate": round(a["correct"] / a["n"] * 100, 1) if a["n"] else 0}
        for a in q_agg.values()
    ]
    # En el orden de la encuesta: el agregado viene en el orden de la corrección,
    # que no tiene por qué ser el mismo.
    per_question.sort(key=lambda q: (q["number"] is None, q["number"] or 0))
    return {
        "is_evaluation": bool((s.evaluation or {}).get("enabled")),
        "responses": len(responses), "graded": len(graded),
        "unscorable": unscorable,
        "needs_review": sum(1 for r in responses if r.needs_review),
        "avg_percent": round(sum(percents) / len(percents), 1) if percents else None,
        "pass_rate": round(passed / len(graded) * 100, 1) if graded else None,
        "score_distribution": buckets, "per_question": per_question,
    }


# Tipos donde contar respuestas tiene sentido: hay un conjunto cerrado de
# opciones. En una pregunta abierta cada respuesta es distinta y el conteo no
# diría nada.
TIPOS_CON_OPCIONES = {"radiogroup", "checkbox", "dropdown", "boolean", "imagepicker", "rating"}

# Cuántas opciones se devuelven como mucho. Un `rating` de 0 a 10 ya son once;
# más que eso deja de leerse de un vistazo.
MAX_OPCIONES = 12


def desglose_por_opcion(qcfg: dict, qtype: str, respuestas: list) -> list:
    """Cuántas veces se eligió cada opción, y cuál era la correcta.

    La tabla por pregunta dice "0% de acierto" y ahí se corta. La pregunta que
    sigue siempre es la misma -- ¿y qué contestaron entonces? -- y hoy hay que
    ir a mirar respuesta por respuesta para saberlo.

    Se cuenta sobre las respuestas dadas, no sobre las opciones configuradas:
    una opción que nadie eligió no aporta nada, y una respuesta que ya no está
    entre las opciones (la pregunta se editó después) igual hay que mostrarla."""
    if qtype not in TIPOS_CON_OPCIONES:
        return []

    correctas = qcfg.get("correct")
    if correctas is None:
        correctas = []
    elif not isinstance(correctas, list):
        correctas = [correctas]
    correctas = {_texto_opcion(c) for c in correctas}

    conteo: Dict[str, int] = {}
    for valor in respuestas:
        if valor is None or valor == "" or valor == []:
            continue
        # En opción múltiple cada marca cuenta por separado.
        elegidas = valor if isinstance(valor, list) else [valor]
        for v in elegidas:
            texto = _texto_opcion(v)
            if texto:
                conteo[texto] = conteo.get(texto, 0) + 1

    filas = [
        {"value": texto, "count": n, "correct": texto in correctas}
        for texto, n in conteo.items()
    ]
    # De la más elegida a la menos; a igual cantidad, alfabético, para que el
    # orden no baile entre dos cargas de la misma pantalla.
    filas.sort(key=lambda f: (-f["count"], f["value"]))
    return filas[:MAX_OPCIONES]


def _texto_opcion(v) -> str:
    if isinstance(v, bool):
        return "Sí" if v else "No"
    return str(v).strip()


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
    from app.ai_config import resolve_provider
    from app.ai_usage import track_ai_call, summary as usage_summary
    titles = _open_titles(s.json_schema)
    if not titles:
        raise HTTPException(status_code=400, detail="No open-text questions to summarize")
    responses = (await session.scalars(counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == sid)))).all()
    out = []
    provider = await resolve_provider(session, ctx.org.id)
    async with track_ai_call(session, provider, ctx.org.id, "insights", sid, ctx.user.id) as acc:
        for name, title in titles.items():
            answers = [v.strip() for r in responses if isinstance((v := (r.answers or {}).get(name)), str) and v.strip()]
            if not answers:
                continue
            question_summary = await summarize_open_responses(question_title=title, language=s.language or "es", answers=answers)
            out.append({"name": name, "title": title, "n": len(answers), "summary": question_summary})
    insights = {"generated_at": _utcnow().isoformat(), "questions": out, "usage": usage_summary(acc)}
    s.insights = insights
    session.add(s)
    await session.commit()
    return insights


@router.post("/{sid}/generate-questions")
async def generate_questions(sid: uuid.UUID, payload: GenerateQuestionsRequest, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    await _survey_or_404(sid, ctx.org.id, session)
    from app.llm_calls import generate_survey_questions
    from app.ai_config import resolve_provider
    from app.ai_usage import track_ai_call, summary

    provider = await resolve_provider(session, ctx.org.id)
    async with track_ai_call(session, provider, ctx.org.id, "generate", sid, ctx.user.id) as acc:
        data = await generate_survey_questions(
            topic=payload.topic, count=max(1, min(20, payload.count)), types=payload.types,
            language=payload.language, difficulty=payload.difficulty, context=payload.context,
        )
    return {**data, "usage": summary(acc)}


class ExplainRequest(BaseModel):
    """Pregunta a explicar. Se manda desde el editor, con lo que hay en pantalla:
    todavía puede no estar guardada."""

    title: str
    correct: List[str] = PydField(default_factory=list)
    wrong: List[str] = PydField(default_factory=list)


@router.post("/{sid}/explain-options")
async def explain_options(
    sid: uuid.UUID,
    payload: ExplainRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Redacta, con IA, por qué cada opción incorrecta no lo es.

    Se llama UNA vez por pregunta al construir (no una vez por alumno que se
    equivoca): el texto queda guardado en la encuesta, el autor lo revisa y lo
    lee todo el mundo. Un llamado en vez de uno por respuesta."""
    from app.ai_config import resolve_provider
    from app.ai_usage import track_ai_call
    from app.llm_calls import explain_wrong_options

    s = await _survey_or_404(sid, ctx.org.id, session)
    if not payload.wrong:
        return {"explanations": {}}

    provider = await resolve_provider(session, ctx.org.id)
    async with track_ai_call(session, provider, ctx.org.id, "explain", sid, ctx.user.id):
        out = await explain_wrong_options(
            language=s.language or "es",
            question=payload.title,
            correct=payload.correct,
            wrong=payload.wrong,
        )
    # Se devuelve como mapa opción -> texto, que es como lo guarda el editor.
    pedidas = {w for w in payload.wrong}
    mapa = {
        e["option"]: e["why_wrong"]
        for e in (out or {}).get("explanations", [])
        if e.get("option") in pedidas and (e.get("why_wrong") or "").strip()
    }
    return {"explanations": mapa}
