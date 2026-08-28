"""Respuestas correctas que ya no se pueden elegir.

El caso que lo destapó: un examen de opción múltiple donde contestar TODO bien
daba 0.5. La pregunta tenía 4 opciones y 3 correctas, pero la configuración
guardaba 6 correctas: tres eran textos de una versión anterior de la pregunta,
imposibles de elegir. Con crédito parcial el puntaje se divide por el total de
correctas configuradas, así que el máximo alcanzable era 3/6.

Las correctas se guardan por TEXTO: al renombrar una opción, la marca vieja
queda colgada para siempre.
"""

from app.grading import correctas_alcanzables, extract_question_choices, grade_deterministic

OPCIONES = [
    "Maximizar la información atomizada en columnas independientes.",
    "Asegurar que todo registro cuente con un identificador único (DNI/Legajo).",
    "Combinar celdas y usar encabezados en distintas filas.",
    "Usar menús desplegables para validar campos de categoría.",
]
BUENAS = [OPCIONES[0], OPCIONES[1], OPCIONES[3]]
FANTASMA = ["El límite físico de la Ley de Moore.", "La demanda energética masiva."]

ESQUEMA = {"pages": [{"elements": [
    {"type": "checkbox", "name": "q", "choices": OPCIONES}]}]}


def _cfg(correct, parcial=True):
    return {"gradable": True, "grader": "auto", "points": 1,
            "partialCredit": parcial, "correct": correct}


def _opciones():
    return extract_question_choices(ESQUEMA)["q"]


def test_contestar_todo_bien_da_el_puntaje_completo():
    """El reclamo tal cual llegó: 'aunque se respondan correctamente, da error'."""
    cfg = _cfg(FANTASMA + BUENAS)
    # Antes, sin saber qué opciones existen: 3 aciertos sobre 5 configuradas.
    assert grade_deterministic(cfg, "checkbox", BUENAS)["awarded"] == 0.6
    # Sabiendo cuáles se pueden elegir, el examen perfecto vale 1.
    assert grade_deterministic(cfg, "checkbox", BUENAS, _opciones())["awarded"] == 1.0


def test_sigue_descontando_lo_que_está_mal():
    """Ignorar las fantasma no puede volverse un aprobado gratis."""
    cfg = _cfg(FANTASMA + BUENAS)
    ops = _opciones()
    # Una incorrecta entre las elegidas resta.
    con_error = grade_deterministic(cfg, "checkbox", BUENAS[:2] + [OPCIONES[2]], ops)
    assert round(con_error["awarded"], 3) == 0.333
    # Faltan correctas: tampoco es puntaje completo.
    incompleto = grade_deterministic(cfg, "checkbox", BUENAS[:2], ops)
    assert round(incompleto["awarded"], 3) == 0.667


def test_sin_credito_parcial_tambien_se_arregla():
    """Sin crédito parcial se exige el conjunto exacto: con una correcta fantasma
    era literalmente imposible acertar."""
    cfg = _cfg(FANTASMA + BUENAS, parcial=False)
    assert grade_deterministic(cfg, "checkbox", BUENAS)["awarded"] == 0.0
    assert grade_deterministic(cfg, "checkbox", BUENAS, _opciones())["awarded"] == 1.0


def test_una_pregunta_sana_no_cambia():
    cfg = _cfg(BUENAS)
    ops = _opciones()
    assert grade_deterministic(cfg, "checkbox", BUENAS, ops)["awarded"] == 1.0
    assert grade_deterministic(cfg, "checkbox", BUENAS[:1], ops)["awarded"] < 1.0


def test_si_ninguna_correcta_existe_no_se_toca_nada():
    """Que no coincida NINGUNA es señal de que estamos comparando mal (otro
    esquema, otra codificación). Vaciar la lista pondría 0 a todo el mundo en
    silencio: peor que el problema original. Ante la duda, se respeta lo
    configurado."""
    assert correctas_alcanzables({"correct": FANTASMA}, set(OPCIONES)) == FANTASMA


def test_preguntas_con_opciones_dinamicas_quedan_afuera():
    """Sin lista estática no hay con qué comparar: no se saca ninguna conclusión."""
    dinamica = {"pages": [{"elements": [
        {"type": "checkbox", "name": "q", "choicesByUrl": {"url": "https://x/y"}}]}]}
    assert "q" not in extract_question_choices(dinamica)
    assert correctas_alcanzables({"correct": BUENAS}, None) == BUENAS


def test_las_opciones_se_leen_en_los_dos_formatos():
    """El builder las escribe como texto plano, pero un esquema importado puede
    traerlas como objeto {value, text}."""
    objeto = {"pages": [{"elements": [
        {"type": "checkbox", "name": "q",
         "choices": [{"value": "a", "text": "Opción A"}, "b"]}]}]}
    assert extract_question_choices(objeto)["q"] == {"a", "Opción A", "b"}
