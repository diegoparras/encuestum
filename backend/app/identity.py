"""Quién respondió: nombre y correo de cada respuesta.

Cuando la encuesta tiene lista de invitados, la identidad la da el invitado
(código/email). Pero en una encuesta de link público no hay invitado, y hasta
acá todas las respuestas se mostraban como "Anónimo" aunque la propia encuesta
preguntara el nombre y el mail. Este módulo deduce esos datos de las respuestas.

La deducción es explícita y conservadora: primero por tipo de pregunta (`email`),
después por el título ("Mail", "Nombre y apellido"), y recién al final por la
forma del valor. Si nada aplica, no se inventa nada: devuelve None.
"""

import re
from typing import Optional

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Sin acentos: los títulos se normalizan antes de comparar.
_EMAIL_HINT = re.compile(r"\b(mail|e-?mail|correo)\b", re.I)
# Preguntar el nombre casi nunca es decir la palabra "nombre": "¿Cómo te
# llamás?" es la forma natural en español y no matcheaba nada, así que la
# tabla decía "Anónimo" con la encuesta preguntando el nombre en la primera
# pregunta. Se cubren las formas equivalentes en los idiomas de la app.
_NAME_HINT = re.compile(
    r"\b(nombre|apellido|name|nome|prenom|cognome)\b"
    r"|\b(llam|chiam|chama|appel)\w*",
    re.I,
)

# Un nombre no ocupa un párrafo. Si el texto es larguísimo, casi seguro
# matcheamos una pregunta abierta y no la identidad de nadie.
_MAX_NOMBRE = 80

_TEXTISH = {"text", "comment", "email"}


def _strip_accents(s: str) -> str:
    import unicodedata

    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


def _questions(schema: dict) -> list[dict]:
    out = []
    for page in (schema or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            if isinstance(el, dict) and el.get("name"):
                out.append(el)
    return out


def _text_value(answers: dict, name: str) -> Optional[str]:
    v = answers.get(name)
    if v is None or isinstance(v, (list, dict)):
        return None
    v = str(v).strip()
    return v or None


def identity_fields(schema: dict) -> tuple[Optional[str], Optional[str]]:
    """(name_question, email_question): qué preguntas identifican a quien responde.

    Se resuelve una sola vez por encuesta (no por respuesta)."""
    email_q: Optional[str] = None
    # Candidatas a nombre, para quedarnos con la mejor y no con la primera: una
    # respuesta corta identifica mejor que un párrafo.
    nombres: list[tuple[int, str]] = []

    for el in _questions(schema):
        if el.get("type") not in _TEXTISH:
            continue
        # Se mira el título Y el nombre del campo. El campo suele decir en
        # una palabra lo que el título dice en una frase: "¿Cómo te llamás?"
        # vive en un campo llamado `nombre`. Mirar sólo el título dejaba
        # afuera justo el dato más explícito que trae el JSON.
        # El guion bajo pasa a espacio: para el regex `_` es un caracter de
        # palabra, así que sin esto `email_3` o `nombre_completo` no cortaban
        # en el borde y no matcheaban nada.
        texto = _strip_accents(
            str(el.get("title") or "") + " " + str(el.get("name") or "")
        ).replace("_", " ")
        # El correo: primero por tipo declarado, después por el texto.
        if email_q is None and el.get("type") == "email":
            email_q = el["name"]
        elif email_q is None and _EMAIL_HINT.search(texto):
            email_q = el["name"]
        # El nombre: nunca por la forma del valor, para no confundirlo con una
        # pregunta abierta cualquiera.
        elif _NAME_HINT.search(texto):
            nombres.append((0 if el.get("type") == "text" else 1, el["name"]))

    name_q = min(nombres)[1] if nombres else None
    return name_q, email_q


def respondent_identity(
    schema: dict,
    answers: dict,
    *,
    fields: Optional[tuple[Optional[str], Optional[str]]] = None,
) -> tuple[Optional[str], Optional[str]]:
    """(nombre, email) deducidos de las respuestas. None si no se puede saber."""
    answers = answers or {}
    name_q, email_q = fields if fields is not None else identity_fields(schema)

    name = _text_value(answers, name_q) if name_q else None
    if name and len(name) > _MAX_NOMBRE:
        name = None
    email = _text_value(answers, email_q) if email_q else None

    # Último recurso para el correo: algún valor con forma de email. Sirve cuando
    # la pregunta se llama distinto ("Contacto", "Usuario").
    if not email:
        for value in answers.values():
            if isinstance(value, str) and _EMAIL_RE.match(value.strip()):
                email = value.strip()
                break

    return name, email
