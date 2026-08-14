"""Qué ve quien respondió cuando mira su corrección.

Hasta acá la pantalla de resultado mostraba el título de cada pregunta y si
estaba bien o mal, y nada más: ni lo que la persona había contestado, ni cuál
era la respuesta correcta, ni por qué la suya no lo era. Con una opción única
mal contestada no quedaba absolutamente nada en pantalla que explicara el error.

Este módulo arma esa vista. Tres decisiones que importan:

* **Lo que respondió se muestra siempre.** Es su propia respuesta: ocultársela no
  protege nada y es justo el dato que despeja la duda.
* **La respuesta correcta se revela sólo si el autor lo pidió**, y se decide acá
  (al mirar), no al corregir: así el mismo `grade` ya guardado se puede mostrar
  con o sin revelar, y cambiar el ajuste no obliga a recorregir nada.
* **La explicación puede venir de dos lados**: la que escribió el autor para esa
  opción (o para la pregunta) y la que redactó la IA al corregir. Gana la del
  autor, porque es la que él revisó.
"""

from typing import Any, Optional


def texto_de_respuesta(valor: Any) -> str:
    """La respuesta tal como se le muestra a una persona."""
    if valor is None or valor == "" or valor == []:
        return ""
    if isinstance(valor, bool):
        return "Sí" if valor else "No"
    if isinstance(valor, list):
        return ", ".join(texto_de_respuesta(v) for v in valor if v not in (None, ""))
    return str(valor)


def texto_de_correcta(qcfg: dict, qtype: str) -> str:
    """La respuesta correcta configurada, en texto legible.

    Para las abiertas la "correcta" es la respuesta modelo que escribió el autor;
    para las cerradas, la opción (o las opciones) marcadas."""
    if qtype in ("comment", "text", "email") and qcfg.get("grader") == "llm":
        return str(qcfg.get("modelAnswer") or "").strip()
    correcta = qcfg.get("correct")
    if correcta is None:
        return ""
    return texto_de_respuesta(correcta)


def explicacion(qcfg: dict, respuesta: Any, feedback_ia: Optional[str]) -> str:
    """Por qué la respuesta no era correcta.

    Prioridad: lo que escribió el autor para ESA opción, después lo que escribió
    para la pregunta entera, y recién al final lo que redactó la IA. La del autor
    gana porque la revisó una persona."""
    por_opcion = qcfg.get("explanations") or {}
    if isinstance(por_opcion, dict) and respuesta is not None:
        # Con opción múltiple se toma la explicación de la primera elegida que
        # tenga una: es la que más probablemente explique el error.
        elegidas = respuesta if isinstance(respuesta, list) else [respuesta]
        for v in elegidas:
            texto = por_opcion.get(str(v))
            if texto and str(texto).strip():
                return str(texto).strip()
    general = qcfg.get("explanation")
    if general and str(general).strip():
        return str(general).strip()
    return (feedback_ia or "").strip()


def revela_correcta(qcfg: dict, evaluation: dict) -> bool:
    """Si esta pregunta muestra la respuesta correcta.

    El ajuste es POR PREGUNTA, con el de la encuesta como valor por defecto: casi
    siempre se quiere lo mismo en todas, pero hay preguntas donde revelar la
    correcta arruina el ejercicio."""
    propio = qcfg.get("revealCorrect")
    if propio is None:
        return bool((evaluation or {}).get("revealCorrect", False))
    return bool(propio)


def vista_de_repaso(
    grade: dict,
    evaluation: dict,
    schema: dict,
    answers: dict,
    *,
    titles: dict,
) -> list:
    """Una entrada por pregunta corregida, lista para pintar."""
    q_configs = (evaluation or {}).get("questions", {}) or {}
    salida = []
    for q in (grade or {}).get("questions", []):
        nombre = q.get("name")
        qcfg = q_configs.get(nombre, {}) or {}
        dada = (answers or {}).get(nombre)
        acerto = q.get("verdict") == "correct"

        item = {
            "title": titles.get(nombre, nombre),
            "verdict": q.get("verdict"),
            "awarded": q.get("awarded"),
            "points": q.get("points"),
            # Su propia respuesta, siempre.
            "answer": texto_de_respuesta(dada),
        }
        # La explicación y la correcta sólo aportan cuando NO acertó.
        if not acerto:
            texto = explicacion(qcfg, dada, q.get("feedback"))
            if texto:
                item["explanation"] = texto
            if revela_correcta(qcfg, evaluation):
                correcta = texto_de_correcta(qcfg, q.get("type") or "")
                if correcta:
                    item["correct_answer"] = correcta
        elif q.get("feedback"):
            # Si acertó, el comentario igual puede sumar (p. ej. en abiertas).
            item["explanation"] = q["feedback"]
        salida.append(item)
    return salida
