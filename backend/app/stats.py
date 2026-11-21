"""Estadística sin dependencias: lo justo para el resumen y el análisis de ítems.

Todo es puro (listas de números adentro, números afuera) y determinístico. No se
usa scipy/numpy a propósito: la imagen es una sola y esto son unas decenas de
líneas, contra decenas de megas de dependencias.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from typing import Iterable, Optional, Sequence


# ── Descriptivos ─────────────────────────────────────────────────────────────


def mean(xs: Sequence[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def median(xs: Sequence[float]) -> Optional[float]:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    return float(s[mid]) if n % 2 else (s[mid - 1] + s[mid]) / 2


def stdev(xs: Sequence[float]) -> Optional[float]:
    """Desvío estándar muestral (n-1). None con menos de 2 valores."""
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def variance_pop(xs: Sequence[float]) -> float:
    if not xs:
        return 0.0
    m = sum(xs) / len(xs)
    return sum((x - m) ** 2 for x in xs) / len(xs)


def histogram(xs: Sequence[float], bins: int = 10) -> list[dict]:
    """Intervalos de igual ancho entre el mínimo y el máximo."""
    if not xs:
        return []
    lo, hi = min(xs), max(xs)
    if lo == hi:
        return [{"from": lo, "to": hi, "count": len(xs)}]
    bins = max(1, min(bins, len(set(xs))))
    width = (hi - lo) / bins
    counts = [0] * bins
    for x in xs:
        counts[min(bins - 1, int((x - lo) / width))] += 1
    return [
        {"from": round(lo + i * width, 4), "to": round(lo + (i + 1) * width, 4), "count": c}
        for i, c in enumerate(counts)
    ]


def r(x: Optional[float], nd: int = 2) -> Optional[float]:
    return None if x is None else round(x, nd)


# ── Chi-cuadrado ─────────────────────────────────────────────────────────────


def _gammainc_upper_regularized(a: float, x: float) -> float:
    """Q(a, x) = Γ(a, x) / Γ(a). Serie para x < a+1, fracción continua si no
    (Numerical Recipes, gser/gcf). Alcanza de sobra para p-values."""
    if x <= 0:
        return 1.0
    gln = math.lgamma(a)
    if x < a + 1:
        ap, s, d = a, 1.0 / a, 1.0 / a
        for _ in range(500):
            ap += 1
            d *= x / ap
            s += d
            if abs(d) < abs(s) * 1e-12:
                break
        return 1.0 - s * math.exp(-x + a * math.log(x) - gln)
    b = x + 1 - a
    c = 1.0 / 1e-300
    d = 1.0 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return math.exp(-x + a * math.log(x) - gln) * h


def chi2_sf(chi2: float, dof: int) -> float:
    """P(X > chi2) para una chi-cuadrado con `dof` grados de libertad."""
    if dof <= 0:
        return 1.0
    return max(0.0, min(1.0, _gammainc_upper_regularized(dof / 2.0, chi2 / 2.0)))


def chi2_independence(table: list[list[int]]) -> Optional[dict]:
    """Prueba de independencia sobre una tabla de contingencia (filas = opciones
    de la pregunta, columnas = segmentos). Se descartan filas y columnas vacías.

    `reliable` es False cuando más del 20% de las celdas esperan menos de 5
    casos (la regla de Cochran): ahí el p-value no es confiable y se avisa en
    vez de anunciar una diferencia que puede ser ruido."""
    rows = [row for row in table if sum(row) > 0]
    if len(rows) < 2:
        return None
    cols = [j for j in range(len(rows[0])) if sum(row[j] for row in rows) > 0]
    if len(cols) < 2:
        return None
    t = [[row[j] for j in cols] for row in rows]
    n = sum(sum(row) for row in t)
    rsum = [sum(row) for row in t]
    csum = [sum(row[j] for row in t) for j in range(len(cols))]
    chi2 = 0.0
    small = 0
    cells = 0
    for i, row in enumerate(t):
        for j, obs in enumerate(row):
            exp = rsum[i] * csum[j] / n
            cells += 1
            if exp < 5:
                small += 1
            if exp > 0:
                chi2 += (obs - exp) ** 2 / exp
    dof = (len(t) - 1) * (len(cols) - 1)
    p = chi2_sf(chi2, dof)
    # V de Cramér: tamaño del efecto, comparable entre tablas de distinto tamaño.
    k = min(len(t), len(cols)) - 1
    v = math.sqrt(chi2 / (n * k)) if n and k else None
    return {
        "chi2": round(chi2, 3),
        "dof": dof,
        "p": round(p, 4),
        "cramers_v": r(v, 3),
        "n": n,
        "reliable": small <= 0.2 * cells,
        "significant": p < 0.05 and small <= 0.2 * cells,
    }


# ── Correlación y confiabilidad ──────────────────────────────────────────────


def pearson(xs: Sequence[float], ys: Sequence[float]) -> Optional[float]:
    n = len(xs)
    if n < 3 or n != len(ys):
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def cronbach_alpha(item_scores: list[list[float]]) -> Optional[float]:
    """Alfa de Cronbach. `item_scores[i][k]` = puntaje de la persona i en el
    ítem k. Con ítems 0/1 es exactamente KR-20."""
    if len(item_scores) < 3:
        return None
    k = len(item_scores[0])
    if k < 2:
        return None
    totals = [sum(row) for row in item_scores]
    var_total = variance_pop(totals)
    if var_total == 0:
        return None
    var_items = sum(variance_pop([row[j] for row in item_scores]) for j in range(k))
    return (k / (k - 1)) * (1 - var_items / var_total)


# ── Texto ────────────────────────────────────────────────────────────────────

_STOP = set(
    """
a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bien cada como con contra cual
cuando de del desde donde dos el ella ellas ello ellos en entre era es esa esas ese eso esos esta
estaba estan estar este esto estos fue fueron ha hace hacer han hasta hay la las le les lo los mas me
mi mis mucho muy nada ni no nos nosotros o os otra otro para pero poco por porque que quien se sea
ser si sin sobre son su sus tambien tan tanto te tengo ti tiene todo todos tu tus un una uno unos y ya
yo the and or of to in is it that this for on with as are was be at by an not but have has had i you
we they he she my our your their me them do does did so if no yes
e um uma os as do da dos das em no na nos nas ao aos pelo pela com nao sim mais
""".split()
)
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(ch for ch in s if not unicodedata.combining(ch))


def top_terms(texts: Iterable[str], limit: int = 20, min_count: int = 2) -> list[dict]:
    """Palabras y pares de palabras más frecuentes, sin palabras vacías.

    Cuenta en cuántas RESPUESTAS aparece cada término (no cuántas veces): una
    persona que repite "precio" diez veces no lo vuelve un tema."""
    docs: Counter = Counter()
    for t in texts:
        words = [w for w in _WORD.findall(_fold(t or "")) if w not in _STOP and len(w) > 2]
        seen = set(words)
        seen |= {f"{a} {b}" for a, b in zip(words, words[1:])}
        docs.update(seen)
    out = [{"term": k, "count": v} for k, v in docs.items() if v >= min_count]
    # Primero los más frecuentes; a igual frecuencia, los pares (más informativos).
    out.sort(key=lambda d: (-d["count"], -d["term"].count(" "), d["term"]))
    # Un par que aparece tantas veces como su palabra suelta la vuelve redundante.
    pares = {d["term"]: d["count"] for d in out if " " in d["term"]}
    filtrado = []
    for d in out:
        if " " not in d["term"] and any(
            d["term"] in p.split() and c >= d["count"] for p, c in pares.items()
        ):
            continue
        filtrado.append(d)
    return filtrado[:limit]
