"""Aggregate raw responses into per-question, chart-ready summaries (the
Google-Forms-style "Resumen" view). Works for every survey, not just exams."""

from typing import Any


_SKIP_TYPES = {"image", "html", "expression", "panel"}
_SINGLE_CHOICE = {"radiogroup", "dropdown", "imagepicker"}


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


def build_summary(schema: dict, responses: list) -> dict:
    answers = [r.answers or {} for r in responses]
    questions: list[dict] = []

    for el in _elements(schema):
        qtype = el.get("type")
        name = el.get("name")
        if not name or qtype in _SKIP_TYPES:
            continue
        title = el.get("title") or name
        vals = [a.get(name) for a in answers if a.get(name) not in (None, "", [])]
        answered = len(vals)
        base = {"name": name, "title": title, "type": qtype, "answered": answered}

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
            questions.append({**base, "kind": "choice", "multi": qtype == "checkbox", "options": options})

        elif qtype == "boolean":
            t = f = 0
            for v in vals:
                if v is True or str(v).lower() in ("true", "1", "sí", "si"):
                    t += 1
                elif v is False or str(v).lower() in ("false", "0", "no"):
                    f += 1
            questions.append({
                **base, "kind": "choice", "multi": False,
                "options": [
                    {"label": el.get("labelTrue") or "Sí", "value": "true", "count": t},
                    {"label": el.get("labelFalse") or "No", "value": "false", "count": f},
                ],
            })

        elif qtype == "rating":
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
            questions.append({
                **base, "kind": "rating", "min": lo, "max": hi,
                "average": round(sum(nums) / len(nums), 2) if nums else None,
                "distribution": [{"value": k, "count": c} for k, c in dist.items()],
            })

        elif qtype in ("comment", "text", "email"):
            texts = [str(v).strip() for v in vals if str(v).strip()]
            questions.append({**base, "kind": "text", "values": texts})

        elif qtype in ("videoresponse", "file"):
            files = [str(u) for v in vals for u in _as_list(v) if str(u)]
            questions.append({**base, "kind": "files", "values": files})

        else:
            # Unknown/advanced type: still surface a raw sample.
            questions.append({**base, "kind": "text", "values": [str(v) for v in vals][:200]})

    return {"total_responses": len(responses), "questions": questions}
