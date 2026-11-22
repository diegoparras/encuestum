"""Importar y exportar preguntas en los formatos que usan los docentes.

* **GIFT** (Moodle): el formato de texto más usado para bancos de preguntas.
* **Aiken**: opción única en texto plano (pregunta, opciones A./B./…, ANSWER: X).
* **Moodle XML**: lo que exporta e importa el banco de preguntas de Moodle.

Todo se convierte a lo que entiende Encuestum: un elemento de SurveyJS (la
pregunta) más su configuración de corrección (`evaluation.questions[name]`).
Lo que no tiene equivalente (emparejamiento, cloze, cálculo) se informa en
`warnings` en vez de importarse a medias.

Seguridad del XML: se rechaza cualquier DOCTYPE/ENTITY (bombas de entidades,
XXE) antes de parsear, y hay un tope de tamaño.
"""

from __future__ import annotations

import html
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

MAX_BYTES = 5 * 1024 * 1024


class InterchangeError(ValueError):
    pass


@dataclass
class Imported:
    element: dict
    grading: dict


@dataclass
class ImportResult:
    questions: list[Imported] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ── Nombres de campo ─────────────────────────────────────────────────────────


def _slug(text: str, n: int) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    t = re.sub(r"[^a-z0-9]+", "_", t).strip("_")[:24] or "pregunta"
    return f"{t}_{n}"


class _Namer:
    def __init__(self, taken: set[str]):
        self.taken = set(taken)
        self.n = 0

    def __call__(self, title: str) -> str:
        while True:
            self.n += 1
            name = _slug(title, self.n)
            if name not in self.taken:
                self.taken.add(name)
                return name


def _q(namer, qtype: str, title: str, *, choices=None, correct=None, points: float = 1.0, **extra) -> Imported:
    name = namer(title)
    el: dict = {"type": qtype, "name": name, "title": title}
    if choices is not None:
        el["choices"] = choices
    grading: dict = {"gradable": True, "points": points, "title": title}
    if qtype in ("comment",):
        grading.update(grader="llm", modelAnswer=extra.pop("modelAnswer", ""), keyConcepts=[], rubric=[])
    else:
        grading.update(grader="auto", correct=correct)
    for k, v in extra.items():
        if k.startswith("el_"):
            el[k[3:]] = v
        else:
            grading[k] = v
    return Imported(el, grading)


# ── GIFT ─────────────────────────────────────────────────────────────────────

_GIFT_ESC = {"\\~": "\x00T", "\\=": "\x00E", "\\#": "\x00H", "\\{": "\x00A", "\\}": "\x00C", "\\:": "\x00D"}


def _gift_unesc(s: str) -> str:
    for k, v in _GIFT_ESC.items():
        s = s.replace(v, k[1])
    s = re.sub(r"^\[(html|moodle|plain|markdown)\]", "", s.strip())
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def _gift_answers(body: str) -> list[tuple[str, str, Optional[float]]]:
    """[(signo, texto, peso%)] de "=a ~b ~%50%c"; descarta el feedback (#)."""
    out = []
    for m in re.finditer(r"([=~])(%-?\d+(?:\.\d+)?%)?([^=~]*)", body):
        sign, weight, text = m.group(1), m.group(2), m.group(3)
        text = text.split("#", 1)[0]
        w = float(weight.strip("%")) if weight else None
        if text.strip():
            out.append((sign, _gift_unesc(text), w))
    return out


def parse_gift(text: str, taken: set[str] | None = None) -> ImportResult:
    namer = _Namer(taken or set())
    res = ImportResult()
    s = text
    for k, v in _GIFT_ESC.items():
        s = s.replace(k, v)
    s = "\n".join(line for line in s.splitlines() if not line.strip().startswith("//"))
    s = re.sub(r"^\$CATEGORY:.*$", "", s, flags=re.M)
    bloques = [b.strip() for b in re.split(r"\n\s*\n", s) if b.strip()]
    for b in bloques:
        m = re.match(r"^(?:::(.*?)::)?(.*?)\{(.*)\}(.*)$", b, flags=re.S)
        if not m:
            res.warnings.append(f"No se reconoce como pregunta GIFT: «{_gift_unesc(b)[:60]}»")
            continue
        enunciado = _gift_unesc((m.group(2) + " " + m.group(4)).strip()) or _gift_unesc(m.group(1) or "")
        cuerpo = m.group(3).strip()
        if "->" in cuerpo:
            res.warnings.append(f"Emparejamiento no soportado: «{enunciado[:60]}»")
            continue
        up = cuerpo.upper()
        if up in ("T", "TRUE", "F", "FALSE"):
            res.questions.append(_q(namer, "boolean", enunciado, correct=up.startswith("T")))
            continue
        if cuerpo == "":
            res.questions.append(_q(namer, "comment", enunciado))
            continue
        if cuerpo.startswith("#"):
            num = cuerpo[1:].split("=", 1)[-1].split("#", 1)[0].strip()
            try:
                if ":" in num:
                    val, tol = num.split(":", 1)
                    correct, tolerance = float(val), float(tol)
                elif ".." in num:
                    lo, hi = (float(x) for x in num.split(".."))
                    correct, tolerance = (lo + hi) / 2, (hi - lo) / 2
                else:
                    correct, tolerance = float(num), 0.0
            except ValueError:
                res.warnings.append(f"Respuesta numérica inválida: «{enunciado[:60]}»")
                continue
            res.questions.append(
                _q(namer, "text", enunciado, correct=correct, tolerance=tolerance, el_inputType="number")
            )
            continue
        ans = _gift_answers(cuerpo)
        if not ans:
            res.warnings.append(f"Sin respuestas: «{enunciado[:60]}»")
            continue
        correctas = [t for sign, t, w in ans if sign == "=" or (w is not None and w > 0)]
        incorrectas = [t for sign, t, w in ans if sign == "~" and not (w is not None and w > 0)]
        if not incorrectas and all(sign == "=" for sign, _, _ in ans):
            res.questions.append(_q(namer, "text", enunciado, correct=correctas))
        elif len(correctas) > 1 or any(w is not None and 0 < w < 100 for _, _, w in ans):
            opciones = [t for _, t, _ in ans]
            res.questions.append(
                _q(namer, "checkbox", enunciado, choices=opciones, correct=correctas, partialCredit=True)
            )
        elif correctas:
            opciones = [t for _, t, _ in ans]
            res.questions.append(_q(namer, "radiogroup", enunciado, choices=opciones, correct=correctas[0]))
        else:
            res.warnings.append(f"Sin respuesta correcta: «{enunciado[:60]}»")
    return res


# ── Aiken ────────────────────────────────────────────────────────────────────


def parse_aiken(text: str, taken: set[str] | None = None) -> ImportResult:
    namer = _Namer(taken or set())
    res = ImportResult()
    lineas = [line.rstrip() for line in text.splitlines()]
    enunciado: list[str] = []
    opciones: list[tuple[str, str]] = []
    for line in lineas + [""]:
        if not line.strip():
            continue
        m_opt = re.match(r"^([A-Z])[.)]\s+(.*)$", line.strip())
        m_ans = re.match(r"^ANSWER:\s*([A-Z])\s*$", line.strip(), flags=re.I)
        if m_ans:
            letra = m_ans.group(1).upper()
            textos = dict(opciones)
            if enunciado and letra in textos:
                res.questions.append(
                    _q(namer, "radiogroup", " ".join(enunciado), choices=[t for _, t in opciones], correct=textos[letra])
                )
            else:
                res.warnings.append(f"Pregunta Aiken incompleta: «{' '.join(enunciado)[:60]}»")
            enunciado, opciones = [], []
        elif m_opt and enunciado:
            opciones.append((m_opt.group(1), m_opt.group(2).strip()))
        else:
            if opciones:  # empezó otra pregunta sin ANSWER
                res.warnings.append(f"Falta ANSWER: «{' '.join(enunciado)[:60]}»")
                enunciado, opciones = [], []
            enunciado.append(line.strip())
    return res


# ── Moodle XML ───────────────────────────────────────────────────────────────


def _txt(node: Optional[ET.Element]) -> str:
    if node is None:
        return ""
    t = node.find("text")
    raw = (t.text if t is not None else node.text) or ""
    return html.unescape(re.sub(r"<[^>]+>", " ", raw)).strip().replace("  ", " ")


def parse_moodle_xml(text: str, taken: set[str] | None = None) -> ImportResult:
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise InterchangeError("El archivo supera los 5 MB.")
    if re.search(r"<!(DOCTYPE|ENTITY)", text, flags=re.I):
        raise InterchangeError("El XML trae DOCTYPE/ENTITY: no se procesa por seguridad.")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise InterchangeError(f"XML inválido: {exc}") from exc
    namer = _Namer(taken or set())
    res = ImportResult()
    for q in root.iter("question"):
        tipo = q.get("type", "")
        if tipo == "category":
            continue
        titulo = _txt(q.find("questiontext")) or _txt(q.find("name"))
        try:
            puntos = float((q.findtext("defaultgrade") or "1").strip() or 1)
        except ValueError:
            puntos = 1.0
        answers = [(float(a.get("fraction", "0") or 0), _txt(a), a) for a in q.findall("answer")]
        if tipo == "multichoice":
            single = (q.findtext("single") or "true").strip().lower() in ("true", "1")
            opciones = [t for _, t, _ in answers]
            correctas = [t for f, t, _ in answers if f > 0]
            if single:
                best = max(answers, key=lambda a: a[0])[1] if answers else None
                res.questions.append(_q(namer, "radiogroup", titulo, choices=opciones, correct=best, points=puntos))
            else:
                res.questions.append(
                    _q(namer, "checkbox", titulo, choices=opciones, correct=correctas, points=puntos, partialCredit=True)
                )
        elif tipo == "truefalse":
            verdadera = next((t for f, t, _ in answers if f >= 100), "true").lower()
            res.questions.append(_q(namer, "boolean", titulo, correct=verdadera in ("true", "verdadero"), points=puntos))
        elif tipo == "shortanswer":
            res.questions.append(_q(namer, "text", titulo, correct=[t for f, t, _ in answers if f >= 100], points=puntos))
        elif tipo == "numerical":
            ok = next((a for a in answers if a[0] >= 100), None)
            if ok is None:
                res.warnings.append(f"Numérica sin respuesta: «{titulo[:60]}»")
                continue
            try:
                tol = float(ok[2].findtext("tolerance") or 0)
                val = float(ok[1])
            except ValueError:
                res.warnings.append(f"Numérica inválida: «{titulo[:60]}»")
                continue
            res.questions.append(
                _q(namer, "text", titulo, correct=val, tolerance=tol, points=puntos, el_inputType="number")
            )
        elif tipo == "essay":
            modelo = _txt(q.find("graderinfo"))
            res.questions.append(_q(namer, "comment", titulo, points=puntos, modelAnswer=modelo))
        else:
            res.warnings.append(f"Tipo «{tipo}» no soportado: «{titulo[:60]}»")
    return res


def detect_and_parse(text: str, fmt: str = "auto", taken: set[str] | None = None) -> ImportResult:
    t = text.lstrip("﻿").strip()
    if not t:
        raise InterchangeError("El archivo está vacío.")
    if fmt == "auto":
        if t.startswith("<"):
            fmt = "moodle"
        elif re.search(r"^ANSWER:\s*[A-Z]\s*$", t, flags=re.M | re.I):
            fmt = "aiken"
        else:
            fmt = "gift"
    parser = {"gift": parse_gift, "aiken": parse_aiken, "moodle": parse_moodle_xml}.get(fmt)
    if parser is None:
        raise InterchangeError("Formato desconocido: usá GIFT, Aiken o Moodle XML.")
    return parser(t, taken)


# ── Exportar ─────────────────────────────────────────────────────────────────


def _items(schema: dict, evaluation: Optional[dict]):
    qcfg = (evaluation or {}).get("questions", {}) or {}
    for p in (schema or {}).get("pages", []) or []:
        for el in (p.get("elements") or []) if isinstance(p, dict) else []:
            if not isinstance(el, dict) or not el.get("name") or el.get("type") in ("html", "image", "panel"):
                continue
            if el["name"].endswith(("__img", "__vid")):
                continue
            yield el, qcfg.get(el["name"]) or {}


def _choice_texts(el: dict) -> list[str]:
    return [str(c.get("text", c.get("value"))) if isinstance(c, dict) else str(c) for c in el.get("choices") or []]


def _as_list(v) -> list:
    return v if isinstance(v, list) else ([] if v is None else [v])


def _gift_esc(s: str) -> str:
    return re.sub(r"([~=#{}:])", r"\\\1", str(s))


def export_gift(schema: dict, evaluation: Optional[dict]) -> tuple[str, list[str]]:
    out, avisos = [], []
    for el, c in _items(schema, evaluation):
        t, titulo = el.get("type"), _gift_esc(el.get("title") or el["name"])
        cab = f"::{_gift_esc(el['name'])}:: {titulo} "
        correct = c.get("correct")
        if t in ("radiogroup", "dropdown", "imagepicker"):
            ok = {str(x) for x in _as_list(correct)}
            ops = " ".join(("=" if o in ok else "~") + _gift_esc(o) for o in _choice_texts(el))
            out.append(f"{cab}{{{ops}}}")
        elif t == "checkbox":
            ops_l = _choice_texts(el)
            ok = {str(x) for x in _as_list(correct)}
            n_ok = max(1, len(ok))
            peso_mal = -100 // max(1, len(ops_l) - n_ok) if len(ops_l) > n_ok else -100
            ops = " ".join(f"~%{round(100 / n_ok, 5) if o in ok else peso_mal}%{_gift_esc(o)}" for o in ops_l)
            out.append(f"{cab}{{{ops}}}")
        elif t == "boolean":
            out.append(f"{cab}{{{'T' if correct else 'F'}}}")
        elif t == "text" and el.get("inputType") == "number" or t == "slider":
            tol = c.get("tolerance") or 0
            out.append(f"{cab}{{#{correct}:{tol}}}" if correct is not None else f"{cab}{{#0:0}}")
        elif t in ("text",):
            ok = _as_list(correct)
            out.append(f"{cab}{{{' '.join('=' + _gift_esc(x) for x in ok)}}}" if ok else f"{cab}{{}}")
        elif t == "comment":
            out.append(f"{cab}{{}}")
        else:
            avisos.append(f"«{el.get('title') or el['name']}» ({t}) no tiene equivalente en GIFT")
    return "\n\n".join(out) + "\n", avisos


def export_moodle_xml(schema: dict, evaluation: Optional[dict]) -> tuple[str, list[str]]:
    quiz = ET.Element("quiz")
    avisos = []

    def base(tipo: str, el: dict, c: dict) -> ET.Element:
        q = ET.SubElement(quiz, "question", type=tipo)
        ET.SubElement(ET.SubElement(q, "name"), "text").text = el["name"]
        qt = ET.SubElement(q, "questiontext", format="html")
        ET.SubElement(qt, "text").text = html.escape(el.get("title") or el["name"])
        ET.SubElement(q, "defaultgrade").text = str(c.get("points", 1))
        return q

    def answer(q: ET.Element, fraction: float, text: str) -> ET.Element:
        a = ET.SubElement(q, "answer", fraction=str(round(fraction, 5)), format="html")
        ET.SubElement(a, "text").text = html.escape(str(text))
        return a

    for el, c in _items(schema, evaluation):
        t = el.get("type")
        correct = c.get("correct")
        if t in ("radiogroup", "dropdown", "imagepicker", "checkbox"):
            q = base("multichoice", el, c)
            ok = {str(x) for x in _as_list(correct)}
            single = t != "checkbox"
            ET.SubElement(q, "single").text = "true" if single else "false"
            ET.SubElement(q, "shuffleanswers").text = "1"
            n_ok = max(1, len(ok))
            for o in _choice_texts(el):
                answer(q, (100 if single else 100 / n_ok) if o in ok else 0, o)
        elif t == "boolean":
            q = base("truefalse", el, c)
            answer(q, 100 if correct else 0, "true")
            answer(q, 0 if correct else 100, "false")
        elif (t == "text" and el.get("inputType") == "number") or t == "slider":
            q = base("numerical", el, c)
            a = answer(q, 100, correct if correct is not None else 0)
            ET.SubElement(a, "tolerance").text = str(c.get("tolerance") or 0)
        elif t == "text":
            q = base("shortanswer", el, c)
            for x in _as_list(correct):
                answer(q, 100, x)
        elif t == "comment":
            q = base("essay", el, c)
            gi = ET.SubElement(q, "graderinfo", format="html")
            ET.SubElement(gi, "text").text = html.escape(c.get("modelAnswer") or "")
        else:
            avisos.append(f"«{el.get('title') or el['name']}» ({t}) no tiene equivalente en Moodle XML")
    ET.indent(quiz)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(quiz, encoding="unicode") + "\n", avisos
