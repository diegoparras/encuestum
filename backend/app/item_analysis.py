"""Análisis de ítems de un examen (psicometría clásica).

Lo que un docente necesita para saber qué preguntas están mal hechas, no sólo
qué tan bien le fue al grupo:

* **Dificultad** (p): proporción media del puntaje obtenido. 0,95 = casi todos
  la aciertan (no mide nada); 0,15 = casi nadie (¿está bien la clave?).
* **Discriminación**: correlación punto-biserial corregida entre el ítem y el
  resto del examen (sin el ítem), y el índice D (aciertos del 27% con mejor nota
  menos los del 27% con peor). Una pregunta que la aciertan más los que peor
  rindieron es, casi siempre, una clave mal cargada o una consigna ambigua.
* **Confiabilidad**: alfa de Cronbach (= KR-20 con ítems de 0/1).
* **Distractores**: opciones que nadie eligió (no distraen) y opciones
  incorrectas que eligen más los mejores alumnos (señal de ambigüedad).

Puro: recibe el esquema, la evaluación y las notas ya calculadas.
"""

from __future__ import annotations

from typing import Optional

from app import stats

# Umbrales clásicos (Ebel; Haladyna). Sirven de guía, no de veredicto.
_FACIL, _DIFICIL = 0.90, 0.20
_DISC_BAJA = 0.20
_MIN_N = 10  # debajo de esto, la discriminación es ruido
_GRUPO = 0.27


def _choices(el: dict) -> list[str]:
    out = []
    for c in el.get("choices", []) or []:
        if isinstance(c, dict):
            out.append(str(c.get("value", c.get("text", ""))))
        else:
            out.append(str(c))
    if el.get("type") == "boolean":
        out = [el.get("labelTrue") or "Sí", el.get("labelFalse") or "No"]
    return out


def _as_set(v) -> set[str]:
    if v is None or v == "":
        return set()
    if isinstance(v, bool):
        return {"Sí" if v else "No"}
    if isinstance(v, list):
        return {str(x) for x in v}
    return {str(v)}


def analyze(schema: dict, evaluation: dict, graded: list) -> dict:
    """`graded`: respuestas con `grade` y `answers` (sólo las evaluables).

    Devuelve {"items": {nombre: {...}}, "reliability": {...}}."""
    elements = {
        el.get("name"): el
        for p in (schema or {}).get("pages", []) or []
        if isinstance(p, dict)
        for el in p.get("elements", []) or []
        if isinstance(el, dict) and el.get("name")
    }
    qcfg = (evaluation or {}).get("questions", {}) or {}

    # Puntaje fraccional (0..1) de cada persona en cada ítem.
    filas: list[tuple[object, dict[str, float]]] = []
    for r in graded:
        fr: dict[str, float] = {}
        for q in (r.grade or {}).get("questions", []) or []:
            pts = float(q.get("points", 0) or 0)
            if q.get("name") and pts > 0:
                fr[q["name"]] = max(0.0, min(1.0, float(q.get("awarded", 0) or 0) / pts))
        if fr:
            filas.append((r, fr))
    nombres = sorted({n for _, fr in filas for n in fr})
    total_pct = {id(r): float((r.grade or {}).get("percent", 0) or 0) for r, _ in filas}

    # Grupos extremos por nota total.
    ordenadas = sorted(filas, key=lambda t: total_pct[id(t[0])])
    k = int(round(len(ordenadas) * _GRUPO))
    inferior = ordenadas[:k] if len(ordenadas) >= _MIN_N else []
    superior = ordenadas[-k:] if len(ordenadas) >= _MIN_N else []

    items: dict[str, dict] = {}
    for name in nombres:
        con = [(r, fr) for r, fr in filas if name in fr]
        xs = [fr[name] for _, fr in con]
        # Resto del examen SIN el ítem (corrección: si no, el ítem se
        # correlaciona consigo mismo y la discriminación sale inflada).
        resto = [sum(v for kk, v in fr.items() if kk != name) for _, fr in con]
        p = stats.mean(xs)
        disc = stats.pearson(xs, resto) if len(con) >= _MIN_N else None
        d_index = None
        if superior and inferior:
            su = [fr[name] for _, fr in superior if name in fr]
            inf = [fr[name] for _, fr in inferior if name in fr]
            if su and inf:
                d_index = stats.mean(su) - stats.mean(inf)

        flags: list[str] = []
        if p is not None and len(con) >= _MIN_N:
            if p >= _FACIL:
                flags.append("muy_facil")
            elif p <= _DIFICIL:
                flags.append("muy_dificil")
        if disc is not None:
            if disc < 0:
                flags.append("discriminacion_negativa")
            elif disc < _DISC_BAJA:
                flags.append("discrimina_poco")

        item = {
            "n": len(con),
            "difficulty": stats.r(p, 3),
            "discrimination": stats.r(disc, 3),
            "d_index": stats.r(d_index, 3),
            "flags": flags,
        }

        # Distractores (sólo preguntas con opciones y clave).
        el = elements.get(name) or {}
        correctas = _as_set((qcfg.get(name) or {}).get("correct"))
        opciones = _choices(el)
        if opciones and correctas:
            elegidas_todas = [_as_set((r.answers or {}).get(name)) for r, _ in con]
            nunca = [o for o in opciones if o not in correctas and not any(o in e for e in elegidas_todas)]
            atrae = []
            if superior and inferior:
                for o in opciones:
                    if o in correctas:
                        continue
                    su = [o in _as_set((r.answers or {}).get(name)) for r, _ in superior]
                    inf = [o in _as_set((r.answers or {}).get(name)) for r, _ in inferior]
                    ps, pi = sum(su) / len(su), sum(inf) / len(inf)
                    if ps >= 0.1 and ps > pi:
                        atrae.append({"option": o, "upper": round(ps, 2), "lower": round(pi, 2)})
            item["distractors"] = {"never_chosen": nunca, "attracts_top": atrae}
            if nunca:
                flags.append("distractor_inutil")
            if atrae:
                flags.append("distractor_ambiguo")
        items[name] = item

    # Confiabilidad: sólo con las personas que tienen todos los ítems.
    completos = [[fr[n] for n in nombres] for _, fr in filas if all(n in fr for n in nombres)]
    alpha = stats.cronbach_alpha(completos) if len(nombres) >= 2 else None
    reliability: Optional[dict] = None
    if alpha is not None:
        reliability = {
            "alpha": round(alpha, 3),
            "n": len(completos),
            "items": len(nombres),
            # Lectura habitual: ≥0,8 buena, 0,7-0,8 aceptable, <0,7 baja. En un
            # parcial corto de aula, 0,6-0,7 es común; el panel lo explica.
            "level": "buena" if alpha >= 0.8 else "aceptable" if alpha >= 0.7 else "baja",
        }
    return {"items": items, "reliability": reliability, "groups": {"n": len(filas), "k": k if superior else 0}}
