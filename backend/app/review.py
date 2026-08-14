"""Qué ve quien respondió cuando mira su corrección.

Hasta acá la pantalla de resultado mostraba el título de cada pregunta y si
estaba bien o mal, y nada más: ni lo que la persona había contestado, ni cuál
era la respuesta correcta, ni por qué la suya no lo era. Con una opción única
mal contestada no quedaba absolutamente nada en pantalla que explicara el error.

Este módulo arma esa vista. Las decisiones que importan:

* **Lo que respondió se muestra siempre.** Es su propia respuesta: ocultársela no
  protege nada y es justo el dato que despeja la duda.
* **La respuesta correcta se revela sólo si el autor lo pidió**, y se decide acá
  (al mirar), no al corregir: así el mismo `grade` ya guardado se puede mostrar
  con o sin revelar, y cambiar el ajuste no obliga a recorregir nada. Eso es
  además lo que hace posible el modo "al cerrar": la misma corrección se ve
  distinta antes y después del cierre, sin tocar un solo registro.
* **La explicación puede venir de tres lados**: la que escribió el autor para esa
  opción (o para la pregunta), la que un corrector editó a mano, y la que
  redactó la IA. Gana la del autor, porque es la que él revisó.
* **El comentario de la IA se puede retener** hasta que un humano lo apruebe.
  Sólo el de la IA: lo que escribió una persona ya pasó por una persona.
"""

from typing import Any, Optional

# Cuándo se muestra la respuesta correcta.
SIEMPRE = "always"
AL_CERRAR = "onClose"
NUNCA = "never"
MODOS = (SIEMPRE, AL_CERRAR, NUNCA)


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


def _modo(valor: Any) -> Optional[str]:
    """Normaliza un ajuste de revelado, venga como venga.

    Antes esto era un booleano. Las encuestas guardadas con la versión anterior
    lo siguen teniendo así, y hay que leerlas sin migrar nada: `true` era
    "revelá" y `false` era "no reveles"."""
    if valor is None:
        return None
    if isinstance(valor, bool):
        return SIEMPRE if valor else NUNCA
    texto = str(valor).strip()
    return texto if texto in MODOS else None


def modo_revelado(qcfg: dict, evaluation: dict) -> str:
    """Cuándo revela la correcta ESTA pregunta.

    El ajuste es por pregunta con el de la encuesta como valor por defecto: casi
    siempre se quiere lo mismo en todas, pero hay preguntas donde revelar la
    correcta arruina el ejercicio."""
    propio = _modo((qcfg or {}).get("revealCorrect"))
    if propio is not None:
        return propio
    return _modo((evaluation or {}).get("revealCorrect")) or NUNCA


def revela_correcta(qcfg: dict, evaluation: dict, *, cerrada: bool = False) -> bool:
    """Si en este momento se le muestra la respuesta correcta."""
    modo = modo_revelado(qcfg, evaluation)
    if modo == SIEMPRE:
        return True
    if modo == AL_CERRAR:
        return bool(cerrada)
    return False


def requiere_revision(evaluation: dict) -> bool:
    """Si el comentario de la IA espera el visto bueno de un humano."""
    return str((evaluation or {}).get("feedbackReview") or "off") == "on"


def revision_aprobada(grade: dict) -> bool:
    return bool((grade or {}).get("feedback_approved"))


def comentario(q: dict, evaluation: dict, grade: dict) -> str:
    """El comentario de esta pregunta, ya pasado por el filtro de revisión.

    Si un corrector lo editó, vale lo suyo: sigue siendo el mismo comentario,
    revisado. Y si la encuesta exige revisión y todavía nadie aprobó esta
    corrección, no se muestra nada -- mejor que no haya comentario a que haya uno
    que el docente no vio."""
    editado = (q or {}).get("feedback_edited")
    if editado is not None and str(editado).strip():
        return str(editado).strip()
    if requiere_revision(evaluation) and not revision_aprobada(grade):
        return ""
    return str((q or {}).get("feedback") or "").strip()


def explicacion(qcfg: dict, respuesta: Any, feedback: Optional[str]) -> str:
    """Por qué la respuesta no era correcta.

    Prioridad: lo que escribió el autor para ESA opción, después lo que escribió
    para la pregunta entera, y recién al final el comentario de la corrección. La
    del autor gana porque la revisó una persona."""
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
    return (feedback or "").strip()


def vista_de_repaso(
    grade: dict,
    evaluation: dict,
    schema: dict,
    answers: dict,
    *,
    titles: dict,
    cerrada: bool = False,
) -> list:
    """Una entrada por pregunta corregida, lista para pintar."""
    q_configs = (evaluation or {}).get("questions", {}) or {}
    salida = []
    for q in (grade or {}).get("questions", []):
        nombre = q.get("name")
        qcfg = q_configs.get(nombre, {}) or {}
        dada = (answers or {}).get(nombre)
        acerto = q.get("verdict") == "correct"
        texto_comentario = comentario(q, evaluation, grade)

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
            texto = explicacion(qcfg, dada, texto_comentario)
            if texto:
                item["explanation"] = texto
            if revela_correcta(qcfg, evaluation, cerrada=cerrada):
                correcta = texto_de_correcta(qcfg, q.get("type") or "")
                if correcta:
                    item["correct_answer"] = correcta
        elif texto_comentario:
            # Si acertó, el comentario igual puede sumar (p. ej. en abiertas).
            item["explanation"] = texto_comentario
        salida.append(item)
    return salida
