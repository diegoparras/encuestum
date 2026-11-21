"""Calidad de las respuestas: señales de que una respuesta no es confiable.

No se excluye nada solo: se marca y se explica, y quien analiza decide (con la
exclusión reversible que ya existe). Tres señales clásicas:

* **Apurada** ("speeder"): tardó menos de un tercio de la mediana. Nadie lee
  veinte preguntas en quince segundos.
* **En línea recta** ("straight-lining"): eligió la misma columna en todas las
  filas de una matriz (≥ 4 filas), o el mismo valor en todas las escalas
  (≥ 4 escalas). Patrón típico de quien responde sin leer.
* **Duplicada**: mismas respuestas que otra, desde la misma conexión (el
  seudónimo de IP) o, sin ese dato, idénticas en todo y con al menos 3
  respuestas no vacías (dos "Sí" iguales no son sospechosos).

Puro: recibe el esquema y las respuestas.
"""

from __future__ import annotations

import json
from typing import Optional

from app import stats

_SPEED_FRACTION = 1 / 3
_MIN_FOR_SPEED = 10  # con menos respuestas, la mediana no dice nada
_MIN_ROWS = 4


def _seconds(r) -> Optional[float]:
    v = ((r.meta or {}).get("server") or {}).get("seconds_since_first_view")
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def completion_seconds(responses: list) -> dict:
    """Mediana y percentiles del tiempo desde la primera vista hasta el envío."""
    secs = sorted(s for s in (_seconds(r) for r in responses) if s is not None)
    if not secs:
        return {"n": 0, "median": None, "p25": None, "p75": None}

    def pct(q: float) -> float:
        return secs[min(len(secs) - 1, int(round(q * (len(secs) - 1))))]

    return {"n": len(secs), "median": stats.median(secs), "p25": pct(0.25), "p75": pct(0.75)}


def device_of(r) -> Optional[str]:
    ua = (((r.meta or {}).get("server") or {}).get("user_agent") or "").lower()
    if not ua:
        return None
    if "ipad" in ua or "tablet" in ua:
        return "tablet"
    if "mobi" in ua or "android" in ua or "iphone" in ua:
        return "mobile"
    return "desktop"


def assess(schema: dict, responses: list) -> dict:
    elements = [
        el
        for p in (schema or {}).get("pages", []) or []
        if isinstance(p, dict)
        for el in p.get("elements", []) or []
        if isinstance(el, dict) and el.get("name")
    ]
    matrices = [el["name"] for el in elements if el.get("type") == "matrix"]
    escalas = [el["name"] for el in elements if el.get("type") == "rating"]

    tiempos = completion_seconds(responses)
    umbral = (
        tiempos["median"] * _SPEED_FRACTION
        if tiempos["median"] and tiempos["n"] >= _MIN_FOR_SPEED
        else None
    )

    firmas: dict[str, list] = {}
    for r in responses:
        ans = {k: v for k, v in (r.answers or {}).items() if v not in (None, "", [], {})}
        if len(ans) < 3:
            continue
        ip = ((r.meta or {}).get("server") or {}).get("ip_hash")
        firma = json.dumps(ans, sort_keys=True, default=str)
        firmas.setdefault(firma, []).append((r, ip))

    flagged: dict[str, dict] = {}

    def marcar(r, motivo: str, detalle: str) -> None:
        f = flagged.setdefault(str(r.id), {"response_id": str(r.id), "reasons": []})
        f["reasons"].append({"code": motivo, "detail": detalle})

    for r in responses:
        s = _seconds(r)
        if umbral is not None and s is not None and s < umbral:
            marcar(r, "speeder", f"{int(s)} s, contra una mediana de {int(tiempos['median'])} s")
        ans = r.answers or {}
        for m in matrices:
            v = ans.get(m)
            if isinstance(v, dict) and len(v) >= _MIN_ROWS and len({str(x) for x in v.values()}) == 1:
                marcar(r, "straight_line", f"la misma opción en las {len(v)} filas de «{m}»")
        vals = [ans.get(e) for e in escalas if ans.get(e) not in (None, "")]
        if len(vals) >= _MIN_ROWS and len({str(x) for x in vals}) == 1:
            marcar(r, "straight_line", f"el mismo valor en {len(vals)} escalas")

    for grupo in firmas.values():
        if len(grupo) < 2:
            continue
        # La primera se considera la original; las demás, duplicadas.
        grupo.sort(key=lambda t: getattr(t[0], "submitted_at", None) or 0)
        primera, ip0 = grupo[0]
        for r, ip in grupo[1:]:
            misma_red = ip is not None and ip == ip0
            marcar(r, "duplicate",
                   "idéntica a otra respuesta" + (", desde la misma conexión" if misma_red else ""))

    return {
        "checked": len(responses),
        "completion": tiempos,
        "speed_threshold_seconds": round(umbral) if umbral else None,
        "flagged": sorted(flagged.values(), key=lambda f: -len(f["reasons"])),
    }
