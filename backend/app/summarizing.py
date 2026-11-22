"""Aggregate raw responses into per-question, chart-ready summaries (the
Google-Forms-style "Resumen" view). Works for every survey, not just exams.

Supports two optional lenses on top of the plain aggregation:
  - filters: keep only responses whose answer to a question is among some values
    (e.g. only people who chose "Ventas"), applied before aggregating.
  - segment_by: break every question down by the answer to a categorical
    question (cross-tab), e.g. satisfaction split by department.
Both are pure over (schema, responses), so they're cheap to unit-test."""

from datetime import date, datetime, timezone
from typing import Any, Optional

from app import stats


_SKIP_TYPES = {"image", "html", "expression", "panel"}
_SINGLE_CHOICE = {"radiogroup", "dropdown", "imagepicker"}
# Tipos que sirven como dimensión para filtrar / segmentar: categóricos, más
# casillas (una respuesta cae en cada opción que marcó) y escalas (cada valor
# de la escala es una columna).
_SEGMENTABLE = _SINGLE_CHOICE | {"boolean", "checkbox", "rating"}
# Debajo de esto, un segmento es anecdótico: se avisa en vez de comparar.
SMALL_SEGMENT = 30


def _elements(schema: dict) -> list[dict]:
    out: list[dict] = []
    for page in (schema or {}).get("pages", []) or []:
        # `isinstance` también en la página, no sólo en el elemento: el `or []`
        # cubre `null`, pero con un string o un número ahí `page.get(...)`
        # levanta `AttributeError`. Antes reventaba el resumen de esa encuesta;
        # ahora además tumbaría el selector LTI, que lista veinte encuestas de
        # una y perdería las diecinueve sanas por culpa de una rota.
        if not isinstance(page, dict):
            continue
        for el in page.get("elements", []) or []:
            if isinstance(el, dict):
                out.append(el)
    return out


def count_questions(schema: dict) -> int:
    """Cuántas preguntas de verdad tiene el esquema.

    No es `len(_elements(...))`. El builder emite acompañantes al MISMO nivel
    que las preguntas: un `image` por cada pregunta con imagen, un `html` por
    cada video y otro por cada sección (ver `builder/model.ts`). Contarlos
    infla el número de forma sistemática, no en un caso raro: una encuesta de
    10 preguntas con 4 imágenes y 2 secciones daría 16.

    El resumen ya los descarta con `_SKIP_TYPES` y el mismo criterio de "tiene
    `name`". Esto los comparte para que los dos lugares del producto digan el
    mismo número sobre la misma encuesta."""
    return sum(
        1
        for el in _elements(schema)
        if el.get("name") and el.get("type") not in _SKIP_TYPES
    )


def _choice_pairs(el: dict) -> list[tuple[str, str]]:
    """(value, label) for a choice-based question."""
    pairs: list[tuple[str, str]] = []
    for c in el.get("choices", []) or []:
        if isinstance(c, dict):
            val = str(c.get("value", c.get("text", "")))
            pairs.append((val, str(c.get("text", val))))
        else:
            pairs.append((str(c), str(c)))
    return pairs


def _as_list(v: Any) -> list:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _bool_key(v: Any) -> Optional[str]:
    """Normaliza el valor de un boolean a 'true'/'false' (o None si no aplica)."""
    if v is True or str(v).lower() in ("true", "1", "sí", "si"):
        return "true"
    if v is False or str(v).lower() in ("false", "0", "no"):
        return "false"
    return None


def _seg_options(el: dict) -> list[dict]:
    """Opciones (value/label) de una pregunta usada como filtro o segmento."""
    if el.get("type") == "boolean":
        return [
            {"value": "true", "label": el.get("labelTrue") or "Sí"},
            {"value": "false", "label": el.get("labelFalse") or "No"},
        ]
    if el.get("type") == "rating":
        lo, hi = int(el.get("rateMin", 0)), int(el.get("rateMax", 10))
        return [{"value": str(i), "label": str(i)} for i in range(lo, hi + 1)]
    return [{"value": v, "label": label} for v, label in _choice_pairs(el)]


def filterable_questions(schema: dict) -> list[dict]:
    """Preguntas categóricas que se pueden usar para filtrar o segmentar."""
    out = []
    for el in _elements(schema):
        if el.get("type") in _SEGMENTABLE and el.get("name"):
            out.append(
                {
                    "name": el["name"],
                    "title": el.get("title") or el["name"],
                    "type": el.get("type"),
                    "options": _seg_options(el),
                }
            )
    return out


def _seg_key(el: dict, answer_value: Any) -> Optional[str]:
    """La 'columna' de cross-tab a la que cae una respuesta para esta pregunta.
    Devuelve el value normalizado, o None si la respuesta está vacía."""
    keys = _seg_keys(el, answer_value)
    return keys[0] if keys else None


def _seg_keys(el: dict, answer_value: Any) -> list[str]:
    """Todas las columnas a las que cae una respuesta: una sola para preguntas
    de opción única, una por opción marcada en casillas."""
    if answer_value in (None, "", []):
        return []
    if el.get("type") == "boolean":
        k = _bool_key(answer_value)
        return [k] if k else []
    if el.get("type") == "checkbox":
        return [str(v) for v in _as_list(answer_value)]
    if el.get("type") == "rating":
        try:
            return [str(int(round(float(answer_value))))]
        except (TypeError, ValueError):
            return []
    # Single-choice: el value tal cual (el primero si viniera lista).
    v = answer_value[0] if isinstance(answer_value, list) else answer_value
    return [str(v)]


def _matches_filters(answers: dict, filters: list[dict], by_name: dict) -> bool:
    """AND de todos los filtros: la respuesta pasa si, para cada filtro, su
    valor a esa pregunta está entre los valores pedidos."""
    for f in filters:
        el = by_name.get(f.get("name"))
        if not el:
            return False  # filtro sobre una pregunta inexistente → no matchea
        keys = _seg_keys(el, answers.get(f["name"]))
        wanted = {str(x) for x in (f.get("values") or [])}
        if not keys or not (set(keys) & wanted):
            return False
    return True


def _aggregate(el: dict, answers: list[dict]) -> dict:
    """Agrega una sola pregunta sobre una lista de respuestas (ya filtrada)."""
    qtype = el.get("type")
    name = el.get("name")
    title = el.get("title") or name
    vals = [a.get(name) for a in answers if a.get(name) not in (None, "", [])]
    base = {"name": name, "title": title, "type": qtype, "answered": len(vals)}

    if qtype in _SINGLE_CHOICE or qtype == "checkbox":
        pairs = _choice_pairs(el)
        counts = {v: 0 for v, _ in pairs}
        other = 0
        for v in vals:
            for item in _as_list(v):
                key = str(item)
                if key in counts:
                    counts[key] += 1
                else:
                    other += 1
        options = [{"label": label, "value": v, "count": counts.get(v, 0)} for v, label in pairs]
        if other:
            options.append({"label": "Otros", "value": "__other__", "count": other})
        return {**base, "kind": "choice", "multi": qtype == "checkbox", "options": options}

    if qtype == "boolean":
        t = f = 0
        for v in vals:
            k = _bool_key(v)
            if k == "true":
                t += 1
            elif k == "false":
                f += 1
        return {
            **base, "kind": "choice", "multi": False,
            "options": [
                {"label": el.get("labelTrue") or "Sí", "value": "true", "count": t},
                {"label": el.get("labelFalse") or "No", "value": "false", "count": f},
            ],
        }

    if qtype == "rating":
        lo = int(el.get("rateMin", 0))
        hi = int(el.get("rateMax", 10))
        dist = {i: 0 for i in range(lo, hi + 1)}
        nums: list[float] = []
        for v in vals:
            try:
                n = float(v)
            except (TypeError, ValueError):
                continue
            nums.append(n)
            iv = int(round(n))
            if iv in dist:
                dist[iv] += 1
        out = {
            **base, "kind": "rating", "min": lo, "max": hi,
            "average": round(sum(nums) / len(nums), 2) if nums else None,
            "median": stats.median(nums),
            "stdev": stats.r(stats.stdev(nums)),
            "distribution": [{"value": k, "count": c} for k, c in dist.items()],
        }
        # Top-2 / bottom-2 box: el % en los dos valores de cada punta. Es lo que
        # se reporta en satisfacción: un promedio de 3,5 puede ser "todos tibios"
        # o "mitad encantados, mitad furiosos", y el promedio no lo distingue.
        if nums and hi - lo >= 3:
            out["top2"] = round(100 * sum(1 for n in nums if n >= hi - 1) / len(nums), 1)
            out["bottom2"] = round(100 * sum(1 for n in nums if n <= lo + 1) / len(nums), 1)
        if lo == 0 and hi == 10:
            out["nps"] = _nps_from_distribution(out["distribution"])
        return out

    if qtype == "matrix":
        rows = _choice_pairs({"choices": el.get("rows") or []})
        cols = _choice_pairs({"choices": el.get("columns") or []})
        cells = {rv: {cv: 0 for cv, _ in cols} for rv, _ in rows}
        for v in vals:
            if not isinstance(v, dict):
                continue
            for rv, cv in v.items():
                if str(rv) in cells and str(cv) in cells[str(rv)]:
                    cells[str(rv)][str(cv)] += 1
        return {
            **base, "kind": "matrix",
            "rows": [{"value": rv, "label": rl} for rv, rl in rows],
            "columns": [{"value": cv, "label": cl} for cv, cl in cols],
            "cells": [[cells[rv][cv] for cv, _ in cols] for rv, _ in rows],
        }

    if qtype == "ranking":
        pairs = _choice_pairs(el)
        pos: dict[str, list[int]] = {v: [] for v, _ in pairs}
        for v in vals:
            for i, item in enumerate(_as_list(v)):
                if str(item) in pos:
                    pos[str(item)].append(i + 1)
        items = [
            {"value": v, "label": label, "n": len(pos[v]),
             "avg_position": stats.r(stats.mean(pos[v])),
             "first": sum(1 for p in pos[v] if p == 1)}
            for v, label in pairs
        ]
        items.sort(key=lambda it: (it["avg_position"] is None, it["avg_position"] or 0))
        return {**base, "kind": "ranking", "items": items}

    if qtype in ("text", "number") and el.get("inputType") in ("number", "range") or qtype in ("number", "slider"):
        nums = []
        for v in vals:
            try:
                nums.append(float(v))
            except (TypeError, ValueError):
                continue
        return {
            **base, "kind": "numeric", "n": len(nums),
            "min": min(nums) if nums else None, "max": max(nums) if nums else None,
            "average": stats.r(stats.mean(nums)), "median": stats.median(nums),
            "stdev": stats.r(stats.stdev(nums)), "histogram": stats.histogram(nums),
        }

    if qtype == "text" and el.get("inputType") == "date":
        dias = sorted(str(v)[:10] for v in vals if isinstance(v, str) and len(v) >= 10)
        por_mes: dict[str, int] = {}
        for d in dias:
            por_mes[d[:7]] = por_mes.get(d[:7], 0) + 1
        return {
            **base, "kind": "dates", "n": len(dias),
            "min": dias[0] if dias else None, "max": dias[-1] if dias else None,
            "median": dias[len(dias) // 2] if dias else None,
            "by_month": [{"month": m, "count": c} for m, c in sorted(por_mes.items())],
        }

    if qtype in ("comment", "text", "email"):
        texts = [str(v).strip() for v in vals if str(v).strip()]
        out = {**base, "kind": "text", "values": texts}
        if qtype != "email" and el.get("inputType") != "email":
            out["terms"] = stats.top_terms(texts)
        return out

    if qtype == "signaturepad":
        # La firma es una imagen en base64: no se lista (pesa y no se lee en un
        # resumen); se cuenta cuántas personas firmaron.
        return {**base, "kind": "signature", "signed": len(vals)}

    if qtype in ("videoresponse", "file"):
        files = [str(u) for v in vals for u in _as_list(v) if str(u)]
        return {**base, "kind": "files", "values": files}

    # Unknown/advanced type: still surface a raw sample.
    return {**base, "kind": "text", "values": [str(v) for v in vals][:200]}


def build_report_context(schema: dict, responses: list, funnel: Optional[dict] = None) -> dict:
    """Contexto COMPACTO y ya numérico para el informe ejecutivo por IA.

    Clave del diseño anti-alucinación: acá se calculan todos los números (Python,
    determinístico) y la IA solo los redacta. Para preguntas cerradas mandamos
    conteos/porcentajes/promedios; para abiertas, una muestra de citas textuales
    (que la IA podrá citar, nunca inventar)."""
    summary = build_summary(schema, responses)
    total = summary["total_responses"]
    questions = []
    for q in summary["questions"]:
        item = {"title": q["title"], "kind": q["kind"], "answered": q["answered"]}
        if q["kind"] == "choice":
            item["options"] = [
                {
                    "label": o["label"],
                    "count": o["count"],
                    "percent": round(100 * o["count"] / q["answered"], 1) if q["answered"] else 0,
                }
                for o in q["options"]
            ]
        elif q["kind"] == "rating":
            item["min"] = q["min"]
            item["max"] = q["max"]
            item["average"] = q["average"]
            # NPS clásico si la escala es 0..10.
            if q["min"] == 0 and q["max"] == 10:
                item["nps"] = _nps_from_distribution(q["distribution"])
        elif q["kind"] == "text":
            # Muestra acotada de citas textuales (la IA solo puede citar de acá).
            item["samples"] = [v for v in q["values"][:25]]
        else:
            continue  # archivos/otros no aportan al informe narrativo
        questions.append(item)

    ctx: dict = {"total_responses": total, "questions": questions}
    if funnel:
        views = funnel.get("views", 0) or 0
        completed = funnel.get("completions", 0) or 0
        ctx["funnel"] = {
            "views": views,
            "started": funnel.get("starts", 0),
            "completed": completed,
            "completion_rate": round(100 * completed / views, 1) if views else None,
            "dropoff": [
                {"question": d.get("title") or d.get("question"), "count": d.get("count", 0)}
                for d in (funnel.get("dropoff") or [])[:3]
            ],
        }
    return ctx


def _nps_from_distribution(distribution: list[dict]) -> Optional[dict]:
    """NPS = %promotores (9-10) - %detractores (0-6), sobre una escala 0..10."""
    total = sum(d["count"] for d in distribution)
    if not total:
        return None
    promoters = sum(d["count"] for d in distribution if d["value"] >= 9)
    detractors = sum(d["count"] for d in distribution if d["value"] <= 6)
    passives = total - promoters - detractors
    return {
        "score": round(100 * (promoters - detractors) / total),
        "promoters": promoters,
        "passives": passives,
        "detractors": detractors,
    }


def _when(r) -> Optional[datetime]:
    d = getattr(r, "submitted_at", None)
    if d is not None and d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _in_range(r, date_from: Optional[date], date_to: Optional[date]) -> bool:
    if date_from is None and date_to is None:
        return True
    d = _when(r)
    if d is None:
        return False
    day = d.date()
    return (date_from is None or day >= date_from) and (date_to is None or day <= date_to)


def _timeline(responses: list) -> list[dict]:
    """Respuestas por día (UTC), sin huecos entre el primero y el último."""
    por_dia: dict[date, int] = {}
    for r in responses:
        d = _when(r)
        if d is not None:
            por_dia[d.date()] = por_dia.get(d.date(), 0) + 1
    if not por_dia:
        return []
    from datetime import timedelta

    out, dia, fin = [], min(por_dia), max(por_dia)
    # Tope de dos años de días: más que eso no se lee en un gráfico diario.
    while dia <= fin and len(out) < 731:
        out.append({"date": dia.isoformat(), "count": por_dia.get(dia, 0)})
        dia += timedelta(days=1)
    return out


def _contingency(q: dict, seg_values: list[str]) -> Optional[list[list[int]]]:
    """Tabla opciones × segmentos de una pregunta ya segmentada, para el chi²."""
    by = q.get("by_segment") or {}
    if q["kind"] == "choice":
        if q.get("multi"):
            return None  # casillas: cada opción es su propio sí/no; no aplica
        keys = [o["value"] for o in q["options"]]
        return [
            [next((o["count"] for o in (by.get(sv) or {}).get("options", []) if o["value"] == k), 0)
             for sv in seg_values]
            for k in keys
        ]
    if q["kind"] == "rating":
        # Una fila por valor de la escala deja casi todas las celdas con menos
        # de 5 casos esperados y la prueba nunca resulta confiable. Se agrupa en
        # tramos: detractores/pasivos/promotores en 0-10, tercios en el resto.
        lo, hi = q["min"], q["max"]
        if lo == 0 and hi == 10:
            tramo = lambda v: 0 if v <= 6 else 1 if v <= 8 else 2  # noqa: E731
            n_tramos = 3
        else:
            n_tramos = min(3, hi - lo + 1)
            ancho = (hi - lo + 1) / n_tramos
            tramo = lambda v: min(n_tramos - 1, int((v - lo) / ancho))  # noqa: E731
        table = [[0] * len(seg_values) for _ in range(n_tramos)]
        for j, sv in enumerate(seg_values):
            for d in (by.get(sv) or {}).get("distribution", []):
                table[tramo(d["value"])][j] += d["count"]
        return table
    return None


def build_summary(
    schema: dict,
    responses: list,
    *,
    filters: Optional[list[dict]] = None,
    segment_by: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    hidden_fields: Optional[list[str]] = None,
) -> dict:
    """Resumen por pregunta. Con `filters` restringe el universo de respuestas;
    con `date_from`/`date_to` (inclusive, UTC) lo acota en el tiempo; con
    `segment_by` agrega además un desglose por cada valor de esa pregunta, con
    una prueba chi² que dice si la diferencia entre segmentos es real o ruido.

    Los campos ocultos (`hidden_fields`) entran como preguntas `@nombre`, así
    que se pueden segmentar y filtrar igual que las demás."""
    from app import fields as fields_mod

    extra = fields_mod.hidden_elements(hidden_fields, responses)
    if extra:
        schema = {**(schema or {}), "pages": list((schema or {}).get("pages") or []) + [{"name": "__hidden", "elements": extra}]}
    by_name = {el["name"]: el for el in _elements(schema) if el.get("name")}
    filters = [f for f in (filters or []) if f.get("name") in by_name]

    total = len(responses)
    universe = [r for r in responses if _in_range(r, date_from, date_to)]
    if filters:
        universe = [r for r in universe if _matches_filters(fields_mod.answers_with_hidden(r), filters, by_name)]
    rows = [fields_mod.answers_with_hidden(r) for r in universe]
    tiempos = fields_mod.timing_by_question(universe)

    seg_el = by_name.get(segment_by) if segment_by else None
    if seg_el is not None and seg_el.get("type") not in _SEGMENTABLE:
        seg_el = None

    seg_meta = None
    seg_rows: dict[str, list[dict]] = {}
    if seg_el is not None:
        sname = seg_el["name"]
        label_by_val = {o["value"]: o["label"] for o in _seg_options(seg_el)}
        counts: dict[str, int] = {}
        buckets: dict[str, list[dict]] = {}
        for a in rows:
            for k in _seg_keys(seg_el, a.get(sname)):
                counts[k] = counts.get(k, 0) + 1
                buckets.setdefault(k, []).append(a)
        ordered = [o["value"] for o in _seg_options(seg_el) if o["value"] in counts]
        ordered += [k for k in counts if k not in ordered]
        seg_meta = {
            "name": sname,
            "title": seg_el.get("title") or sname,
            "multi": seg_el.get("type") == "checkbox",
            "values": [
                {"value": k, "label": str(label_by_val.get(k, k)), "count": counts[k],
                 "small": counts[k] < SMALL_SEGMENT}
                for k in ordered
            ],
            "small_sample": any(counts[k] < SMALL_SEGMENT for k in ordered),
        }
        seg_rows = buckets

    questions: list[dict] = []
    for el in _elements(schema):
        qtype = el.get("type")
        name = el.get("name")
        if not name or qtype in _SKIP_TYPES:
            continue
        q = _aggregate(el, rows)
        if el.get("encHidden"):
            q["hidden_field"] = True
        if name in tiempos:
            q["timing"] = tiempos[name]
        if seg_meta is not None and name != seg_meta["name"] and q["kind"] in ("choice", "rating"):
            q["by_segment"] = {
                sv["value"]: _aggregate(el, seg_rows.get(sv["value"], []))
                for sv in seg_meta["values"]
            }
            # Con casillas como segmento una persona cae en varias columnas: las
            # columnas no son independientes y el chi² no aplica.
            if not seg_meta["multi"]:
                table = _contingency(q, [sv["value"] for sv in seg_meta["values"]])
                if table:
                    q["significance"] = stats.chi2_independence(table)
        questions.append(q)

    return {
        "total_responses": total,
        "filtered_responses": len(rows),
        "date_from": date_from.isoformat() if date_from else None,
        "date_to": date_to.isoformat() if date_to else None,
        "timeline": _timeline(universe),
        "filters": [
            {"name": f["name"], "title": by_name[f["name"]].get("title") or f["name"],
             "values": [str(x) for x in (f.get("values") or [])]}
            for f in filters
        ],
        "segment": seg_meta,
        "filterable": filterable_questions(schema),
        "questions": questions,
    }


def crosstab_rows(summary: dict) -> list[list]:
    """El cruce de un resumen segmentado, como planilla: una fila por opción
    de cada pregunta, una columna de conteo y de % por segmento."""
    seg = summary.get("segment")
    if not seg:
        return []
    segs = seg["values"]
    header = ["Pregunta", "Opción"]
    for sv in segs:
        header += [f"{sv['label']} (n)", f"{sv['label']} (%)"]
    header += ["p-valor (chi²)"]
    out: list[list] = [header]
    for q in summary["questions"]:
        by = q.get("by_segment")
        if not by:
            continue
        sig = q.get("significance") or {}
        if q["kind"] == "choice":
            keys = [(o["value"], o["label"]) for o in q["options"]]
            field, vkey = "options", "value"
        else:
            keys = [(d["value"], str(d["value"])) for d in q["distribution"]]
            field, vkey = "distribution", "value"
        for i, (k, label) in enumerate(keys):
            row: list = [q["title"] if i == 0 else "", label]
            for sv in segs:
                sub = by.get(sv["value"]) or {}
                n = next((x["count"] for x in sub.get(field, []) if x[vkey] == k), 0)
                base = sub.get("answered") or 0
                row += [n, round(100 * n / base, 1) if base else ""]
            row.append(sig.get("p", "") if i == 0 else "")
            out.append(row)
    return out
