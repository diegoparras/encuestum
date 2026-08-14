"""La corrección que ve quien respondió: su respuesta, la correcta y el porqué.

El reclamo que originó esto: con una opción única mal contestada, la pantalla
mostraba el título de la pregunta y un punto rojo, y nada más. Ni qué había
contestado, ni cuál era la correcta, ni por qué estaba mal.
"""

from app.review import (
    explicacion,
    revela_correcta,
    texto_de_correcta,
    texto_de_respuesta,
    vista_de_repaso,
)

TITULOS = {"q1": "¿Cuánto es 2+2?", "q2": "Explicá por qué"}


def _grade(verdict="incorrect", feedback=None, name="q1", qtype="radiogroup"):
    return {
        "questions": [
            {
                "name": name, "type": qtype, "verdict": verdict,
                "awarded": 1.0 if verdict == "correct" else 0.0,
                "points": 1.0, "feedback": feedback,
            }
        ]
    }


def test_siempre_se_ve_lo_que_respondio():
    ev = {"questions": {"q1": {"correct": "4"}}}
    vista = vista_de_repaso(_grade(), ev, {}, {"q1": "5"}, titles=TITULOS)
    assert vista[0]["answer"] == "5"
    assert vista[0]["title"] == "¿Cuánto es 2+2?"


def test_la_correcta_solo_si_el_autor_lo_habilito():
    ev = {"questions": {"q1": {"correct": "4"}}}
    # Por defecto NO se revela.
    assert "correct_answer" not in vista_de_repaso(_grade(), ev, {}, {"q1": "5"}, titles=TITULOS)[0]

    # Habilitado a nivel encuesta.
    ev_on = {"revealCorrect": True, "questions": {"q1": {"correct": "4"}}}
    assert vista_de_repaso(_grade(), ev_on, {}, {"q1": "5"}, titles=TITULOS)[0]["correct_answer"] == "4"

    # Y se puede apagar SOLO en una pregunta, aunque la encuesta la revele.
    ev_mix = {"revealCorrect": True, "questions": {"q1": {"correct": "4", "revealCorrect": False}}}
    assert "correct_answer" not in vista_de_repaso(_grade(), ev_mix, {}, {"q1": "5"}, titles=TITULOS)[0]


def test_si_acerto_no_se_le_revela_nada_de_mas():
    ev = {"revealCorrect": True, "questions": {"q1": {"correct": "4"}}}
    vista = vista_de_repaso(_grade(verdict="correct"), ev, {}, {"q1": "4"}, titles=TITULOS)
    assert vista[0]["answer"] == "4"
    assert "correct_answer" not in vista[0]  # ya la sabe: la escribió


def test_explicacion_del_autor_por_opcion_le_gana_a_la_de_la_ia():
    ev = {
        "questions": {
            "q1": {
                "correct": "4",
                "explanations": {"5": "Contaste uno de más."},
            }
        }
    }
    vista = vista_de_repaso(
        _grade(feedback="La IA diría otra cosa"), ev, {}, {"q1": "5"}, titles=TITULOS
    )
    assert vista[0]["explanation"] == "Contaste uno de más."


def test_cae_a_la_explicacion_general_y_despues_a_la_ia():
    # Sin explicación para esa opción, usa la de la pregunta.
    ev = {"questions": {"q1": {"explanation": "Repasá la suma."}}}
    assert vista_de_repaso(_grade(), ev, {}, {"q1": "9"}, titles=TITULOS)[0]["explanation"] == "Repasá la suma."
    # Sin ninguna de las dos, usa lo que redactó la IA.
    ev2 = {"questions": {"q1": {}}}
    vista = vista_de_repaso(_grade(feedback="Te faltó justificar"), ev2, {}, {"q1": "9"}, titles=TITULOS)
    assert vista[0]["explanation"] == "Te faltó justificar"


def test_respuestas_de_varios_tipos_se_leen_bien():
    assert texto_de_respuesta(True) == "Sí"
    assert texto_de_respuesta(False) == "No"
    assert texto_de_respuesta(["a", "b"]) == "a, b"
    assert texto_de_respuesta(None) == ""
    assert texto_de_respuesta(7) == "7"


def test_en_abiertas_la_correcta_es_la_respuesta_modelo():
    qcfg = {"grader": "llm", "modelAnswer": "Porque separa responsabilidades."}
    assert texto_de_correcta(qcfg, "comment") == "Porque separa responsabilidades."


def test_sin_explicacion_no_se_inventa_el_campo():
    ev = {"questions": {"q1": {}}}
    vista = vista_de_repaso(_grade(), ev, {}, {"q1": "5"}, titles=TITULOS)
    assert "explanation" not in vista[0]


def test_helpers_de_revelado_y_explicacion():
    assert revela_correcta({}, {"revealCorrect": True}) is True
    assert revela_correcta({"revealCorrect": False}, {"revealCorrect": True}) is False
    assert explicacion({}, "x", None) == ""
