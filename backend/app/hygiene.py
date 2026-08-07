"""Qué respuestas cuentan para los resultados.

Una respuesta puede estar fuera de los resultados sin estar borrada: porque
alguien la excluyó a mano (`excluded`) o porque la envió el propio equipo
probando la encuesta (`is_test`). Este módulo centraliza ese criterio para que
la tabla, el resumen, las estadísticas, el informe y las exportaciones no puedan
discrepar entre sí — que es exactamente el bug que aparece cuando cada endpoint
arma su propio filtro.
"""

from typing import Iterable, List

from app.models import SurveyResponse


def counted_only(query, *, include_excluded: bool = False, include_test: bool = False):
    """Agrega al `select` las condiciones de "esto cuenta para los resultados"."""
    if not include_excluded:
        query = query.where(SurveyResponse.excluded == False)  # noqa: E712
    if not include_test:
        query = query.where(SurveyResponse.is_test == False)  # noqa: E712
    return query


def counted(
    responses: Iterable[SurveyResponse],
    *,
    include_excluded: bool = False,
    include_test: bool = False,
) -> List[SurveyResponse]:
    """Misma regla, en memoria (para lo que ya trajo las filas)."""
    out = []
    for r in responses:
        if not include_excluded and getattr(r, "excluded", False):
            continue
        if not include_test and getattr(r, "is_test", False):
            continue
        out.append(r)
    return out
