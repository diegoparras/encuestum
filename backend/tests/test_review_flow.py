"""El circuito completo: responder mal, cerrar, corregir y publicar comentarios.

`test_review.py` cubre la lógica de qué se muestra. Acá se prueba que esa lógica
esté efectivamente enchufada a los endpoints: que el modo "al cerrar" mire el
estado real de la encuesta y que el visto bueno del corrector llegue a la
pantalla de quien respondió.
"""

from tests.conftest import new_client, register

SCHEMA = {
    "pages": [
        {
            "name": "p",
            "elements": [
                {"type": "radiogroup", "name": "cap", "title": "Capital de Francia",
                 "choices": ["Madrid", "París"]},
                {"type": "comment", "name": "op", "title": "Justificá"},
            ],
        }
    ]
}


def _evaluacion(**extra):
    ev = {
        "enabled": True, "feedbackTiming": "onComplete", "passingScore": 60,
        "showScoreToRespondent": True,
        "questions": {
            "cap": {"gradable": True, "grader": "auto", "points": 1, "correct": "París"},
            "op": {"gradable": True, "grader": "llm", "points": 1, "title": "Justificá",
                   "modelAnswer": "Porque sí", "keyConcepts": ["capital"], "rubric": []},
        },
    }
    ev.update(extra)
    return ev


def _publicada(c, ev):
    s = c.post("/api/v1/survey/surveys",
               json={"title": "T", "json_schema": SCHEMA, "language": "es", "evaluation": ev}).json()
    assert c.post(f"/api/v1/survey/surveys/{s['id']}/publish").status_code == 200
    return s["id"], s["slug"]


def _con_invitado(c, sid, email="alu@escuela.com"):
    c.put(f"/api/v1/survey/surveys/{sid}",
          json={"access_mode": "list", "results_mode": "immediate"})
    creado = c.post(f"/api/v1/survey/surveys/{sid}/invitees",
                    json={"invitees": [{"email": email}]}).json()
    return email, creado[0]["code"]


def _responder(slug, email, code, respuestas):
    anon = new_client()
    token = anon.post(f"/api/v1/survey/public/{slug}/access",
                      json={"email": email, "code": code}).json()["access_token"]
    r = anon.post(f"/api/v1/survey/public/{slug}/submit",
                  json={"answers": respuestas, "access_token": token})
    assert r.status_code == 201, r.text
    return anon, r.json()


def _pregunta(resultado, nombre_visible):
    return next(q for q in resultado["questions"] if q["title"] == nombre_visible)


def test_al_cerrar_recien_revela_cuando_la_encuesta_cierra():
    """El caso que motivó el modo: mientras el examen sigue abierto, quien ya
    rindió no puede llevarse la clave de corrección."""
    c = new_client(); register(c)
    sid, slug = _publicada(c, _evaluacion(revealCorrect="onClose"))
    email, code = _con_invitado(c, sid)

    anon, sub = _responder(slug, email, code, {"cap": "Madrid", "op": "no sé"})
    q = _pregunta(sub["result"], "Capital de Francia")
    assert q["answer"] == "Madrid"
    assert "correct_answer" not in q  # todavía abierta

    c.put(f"/api/v1/survey/surveys/{sid}", json={"status": "closed"})

    mirar = anon.post(f"/api/v1/survey/public/{slug}/result",
                      json={"email": email, "code": code}).json()
    assert mirar["status"] == "graded"
    # Misma corrección guardada, otra pantalla: no hubo que recorregir nada.
    assert _pregunta(mirar["result"], "Capital de Francia")["correct_answer"] == "París"


def test_siempre_revela_sin_esperar_al_cierre():
    c = new_client(); register(c)
    _, slug = _publicada(c, _evaluacion(revealCorrect="always"))
    r = c.post(f"/api/v1/survey/public/{slug}/submit",
               json={"answers": {"cap": "Madrid", "op": "no sé"}}).json()
    assert _pregunta(r["result"], "Capital de Francia")["correct_answer"] == "París"


def test_el_comentario_de_la_ia_no_se_publica_sin_visto_bueno():
    c = new_client(); register(c)
    sid, slug = _publicada(c, _evaluacion(feedbackReview="on"))
    email, code = _con_invitado(c, sid)

    anon, sub = _responder(slug, email, code, {"cap": "Madrid", "op": "cualquier cosa"})
    # La IA escribió algo (el corrector lo ve), pero al alumno no le llega.
    corregida = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()[0]
    assert any(q.get("feedback") for q in corregida["grade"]["questions"])
    assert "explanation" not in _pregunta(sub["result"], "Justificá")

    rid = corregida["id"]
    c.post(f"/api/v1/survey/surveys/{sid}/responses/{rid}/override",
           json={"approve_feedback": True})

    mirar = anon.post(f"/api/v1/survey/public/{slug}/result",
                      json={"email": email, "code": code}).json()
    assert _pregunta(mirar["result"], "Justificá")["explanation"]


def test_el_corrector_reescribe_el_comentario_y_es_ese_el_que_se_lee():
    c = new_client(); register(c)
    sid, slug = _publicada(c, _evaluacion(feedbackReview="on"))
    email, code = _con_invitado(c, sid)
    anon, _ = _responder(slug, email, code, {"cap": "Madrid", "op": "cualquier cosa"})

    rid = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()[0]["id"]
    c.post(f"/api/v1/survey/surveys/{sid}/responses/{rid}/override",
           json={"feedback": {"op": "Te faltó nombrar la capital."}})

    mirar = anon.post(f"/api/v1/survey/public/{slug}/result",
                      json={"email": email, "code": code}).json()
    # Lo reescribió una persona: no espera ningún visto bueno.
    assert _pregunta(mirar["result"], "Justificá")["explanation"] == "Te faltó nombrar la capital."


def test_recorregir_no_pisa_lo_que_escribio_el_corrector():
    c = new_client(); register(c)
    sid, slug = _publicada(c, _evaluacion())
    c.post(f"/api/v1/survey/public/{slug}/submit",
           json={"answers": {"cap": "Madrid", "op": "cualquier cosa"}})
    rid = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()[0]["id"]
    c.post(f"/api/v1/survey/surveys/{sid}/responses/{rid}/override",
           json={"feedback": {"op": "Ojo con la justificación."}})

    c.post(f"/api/v1/survey/surveys/{sid}/responses/{rid}/grade")

    grade = c.get(f"/api/v1/survey/surveys/{sid}/responses").json()[0]["grade"]
    op = next(q for q in grade["questions"] if q["name"] == "op")
    assert op["feedback_edited"] == "Ojo con la justificación."
