"""Encuestas de demostración para quien recién empieza.

Crea una encuesta (o un examen) de ejemplo con respuestas simuladas, así el
panel se ve "con vida" desde el primer minuto: gráficos, NPS, segmentación,
corrección y análisis de ítems. Todo queda marcado (`meta.demo`) y el título
dice "(demo)": se borra como cualquier otra encuesta.

Los datos son sintéticos y verosímiles (distribuciones sesgadas, algunas
correlaciones entre preguntas, fechas repartidas en dos semanas), con una
semilla fija: la demo sale igual cada vez.
"""

from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Survey, SurveyResponse, SurveyVisit

KINDS = ("survey", "exam")

_SURVEY_SCHEMA = {
    "title": "Satisfacción de clientes (demo)",
    "description": "Encuesta de ejemplo con respuestas simuladas. Borrala cuando quieras.",
    "pages": [{"name": "p1", "elements": [
        {"type": "rating", "name": "nps", "title": "¿Qué tan probable es que nos recomiendes a un colega?",
         "rateMin": 0, "rateMax": 10, "isRequired": True},
        {"type": "radiogroup", "name": "canal", "title": "¿Por qué canal nos contactaste?",
         "choices": ["Web", "Teléfono", "Sucursal", "Redes sociales"]},
        {"type": "rating", "name": "atencion", "title": "¿Cómo calificás la atención recibida?", "rateMin": 1, "rateMax": 5},
        {"type": "checkbox", "name": "mejoras", "title": "¿Qué deberíamos mejorar?",
         "choices": ["Tiempos de espera", "Precios", "Claridad de la información", "Horarios"]},
        {"type": "comment", "name": "comentario", "title": "¿Algo más que quieras contarnos?"},
    ]}],
}

_COMENTARIOS = [
    "La atención fue excelente, muy amables.", "Tardaron mucho en responderme por teléfono.",
    "Los precios subieron bastante este año.", "Me resolvieron todo en el momento.",
    "La web es confusa, no encontraba la información.", "Muy buena experiencia en la sucursal.",
    "Podrían abrir los sábados.", "Excelente predisposición del equipo.",
    "Tuve que llamar tres veces por el mismo problema.", "Todo perfecto, gracias.",
]

_EXAM_SCHEMA = {
    "title": "Parcial de Geografía (demo)",
    "description": "Examen de ejemplo con respuestas simuladas y corrección automática.",
    "pages": [{"name": "p1", "elements": [
        {"type": "radiogroup", "name": "cap_fr", "title": "¿Cuál es la capital de Francia?", "choices": ["París", "Lyon", "Marsella", "Niza"]},
        {"type": "radiogroup", "name": "rio", "title": "¿Cuál es el río más caudaloso del mundo?", "choices": ["Amazonas", "Nilo", "Yangtsé", "Misisipi"]},
        {"type": "boolean", "name": "ecuador", "title": "El ecuador atraviesa Brasil.", "labelTrue": "Verdadero", "labelFalse": "Falso"},
        {"type": "checkbox", "name": "andinos", "title": "¿Qué países atraviesa la cordillera de los Andes?",
         "choices": ["Chile", "Perú", "Uruguay", "Bolivia", "Paraguay"]},
        {"type": "radiogroup", "name": "cap_au", "title": "¿Cuál es la capital de Australia?", "choices": ["Canberra", "Sídney", "Melbourne", "Perth"]},
        {"type": "text", "name": "oceano", "title": "¿Cuál es el océano más grande?"},
    ]}],
}

_EXAM_EVAL = {
    "enabled": True, "passingScore": 60,
    "questions": {
        "cap_fr": {"gradable": True, "grader": "auto", "points": 1, "correct": "París"},
        "rio": {"gradable": True, "grader": "auto", "points": 1, "correct": "Amazonas"},
        "ecuador": {"gradable": True, "grader": "auto", "points": 1, "correct": True},
        "andinos": {"gradable": True, "grader": "auto", "points": 2, "correct": ["Chile", "Perú", "Bolivia"], "partialCredit": True},
        "cap_au": {"gradable": True, "grader": "auto", "points": 1, "correct": "Canberra"},
        "oceano": {"gradable": True, "grader": "auto", "points": 1, "correct": ["Pacífico", "Océano Pacífico"]},
    },
}


def _fecha(rng: random.Random, ahora: datetime) -> datetime:
    return ahora - timedelta(days=rng.randint(0, 13), hours=rng.randint(0, 23), minutes=rng.randint(0, 59))


def _respuesta_encuesta(rng: random.Random) -> dict:
    canal = rng.choices(["Web", "Teléfono", "Sucursal", "Redes sociales"], weights=[40, 25, 25, 10])[0]
    # El teléfono anda peor: la diferencia entre segmentos sale significativa.
    base = {"Web": 8, "Teléfono": 5.5, "Sucursal": 8.5, "Redes sociales": 7}[canal]
    nps = max(0, min(10, round(rng.gauss(base, 2))))
    atencion = max(1, min(5, round(nps / 2 + rng.choice([-1, 0, 0, 1]))))
    mejoras = [m for m, p in (("Tiempos de espera", 0.6 if canal == "Teléfono" else 0.25), ("Precios", 0.35),
                              ("Claridad de la información", 0.3 if canal == "Web" else 0.15), ("Horarios", 0.2))
               if rng.random() < p]
    out = {"nps": nps, "canal": canal, "atencion": atencion}
    if mejoras:
        out["mejoras"] = mejoras
    if rng.random() < 0.45:
        out["comentario"] = rng.choice(_COMENTARIOS)
    return out


def _respuesta_examen(rng: random.Random) -> dict:
    habilidad = rng.random()  # algunos saben más que otros: el análisis de ítems discrimina

    def acierta(dificultad: float) -> bool:
        return rng.random() < max(0.05, min(0.97, habilidad + 0.5 - dificultad))

    andinos = [p for p in ("Chile", "Perú", "Bolivia") if acierta(0.3)]
    if rng.random() < 0.3 - habilidad * 0.2:
        andinos.append(rng.choice(["Uruguay", "Paraguay"]))
    return {
        "cap_fr": "París" if acierta(0.05) else rng.choice(["Lyon", "Marsella"]),
        "rio": "Amazonas" if acierta(0.45) else rng.choice(["Nilo", "Yangtsé"]),
        "ecuador": acierta(0.35),
        "andinos": andinos or ["Chile"],
        # Pregunta "trampa": muchos ponen Sídney; la contestan bien los que más saben.
        "cap_au": "Canberra" if acierta(0.7) else "Sídney",
        "oceano": rng.choice(["Pacífico", "pacífico", "Océano Pacífico"]) if acierta(0.2) else "Atlántico",
    }


async def create_demo(session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, kind: str) -> Survey:
    from app.audit import ensure_survey_version, response_hash
    from app.grading import extract_question_choices, extract_question_types, grade_response

    rng = random.Random(f"encuestum-demo-{kind}")
    ahora = datetime.now(timezone.utc)
    if kind == "exam":
        schema, evaluation, n = _EXAM_SCHEMA, _EXAM_EVAL, 40
    else:
        schema, evaluation, n = _SURVEY_SCHEMA, None, 120
    s = Survey(org_id=org_id, created_by=user_id, title=schema["title"], json_schema=schema,
               evaluation=evaluation, language="es", status="published")
    session.add(s)
    await session.flush()
    version = await ensure_survey_version(session, s, label="demo")
    tipos, opciones = extract_question_types(schema), extract_question_choices(schema)
    for _ in range(n):
        answers = _respuesta_examen(rng) if kind == "exam" else _respuesta_encuesta(rng)
        r = SurveyResponse(survey_id=s.id, answers=answers, completed=True, survey_version_id=version.id,
                           meta={"demo": True, "server": {"received_at": ahora.isoformat()}})
        r.id = uuid.uuid4()
        r.submitted_at = _fecha(rng, ahora)
        r.integrity_hash = response_hash(r)
        if evaluation:
            g = await grade_response(evaluation=evaluation, answers=answers, question_types=tipos,
                                     question_choices=opciones, language="es")
            g["graded_with_version"] = version.number
            r.grade, r.score, r.max_score = g, g.get("total"), g.get("max")
            r.needs_review, r.graded_at = bool(g.get("needs_review")), r.submitted_at
        session.add(r)
        session.add(SurveyVisit(survey_id=s.id, visitor_id=f"demo-{uuid.uuid4().hex[:12]}", started=True,
                                completed=True, created_at=r.submitted_at, last_seen_at=r.submitted_at))
    # Embudo: también quien entró y no empezó, o empezó y abandonó (sobre todo
    # en la pregunta abierta, como pasa en la realidad).
    nombres = [el["name"] for el in schema["pages"][0]["elements"]]
    for i in range(int(n * 0.6)):
        empezo = i % 2 == 0
        cuando = _fecha(rng, ahora)
        session.add(SurveyVisit(survey_id=s.id, visitor_id=f"demo-{uuid.uuid4().hex[:12]}", started=empezo,
                                completed=False, last_question=rng.choice(nombres[-2:]) if empezo else None,
                                created_at=cuando, last_seen_at=cuando))
    await session.commit()
    await session.refresh(s)
    return s
