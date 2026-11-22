"""Exámenes: sorteo de preguntas, tiempo límite y señales de integridad.

La configuración vive en `evaluation.integrity` (la misma que ya tenía el
editor para mezclar preguntas y opciones):

    {"shuffleQuestions": true,      # orden aleatorio de preguntas
     "shuffleChoices": true,        # orden aleatorio de opciones
     "timeLimitSec": 2400,          # tiempo límite, controlado por el SERVIDOR
     "groups": {"unidad1": 3},      # de las preguntas del grupo, 3 al azar
     "signals": true}               # registrar señales (pestaña, pegado)

Las preguntas sorteables llevan `encGroup` en su elemento. Cada persona tiene
un intento (`SurveyAttempt`) con su hora de inicio y las preguntas que le
tocaron: el sorteo se hace UNA vez (recargar no cambia las preguntas) y la
corrección cuenta sólo las que le tocaron. Antes el tiempo límite era sólo un
temporizador del navegador: alcanzaba con recargar o tocar el reloj.

Integridad: las señales se registran y se muestran; nunca bloquean ni anulan
un examen por sí solas. Decide el docente.
"""

from __future__ import annotations

import copy
import random
from typing import Optional

GRACE_S = 45  # tolerancia de red al vencer el tiempo
_LONG_PASTE = 200  # caracteres pegados de una vez que vale la pena señalar


def settings(evaluation: Optional[dict]) -> Optional[dict]:
    """La configuración de examen que necesita un intento en el servidor, o
    None si no hay nada que controlar (sin tiempo, sin sorteo, sin señales)."""
    if not evaluation or not evaluation.get("enabled"):
        return None
    ex = evaluation.get("integrity") or {}
    try:
        limite = int(ex.get("timeLimitSec") or 0)
    except (TypeError, ValueError):
        limite = 0
    grupos = {}
    for k, v in (ex.get("groups") or {}).items():
        try:
            if int(v) > 0:
                grupos[str(k)] = int(v)
        except (TypeError, ValueError):
            continue
    out = {
        "timeLimitSec": limite if limite > 0 else None,
        "shuffleQuestions": bool(ex.get("shuffleQuestions")),
        "shuffleChoices": bool(ex.get("shuffleChoices")),
        "groups": grupos,
        "signals": bool(ex.get("signals")),
    }
    activo = out["timeLimitSec"] or grupos or out["signals"]
    return out if activo else None


def _elements(schema: dict):
    for p in (schema or {}).get("pages", []) or []:
        if isinstance(p, dict):
            for el in p.get("elements", []) or []:
                if isinstance(el, dict):
                    yield el


def grouped(schema: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for el in _elements(schema):
        g = el.get("encGroup")
        if g and el.get("name"):
            out.setdefault(str(g), []).append(el["name"])
    return out


def draw(schema: dict, groups: dict[str, int], seed: str) -> list[str]:
    """Las preguntas sorteadas de cada grupo (determinístico por `seed`)."""
    rng = random.Random(seed)
    elegidas: list[str] = []
    for g, nombres in sorted(grouped(schema).items()):
        n = groups.get(g)
        if n is None or n >= len(nombres):
            elegidas.extend(nombres)
        else:
            elegidas.extend(rng.sample(nombres, n))
    return elegidas


def excluded(schema: dict, drawn: Optional[list[str]]) -> set[str]:
    """Las preguntas de grupos que NO le tocaron a esta persona."""
    if drawn is None:
        return set()
    todas = {n for ns in grouped(schema).values() for n in ns}
    return todas - set(drawn)


def personal_schema(schema: dict, drawn: Optional[list[str]], cfg: dict) -> dict:
    """El esquema que ve esta persona: sin las preguntas que no le tocaron (ni
    sus imágenes o videos acompañantes) y con el orden aleatorio pedido."""
    fuera = excluded(schema, drawn)
    s = copy.deepcopy(schema or {})
    for p in s.get("pages", []) or []:
        if not isinstance(p, dict):
            continue
        p["elements"] = [
            el for el in p.get("elements", []) or []
            if not (isinstance(el, dict) and (
                el.get("name") in fuera
                or any(el.get("name") == f"{n}{suf}" for n in fuera for suf in ("__img", "__vid"))
            ))
        ]
        if cfg.get("shuffleQuestions"):
            p["questionsOrder"] = "random"
        if cfg.get("shuffleChoices"):
            for el in p["elements"]:
                if isinstance(el, dict) and el.get("choices"):
                    el["choicesOrder"] = "random"
    return s


def evaluation_for(evaluation: Optional[dict], schema: dict, drawn: Optional[list[str]]) -> dict:
    """La corrección restringida a lo que le tocó: una pregunta que no se le
    mostró no puede contar como 0 sobre su puntaje."""
    ev = copy.deepcopy(evaluation or {})
    fuera = excluded(schema, drawn)
    if fuera:
        ev["questions"] = {k: v for k, v in (ev.get("questions") or {}).items() if k not in fuera}
    return ev


def sanitize_integrity(raw) -> Optional[dict]:
    """Lo que manda el navegador sobre integridad, acotado y tipado."""
    if not isinstance(raw, dict):
        return None
    def num(v, tope):
        try:
            return max(0, min(tope, int(v)))
        except (TypeError, ValueError):
            return 0
    pastes = []
    for p in (raw.get("pastes") or [])[:50]:
        if isinstance(p, dict) and isinstance(p.get("question"), str):
            pastes.append({"question": p["question"][:100], "chars": num(p.get("chars"), 1_000_000)})
    return {
        "tab_switches": num(raw.get("tab_switches"), 10_000),
        "hidden_seconds": num(raw.get("hidden_seconds"), 86_400),
        "pastes": pastes,
    }


def flags(integrity: Optional[dict], *, exam_seconds: Optional[int], late_seconds: int, titles: dict) -> list[dict]:
    """Señales legibles para el docente. Son indicios, no veredictos."""
    out: list[dict] = []
    if late_seconds > 0:
        out.append({"code": "late", "detail": f"Entregó {late_seconds // 60} min {late_seconds % 60} s después del tiempo límite"})
    if integrity:
        if integrity["tab_switches"]:
            out.append({
                "code": "tab_switches",
                "detail": f"Salió de la pestaña {integrity['tab_switches']} "
                          f"{'vez' if integrity['tab_switches'] == 1 else 'veces'}"
                          f" ({integrity['hidden_seconds']} s fuera)",
            })
        for p in integrity["pastes"]:
            if p["chars"] >= _LONG_PASTE:
                out.append({"code": "paste",
                            "detail": f"Pegó {p['chars']} caracteres en «{titles.get(p['question'], p['question'])}»"})
    if exam_seconds is not None and exam_seconds < 60:
        out.append({"code": "fast", "detail": f"Terminó en {exam_seconds} s"})
    return out
