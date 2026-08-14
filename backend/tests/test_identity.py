"""Identidad de quien responde: deducir nombre/mail de las respuestas cuando la
encuesta es de link público (sin lista de invitados)."""

from app.identity import identity_fields, respondent_identity

SCHEMA = {
    "pages": [
        {
            "elements": [
                {"type": "text", "name": "q_nombre", "title": "Nombre y apellido"},
                {"type": "text", "name": "q_mail", "title": "Mail"},
                {"type": "comment", "name": "q_libre", "title": "Comentarios adicionales:"},
            ]
        }
    ]
}


def test_detects_name_and_email_by_title():
    # Caso real del usuario: preguntas de tipo texto tituladas "Nombre y apellido" y "Mail".
    assert identity_fields(SCHEMA) == ("q_nombre", "q_mail")
    name, email = respondent_identity(
        SCHEMA, {"q_nombre": "Clara López", "q_mail": "clopez@codeki.com.ar"}
    )
    assert (name, email) == ("Clara López", "clopez@codeki.com.ar")


def test_email_question_type_wins():
    schema = {
        "pages": [
            {
                "elements": [
                    {"type": "email", "name": "e", "title": "Contacto"},
                    {"type": "text", "name": "n", "title": "Nombre"},
                ]
            }
        ]
    }
    assert identity_fields(schema) == ("n", "e")


def test_accents_and_case_in_titles():
    schema = {"pages": [{"elements": [{"type": "text", "name": "c", "title": "CORREO electrónico"}]}]}
    assert identity_fields(schema)[1] == "c"


def test_falls_back_to_any_email_shaped_value():
    # La pregunta no se llama "mail", pero el valor tiene forma de correo.
    schema = {"pages": [{"elements": [{"type": "text", "name": "usuario", "title": "Usuario"}]}]}
    _n, email = respondent_identity(schema, {"usuario": "ana@example.com"})
    assert email == "ana@example.com"


def test_no_invents_identity():
    schema = {"pages": [{"elements": [{"type": "text", "name": "x", "title": "¿Qué opinás?"}]}]}
    assert respondent_identity(schema, {"x": "todo bien"}) == (None, None)
    # Respuestas vacías tampoco producen nombre.
    assert respondent_identity(SCHEMA, {"q_nombre": "   "}) == (None, None)


def test_ignores_non_text_values():
    # Una lista (opción múltiple) no debe convertirse en nombre.
    assert respondent_identity(SCHEMA, {"q_nombre": ["a", "b"]}) == (None, None)


def test_como_te_llamas_tambien_es_preguntar_el_nombre():
    """El caso que llegó desde una encuesta real: la primera pregunta pedía el
    nombre y toda la planilla igual decía "Anónimo", porque el título no contenía
    la palabra "nombre"."""
    schema = {
        "pages": [
            {"elements": [{"type": "text", "name": "nombre", "title": "¿Cómo te llamás?"}]},
            {"elements": [{"type": "comment", "name": "comentario",
                           "title": "¿Algo que quieras contarnos?"}]},
        ]
    }
    assert identity_fields(schema)[0] == "nombre"
    assert respondent_identity(schema, {"nombre": "Clara Gómez"})[0] == "Clara Gómez"


def test_otras_formas_de_pedir_el_nombre():
    for titulo in ["¿Cómo te llamas?", "Come ti chiami?", "Como se chama?",
                   "Comment vous appelez-vous ?", "Votre prénom", "Cognome"]:
        schema = {"pages": [{"elements": [
            {"type": "text", "name": "q", "title": titulo}]}]}
        assert identity_fields(schema)[0] == "q", titulo


def test_prefiere_la_respuesta_corta_sobre_el_parrafo():
    """Si dos preguntas hablan de nombres, identifica mejor la de texto corto."""
    schema = {
        "pages": [
            {"elements": [
                {"type": "comment", "name": "largo", "title": "Contanos cómo te llamás y por qué"},
                {"type": "text", "name": "corto", "title": "Nombre"},
            ]}
        ]
    }
    assert identity_fields(schema)[0] == "corto"


def test_un_parrafo_entero_no_es_un_nombre():
    schema = {"pages": [{"elements": [
        {"type": "comment", "name": "q", "title": "¿Cómo te llamás?"}]}]}
    largo = "Me llamo así porque " + "x" * 200
    assert respondent_identity(schema, {"q": largo})[0] is None


def test_sin_pistas_sigue_sin_inventar_nada():
    schema = {"pages": [{"elements": [
        {"type": "comment", "name": "q", "title": "¿Qué te pareció el curso?"}]}]}
    assert identity_fields(schema)[0] is None
    assert respondent_identity(schema, {"q": "Muy bueno"})[0] is None
