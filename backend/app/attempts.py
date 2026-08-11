"""Cuántas veces respondió ya una misma persona.

`max_responses` es el cupo total de la encuesta; esto es otra cosa: cuántos
intentos tiene CADA persona. El problema es reconocerla, y eso depende del modo
de acceso:

* **Lista de invitados**: por el código del invitado. Es infalible: lo emitió el
  servidor y viaja en el token de acceso.
* **Público / PIN**: no hay identidad. Se usan dos señales de "mejor esfuerzo":
  una marca que el navegador guarda (la misma que ya se usaba para el embudo) y
  el correo que la persona haya respondido, si la encuesta lo pregunta. Frena el
  caso normal — recargar, reenviar, volver al link — pero una ventana de
  incógnito lo saltea, y la interfaz lo dice en vez de prometer un candado.

Una respuesta excluida o marcada como prueba NO consume intento: así, excluirla
es también la forma de devolverle un intento a alguien.
"""

from typing import Optional

from sqlalchemy import func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.hygiene import counted_only
from app.models import SurveyResponse


def limite(s) -> Optional[int]:
    """El tope de intentos de esta encuesta, o None si no tiene.

    Sólo se lee la columna propia, NUNCA el `evaluation.integrity.maxAttempts`
    que el builder venía escribiendo: ese campo tiene 1 por defecto en toda
    encuesta con modo examen, así que tomarlo como respaldo le habría impuesto
    "un solo intento" de golpe a cada examen ya existente, sin que nadie lo
    hubiera elegido. El límite arranca apagado y se activa a mano."""
    try:
        n = int(getattr(s, "max_attempts", None))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


async def usados(
    s,
    session: AsyncSession,
    *,
    code: Optional[str] = None,
    visitor_id: Optional[str] = None,
    email: Optional[str] = None,
) -> int:
    """Intentos ya consumidos por esta persona. 0 si no se la puede reconocer."""
    from app.identity import identity_fields

    condiciones = []
    if code:
        condiciones.append(SurveyResponse.respondent_code == code)
    if visitor_id:
        # La marca del navegador viaja en el meta de la respuesta.
        condiciones.append(SurveyResponse.meta["visitor_id"].as_string() == visitor_id)
    if email:
        _, pregunta_mail = identity_fields(s.json_schema or {})
        if pregunta_mail:
            condiciones.append(
                func.lower(SurveyResponse.answers[pregunta_mail].as_string()) == email.strip().lower()
            )
    if not condiciones:
        return 0

    total = await session.scalar(
        counted_only(
            select(func.count(SurveyResponse.id)).where(
                SurveyResponse.survey_id == s.id, or_(*condiciones)
            )
        )
    )
    return int(total or 0)


async def restantes(s, session: AsyncSession, **quien) -> Optional[int]:
    """Intentos que le quedan, o None si la encuesta no tiene límite."""
    tope = limite(s)
    if tope is None:
        return None
    return max(0, tope - await usados(s, session, **quien))
