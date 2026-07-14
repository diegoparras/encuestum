"""Aggregate raw responses into per-question, chart-ready summaries (the
Google-Forms-style "Resumen" view). Works for every survey, not just exams.

Supports two optional lenses on top of the plain aggregation:
  - filters: keep only responses whose answer to a question is among some values
    (e.g. only people who chose "Ventas"), applied before aggregating.
  - segment_by: break every question down by the answer to a categorical
    question (cross-tab), e.g. satisfaction split by department.
Both are pure over (schema, responses), so they're cheap to unit-test."""

from typing import Any, Optional


_SKIP_TYPES = {"image", "html", "expression", "panel"}
_SINGLE_CHOICE = {"radiogroup", "dropdown", "imagepicker"}
# Tipos que sirven como dimensión para filtrar / segmentar (categóricos).
_SEGMENTABLE = _SINGLE_CHOICE | {"boolean"}


def _elements(schema: dict) -> list[dict]:
    out: list[dict] = []
    for page in (schema or {}).get("pages", []) or []:
        for el in page.get("elements", []) or []:
            if isinstance(el, dict):
                out.append(el)
    return out


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
    if answer_value in (None, "", []):
        return None
    if el.get("type") == "boolean":
        return _bool_key(answer_value)
    # Single-choice: el value tal cual (el primero si viniera lista).
    v = answer_value[0] if isinstance(answer_value, list) else answer_value
    return str(v)


def _matches_filters(answers: dict, filters: list[dict], by_name: dict) -> bool:
    """AND de todos los filtros: la respuesta pasa si, para cada filtro, su
    valor a esa pregunta está entre los valores pedidos."""
    for f in filters:
        el = by_name.get(f.get("name"))
        if not el:
            return False  # filtro sobre una pregunta inexistente → no matchea
        key = _seg_key(el, answers.get(f["name"]))
        wanted = {str(x) for x in (f.get("values") or [])}
        if key is None or key not in wanted:
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
        return {
            **base, "kind": "rating", "min": lo, "max": hi,
            "average": round(sum(nums) / len(nums), 2) if nums else None,
            "distribution": [{"value": k, "count": c} for k, c in dist.items()],
        }

    if qtype in ("comment", "text", "email"):
        texts = [str(v).strip() for v in vals if str(v).strip()]
        return {**base, "kind": "text", "values": texts}

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


def build_summary(
    schema: dict,
    responses: list,
    *,
    filters: Optional[list[dict]] = None,
    segment_by: Optional[str] = None,
) -> dict:
    """Resumen por pregunta. Con `filters` restringe el universo de respuestas;
    con `segment_by` agrega además un desglose por cada valor de esa pregunta."""
    by_name = {el["name"]: el for el in _elements(schema) if el.get("name")}
    filters = [f for f in (filters or []) if f.get("name") in by_name]

    rows = [r.answers or {} for r in responses]
    total = len(rows)
    if filters:
        rows = [a for a in rows if _matches_filters(a, filters, by_name)]

    seg_el = by_name.get(segment_by) if segment_by else None
    if seg_el is not None and seg_el.get("type") not in _SEGMENTABLE:
        seg_el = None  # solo categóricas sirven de segmento

    # Columnas del cross-tab: las opciones de la pregunta segmento con >0 respuestas.
    seg_meta = None
    seg_rows: dict[str, list[dict]] = {}
    if seg_el is not None:
        sname = seg_el["name"]
        label_by_val = {o["value"]: o["label"] for o in _seg_options(seg_el)}
        counts: dict[str, int] = {}
        buckets: dict[str, list[dict]] = {}
        for a in rows:
            k = _seg_key(seg_el, a.get(sname))
            if k is None:
                continue
            counts[k] = counts.get(k, 0) + 1
            buckets.setdefault(k, []).append(a)
        # Orden estable: primero las opciones definidas, luego cualquier valor libre.
        ordered = [o["value"] for o in _seg_options(seg_el) if o["value"] in counts]
        ordered += [k for k in counts if k not in ordered]
        seg_meta = {
            "name": sname,
            "title": seg_el.get("title") or sname,
            "values": [
                {"value": k, "label": str(label_by_val.get(k, k)), "count": counts[k]}
                for k in ordered
            ],
        }
        seg_rows = buckets

    questions: list[dict] = []
    for el in _elements(schema):
        qtype = el.get("type")
        name = el.get("name")
        if not name or qtype in _SKIP_TYPES:
            continue
        q = _aggregate(el, rows)
        if seg_meta is not None and name != seg_meta["name"] and q["kind"] in ("choice", "rating"):
            q["by_segment"] = {
                sv["value"]: _aggregate(el, seg_rows.get(sv["value"], []))
                for sv in seg_meta["values"]
            }
        questions.append(q)

    return {
        "total_responses": total,
        "filtered_responses": len(rows),
        "filters": [
            {"name": f["name"], "title": by_name[f["name"]].get("title") or f["name"],
             "values": [str(x) for x in (f.get("values") or [])]}
            for f in filters
        ],
        "segment": seg_meta,
        "filterable": filterable_questions(schema),
        "questions": questions,
    }
