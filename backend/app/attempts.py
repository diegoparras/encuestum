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
* **Lanzada desde un LMS**: por el identificador que da Moodle
  (`SurveyResponse.lti_sub`), que es el `lms` de `usados()`. Es tan infalible
  como el código de invitado y por el mismo motivo: lo emitió el otro lado, no
  el navegador. Hace falta porque una encuesta lanzada desde Moodle casi nunca
  pregunta el correo —el sentido de la integración es que la identidad la
  provea el LMS—, así que sin esto no quedaba NINGUNA señal y el tope no se
  aplicaba nunca. Y cuando hay identidad del LMS, la marca del navegador se
  **ignora**: en la sala de computadoras de una escuela el navegador es de la
  máquina y no del alumno, así que contarla además del `sub` haría que el
  segundo alumno de la misma máquina se comiera el intento del primero.
* **Actividad anónima de un LMS**: el tope NO se aplica, a propósito. La
  actividad anónima no guarda `lti_sub` (ver `app/routers/public.py`), o sea
  que no hay con qué contar por persona; caer de vuelta en la marca del
  navegador sería peor que no contar — falsos positivos en la máquina
  compartida y falsos negativos con sólo abrir otro navegador. Elegir el
  anonimato es elegir no poder contar intentos.

Una respuesta excluida o marcada como prueba NO consume intento: así, excluirla
es también la forma de devolverle un intento a alguien.
"""

from typing import Optional

from sqlalchemy import and_, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.hygiene import counted_only
from app.models import LtiResourceLink, SurveyResponse


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


def _del_mismo_alumno_del_lms(lms: dict):
    """Condición que reconoce al alumno por lo que dijo el LMS, acotada al LMS
    de origen.

    El `sub` es único **por plataforma**, no en el mundo: dos Moodles de la
    misma organización pueden usar la misma cadena para dos personas distintas.
    Por el camino LTI eso no es teórico — Moodle manda como `sub` el id del
    usuario, así que el alumno 5 del Moodle de primaria y el alumno 5 del de
    secundaria colisionan de entrada. (Por `mod_encuestum` el `sub` es un HMAC
    con un secreto del sitio y chocar es inverosímil, pero se acota igual: una
    sola regla para los dos caminos.) Filtrar por `survey_id` no alcanza,
    porque la misma encuesta puede estar enlazada desde los dos Moodles a la
    vez; sin acotar, el segundo alumno se comería el intento del primero.

    Se acota por **plataforma/sitio** y no por actividad: el mismo alumno
    lanzando la misma encuesta desde dos actividades del mismo Moodle es una
    sola persona, y contar por actividad le daría un juego de intentos nuevo
    por cada vínculo. El precio es que desconectar el Moodle o borrar la
    actividad (que ponen `lti_link_id`/`mod_site_id` en NULL) le devuelve los
    intentos: es un acto deliberado del docente, el mismo efecto que excluir
    una respuesta."""
    condicion = [SurveyResponse.lti_sub == lms["sub"]]
    if lms.get("site_id") is not None:
        condicion.append(SurveyResponse.mod_site_id == lms["site_id"])
    elif lms.get("platform_id") is not None:
        condicion.append(
            SurveyResponse.lti_link_id.in_(
                select(LtiResourceLink.id).where(
                    LtiResourceLink.platform_id == lms["platform_id"]
                )
            )
        )
    return and_(*condicion)


async def usados(
    s,
    session: AsyncSession,
    *,
    code: Optional[str] = None,
    visitor_id: Optional[str] = None,
    email: Optional[str] = None,
    lms: Optional[dict] = None,
) -> int:
    """Intentos ya consumidos por esta persona. 0 si no se la puede reconocer.

    `lms` es la identidad del lanzamiento cuando la respuesta viene de un LMS
    —`{"sub", "platform_id", "site_id"}`, ver `app/routers/public.py`— y `None`
    cuando no. Que no sea `None` es lo que hace que el LMS mande: quién es la
    persona lo dice el LMS, y `visitor_id` deja de contar. En una actividad
    anónima llega con `sub` en `None`: hay LMS pero no hay identidad, así que no
    queda ninguna condición y el tope no aplica (el porqué, en el docstring del
    módulo)."""
    from app.identity import identity_fields

    condiciones = []
    if code:
        condiciones.append(SurveyResponse.respondent_code == code)
    if lms is None and visitor_id:
        # La marca del navegador viaja en el meta de la respuesta. Sólo vale
        # cuando NO hay LMS: si lo hay, la identidad la da él y esta señal es
        # ruido que confunde a dos alumnos de la misma computadora.
        condiciones.append(SurveyResponse.meta["visitor_id"].as_string() == visitor_id)
    if lms and lms.get("sub"):
        condiciones.append(_del_mismo_alumno_del_lms(lms))
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
