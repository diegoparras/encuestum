"""Encuestas en varios idiomas.

Las traducciones NO viven dentro del esquema: el editor visual lo reconstruye
entero al guardar y las perdería. Se guardan aparte, en `Survey.translations`,
como memoria de traducción por idioma:

    {"en": {"¿Qué turno cursás?": "Which shift do you attend?", ...}, "pt": {...}}

Al servir la encuesta se arma el esquema localizado de SurveyJS
(`{"default": "...", "en": "..."}`) con las traducciones cuyo texto de origen
sigue existiendo. Si alguien edita una pregunta, su texto nuevo no tiene
traducción y se muestra en el idioma original hasta volver a traducir: nunca
aparece una traducción vieja de un texto que ya no existe.

Los VALORES de las opciones no se traducen (son lo que se guarda como
respuesta y contra lo que se corrige): sólo el texto que se ve.
"""

from __future__ import annotations

import copy
import re
from typing import Iterator, Optional

LANGS = {"es", "en", "pt", "fr", "it", "de", "zh", "ja", "ca", "gl", "eu", "nl", "pl", "ru", "ar", "ko"}
_TEXT_KEYS = ("title", "description", "placeholder", "labelTrue", "labelFalse",
              "minRateDescription", "maxRateDescription", "otherText", "commentText",
              "requiredErrorText", "completeText", "pageNextText", "pagePrevText")
_ROOT_KEYS = ("title", "description", "completedHtml")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
MAX_TEXTS = 2000


def _traducible(s) -> bool:
    return isinstance(s, str) and bool(s.strip()) and bool(_LETTER.search(s)) and len(s) <= 5000


def _base_text(v) -> Optional[str]:
    """El texto de origen: un string, o la clave `default` de uno localizado."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and isinstance(v.get("default"), str):
        return v["default"]
    return None


def _elements(container: dict) -> Iterator[dict]:
    for el in container.get("elements", []) or []:
        if isinstance(el, dict):
            yield el
            if el.get("type") in ("panel", "paneldynamic"):
                yield from _elements(el if el.get("type") == "panel" else {"elements": el.get("templateElements") or []})


def _slots(schema: dict) -> Iterator[tuple[dict, str]]:
    """Cada (contenedor, clave) que tiene un texto visible."""
    for k in _ROOT_KEYS:
        yield schema, k
    for p in schema.get("pages", []) or []:
        if not isinstance(p, dict):
            continue
        yield p, "title"
        yield p, "description"
        for el in _elements(p):
            for k in _TEXT_KEYS:
                yield el, k
            for lista in ("choices", "rows", "columns", "rateValues"):
                for i, c in enumerate(el.get(lista) or []):
                    if isinstance(c, dict):
                        yield c, "text"
                    elif isinstance(c, (str, int, float)):
                        # Una opción sin texto propio: se convierte a {value, text}
                        # al localizar. Acá se marca con un contenedor sintético.
                        yield {"__list": el[lista], "__i": i}, "__plain"


def source_texts(schema: dict) -> list[str]:
    """Los textos a traducir, sin repetidos y en orden de aparición."""
    vistos: dict[str, None] = {}
    for cont, k in _slots(schema or {}):
        if k == "__plain":
            v = cont["__list"][cont["__i"]]
            s = v if isinstance(v, str) else None
        else:
            s = _base_text(cont.get(k))
        if _traducible(s):
            vistos.setdefault(s, None)
        if len(vistos) >= MAX_TEXTS:
            break
    return list(vistos)


def localize(schema: dict, translations: Optional[dict]) -> dict:
    """El esquema con los textos traducidos en el formato de SurveyJS."""
    if not translations:
        return schema
    out = copy.deepcopy(schema or {})

    def loc(s: str):
        por_idioma = {lang: m[s] for lang, m in translations.items() if isinstance(m, dict) and m.get(s)}
        return {"default": s, **por_idioma} if por_idioma else None

    for cont, k in list(_slots(out)):
        if k == "__plain":
            v = cont["__list"][cont["__i"]]
            if isinstance(v, str) and (texto := loc(v)):
                cont["__list"][cont["__i"]] = {"value": v, "text": texto}
            continue
        v = cont.get(k)
        s = _base_text(v)
        if not _traducible(s):
            continue
        texto = loc(s)
        if texto:
            cont[k] = {**(v if isinstance(v, dict) else {}), **texto}
    return out


def coverage(schema: dict, translations: Optional[dict]) -> list[dict]:
    textos = source_texts(schema)
    out = []
    for lang, m in sorted((translations or {}).items()):
        m = m if isinstance(m, dict) else {}
        hechos = sum(1 for s in textos if m.get(s))
        out.append({"language": lang, "total": len(textos), "translated": hechos,
                    "missing": len(textos) - hechos, "unused": sum(1 for s in m if s not in set(textos))})
    return out


def prune(schema: dict, translations: Optional[dict]) -> dict:
    """Saca de la memoria los textos que ya no existen en la encuesta."""
    vivos = set(source_texts(schema))
    return {lang: {s: t for s, t in (m or {}).items() if s in vivos} for lang, m in (translations or {}).items()}


_PLACEHOLDER = re.compile(r"\{[^{}]+\}")


def check_translation(src: str, dst: str) -> Optional[str]:
    """Un error si la traducción rompe algo que no se traduce: los marcadores
    {nombre} (piping de SurveyJS) tienen que quedar iguales."""
    if not isinstance(dst, str) or not dst.strip():
        return "traducción vacía"
    if sorted(_PLACEHOLDER.findall(src)) != sorted(_PLACEHOLDER.findall(dst)):
        return f"los marcadores {{…}} tienen que quedar iguales ({', '.join(_PLACEHOLDER.findall(src))})"
    return None
