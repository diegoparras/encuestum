"""Campos ocultos, cupos, tiempo por pregunta y resultados públicos.

* **Campos ocultos** (`Survey.hidden_fields = ["origen", "area"]`): valores que
  llegan en la URL del link (`/s/abc?origen=mail&area=ventas`) y se guardan con
  la respuesta en `meta.hidden`. Sólo se aceptan los nombres declarados, con
  tope de largo: el navegador no puede meter claves arbitrarias. En el resumen
  aparecen como una pregunta más (`@area`), así que sirven para segmentar y
  filtrar como cualquier otra.
* **Cupos** (`Survey.quotas = [{"question": "area", "values": ["ventas"],
  "limit": 50, "message": "..."}]`): cuando se llenó el cupo de un grupo, una
  respuesta más de ese grupo se rechaza con el mensaje del cupo. `question`
  puede ser una pregunta o un campo oculto (`@area`).
* **Tiempo por pregunta** (`meta.timing = {"q1": 12, ...}`, en segundos): lo
  mide el navegador; el servidor lo acota. El resumen muestra la mediana.
* **Resultados públicos** (`Survey.public_results = {"enabled": true,
  "token": "...", "show_text": false, "min_responses": 5}`): un link de solo
  lectura con el resumen. Nunca incluye las preguntas que identifican a la
  persona, y con menos de `min_responses` respuestas no muestra nada (con tres
  respuestas, un "promedio" ya dice quién contestó qué).
"""

from __future__ import annotations

import re
import secrets
from statistics import median
from typing import Any, Optional

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_\-]{0,39}$")
_MAX_HIDDEN = 20
_MAX_HIDDEN_VALUE = 200
_MAX_QUOTAS = 30
_MAX_SECONDS = 6 * 3600
HIDDEN_PREFIX = "@"


# ── Campos ocultos ──────────────────────────────────────────────────────────


def clean_hidden_fields(raw) -> Optional[list[str]]:
    if not raw:
        return None
    if not isinstance(raw, list):
        raise ValueError("Los campos ocultos son una lista de nombres.")
    out: list[str] = []
    for n in raw:
        n = str(n or "").strip()
        if not n:
            continue
        if not _NAME_RE.match(n):
            raise ValueError(f"Nombre de campo oculto inválido: «{n}» (letras, números, _ o -).")
        if n not in out:
            out.append(n)
    if len(out) > _MAX_HIDDEN:
        raise ValueError(f"Hasta {_MAX_HIDDEN} campos ocultos.")
    return out or None


def extract_hidden(declared: Optional[list[str]], raw) -> dict[str, str]:
    """Lo que mandó el navegador, restringido a los campos declarados."""
    if not declared or not isinstance(raw, dict):
        return {}
    out = {}
    for n in declared:
        v = raw.get(n)
        if v is None or isinstance(v, (dict, list)):
            continue
        v = str(v).strip()[:_MAX_HIDDEN_VALUE]
        if v:
            out[n] = v
    return out


def _meta(r) -> dict:
    return getattr(r, "meta", None) or {}


def answers_with_hidden(r) -> dict:
    """Las respuestas con los campos ocultos como `@nombre`."""
    a = dict(r.answers or {})
    for k, v in (_meta(r).get("hidden") or {}).items():
        a[HIDDEN_PREFIX + k] = v
    return a


def hidden_elements(declared: Optional[list[str]], responses: list) -> list[dict]:
    """Elementos sintéticos para el resumen: un desplegable por campo oculto con
    los valores que aparecieron."""
    out = []
    for n in declared or []:
        vals = sorted({str((_meta(r).get("hidden") or {}).get(n)) for r in responses
                       if (_meta(r).get("hidden") or {}).get(n) is not None})
        out.append({"type": "dropdown", "name": HIDDEN_PREFIX + n, "title": n,
                    "choices": vals, "encHidden": True})
    return out


# ── Cupos ───────────────────────────────────────────────────────────────────


def clean_quotas(raw, *, valid_names: set[str]) -> Optional[list[dict]]:
    if not raw:
        return None
    if not isinstance(raw, list):
        raise ValueError("Los cupos son una lista.")
    if len(raw) > _MAX_QUOTAS:
        raise ValueError(f"Hasta {_MAX_QUOTAS} cupos.")
    out = []
    for q in raw:
        if not isinstance(q, dict):
            raise ValueError("Cupo inválido.")
        name = str(q.get("question") or "").strip()
        if name not in valid_names:
            raise ValueError(f"El cupo apunta a «{name}», que no es una pregunta ni un campo oculto.")
        vals = q.get("values")
        if not isinstance(vals, list) or not vals:
            raise ValueError("Cada cupo necesita al menos un valor.")
        try:
            limit = int(q.get("limit"))
        except (TypeError, ValueError):
            raise ValueError("El límite del cupo tiene que ser un número.")
        if limit < 0:
            raise ValueError("El límite del cupo no puede ser negativo.")
        out.append({
            "question": name, "values": [str(v) for v in vals][:50], "limit": limit,
            "message": (str(q.get("message") or "").strip()[:300] or None),
        })
    return out or None


def _matches(value: Any, values: list[str]) -> bool:
    if isinstance(value, list):
        return any(str(v) in values for v in value)
    if isinstance(value, bool):
        return ("true" if value else "false") in values or str(value) in values
    return value is not None and str(value) in values


def quota_hit(quotas: Optional[list[dict]], answers: dict, existing: list[dict]) -> Optional[dict]:
    """El primer cupo lleno al que entraría esta respuesta, o None.
    `answers` y `existing` ya llevan los campos ocultos como `@nombre`."""
    for q in quotas or []:
        if not _matches(answers.get(q["question"]), q["values"]):
            continue
        usados = sum(1 for a in existing if _matches(a.get(q["question"]), q["values"]))
        if usados >= q["limit"]:
            return q
    return None


def quota_status(quotas: Optional[list[dict]], existing: list[dict]) -> list[dict]:
    out = []
    for q in quotas or []:
        usados = sum(1 for a in existing if _matches(a.get(q["question"]), q["values"]))
        out.append({**q, "used": usados, "full": usados >= q["limit"]})
    return out


# ── Tiempo por pregunta ─────────────────────────────────────────────────────


def sanitize_timing(raw, names: set[str]) -> Optional[dict[str, int]]:
    if not isinstance(raw, dict):
        return None
    out = {}
    for k, v in list(raw.items())[:500]:
        if k not in names:
            continue
        try:
            s = int(round(float(v)))
        except (TypeError, ValueError):
            continue
        if 0 <= s <= _MAX_SECONDS:
            out[k] = s
    return out or None


def timing_by_question(responses: list) -> dict[str, dict]:
    tiempos: dict[str, list[int]] = {}
    for r in responses:
        for k, v in (_meta(r).get("timing") or {}).items():
            if isinstance(v, (int, float)):
                tiempos.setdefault(k, []).append(int(v))
    return {k: {"median_seconds": int(median(v)), "n": len(v)} for k, v in tiempos.items() if v}


# ── Resultados públicos ─────────────────────────────────────────────────────

_MIN_PUBLIC = 5


def clean_public_results(raw, current: Optional[dict]) -> Optional[dict]:
    """Normaliza la configuración. El token se genera una vez y se conserva
    (salvo que se pida `regenerate`): apagar y prender no invalida el link."""
    if not raw:
        return {**current, "enabled": False} if current else None
    if not isinstance(raw, dict):
        raise ValueError("Configuración de resultados públicos inválida.")
    token = (current or {}).get("token")
    if not token or raw.get("regenerate"):
        token = secrets.token_urlsafe(16)
    try:
        minimo = int(raw.get("min_responses", (current or {}).get("min_responses", _MIN_PUBLIC)))
    except (TypeError, ValueError):
        minimo = _MIN_PUBLIC
    return {
        "enabled": bool(raw.get("enabled", True)),
        "token": token,
        "show_text": bool(raw.get("show_text", False)),
        "min_responses": max(1, min(1000, minimo)),
    }


def public_summary(summary: dict, *, identifying: set[str], show_text: bool) -> dict:
    """El resumen recortado para mostrar en público."""
    preguntas = []
    for q in summary.get("questions", []):
        if q.get("name") in identifying or q.get("kind") in ("signature", "files"):
            continue
        if q.get("kind") == "text":
            if not show_text:
                continue
            q = {**q, "values": q.get("values", [])[:100]}
        # El tiempo por pregunta es una métrica interna del diseño de la encuesta.
        preguntas.append({k: v for k, v in q.items() if k != "timing"})
    return {
        "total_responses": summary.get("total_responses"),
        "timeline": summary.get("timeline"),
        "questions": preguntas,
    }
