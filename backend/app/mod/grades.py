"""La nota de vuelta de `mod_encuestum`: el servicio web de Moodle.

Cuando la respuesta vino de una actividad del módulo nativo, la nota no puede
volver por AGS -- ese camino existe sólo para `mod_lti`, y Moodle lo tiene
literalmente cableado a `itemmodule = 'lti'`. Vuelve por un POST al servicio
web que expone el propio plugin:

    POST {wwwroot}/webservice/rest/server.php
        wstoken, wsfunction=mod_encuestum_submit_grade, moodlewsrestformat=json,
        cmid, sub, grade, max, needs_review

El disparador es el mismo de siempre (`schedule_score`/`_deliver` en
`app/lti/ags.py`): lo que cambia es el transporte, no el momento. Este módulo es
sólo el transporte.

Cuatro cosas que están decididas y no son accidentes:

1. **La escala la define Moodle.** El `grade_item` de la actividad tiene su
   `grademax` y la nota se reescala a esa escala antes de salir, igual que
   `get_lineitem_max()` para AGS. La diferencia es de dónde sale el número: AGS
   lo *pregunta* (`GET` al line item) y acá lo trae el token del lanzamiento
   (`mod_grademax` en la respuesta). Preguntarlo exigiría una segunda función
   de servicio web -- que es trabajo de la Tarea 6, del lado PHP -- y un
   round-trip sincrónico más en cada nota, para un dato que Moodle ya conoce
   cuando arma el lanzamiento y que le cuesta cero mandar. La contra es la
   ventana de desfasaje: si el docente cambia la nota máxima mientras un alumno
   ya está adentro, la nota se publica con la escala vieja. Es la MISMA ventana
   que ya tiene `anonymous` en este camino (ver `/mod/launch` en
   `routers/modapi.py`) y dura lo que la cookie (`ACCESS_TTL_S`). Y es
   recuperable del otro lado: `max` viaja en el cuerpo justamente para que el
   PHP pueda comparar contra su `grademax` de HOY y reescalar o rechazar si no
   coinciden -- la verdad está de ese lado, así que la corrección también.
2. **`anonymous` corta antes de pedir nada.** Publicar una nota por alumno es,
   por definición, identificarlo: las dos cosas van juntas y así lo prometió el
   selector de la actividad. Una respuesta anónima no tiene `lti_sub` (lo filtra
   `/mod/launch` y lo vuelve a filtrar `submit`), y sin `sub` no sale **ni un**
   request. Mismo criterio que `_deliver` para LTI.
3. **`assert_public_url(..., require_https=True)` en cada envío**, no sólo al
   registrar: la fila de `mod_sites` pudo quedar apuntando a otro lado, y este
   es un request que sale con un bearer token adentro.
4. **Los errores de Moodle vuelven con HTTP 200.** La API REST de Moodle
   contesta `{"exception": ..., "errorcode": ..., "message": ...}` con status
   200 cuando algo falla. Un `raise_for_status()` los da por buenos: hay que
   mirar el cuerpo o las fallas pasan por éxitos silenciosos.

Nada de acá loguea ni traga excepciones: el `except` único vive en `_deliver`
(`app/lti/ags.py`), que es el que garantiza que una falla del LMS no rompa el
envío del alumno.
"""

from __future__ import annotations

import uuid

import httpx

from app.net_guard import assert_public_url

# La función del servicio web que expone el plugin (Tarea 6, del lado PHP).
WS_FUNCTION = "mod_encuestum_submit_grade"

# Escala de un `grade_item` numérico de Moodle recién creado. Sólo se usa
# cuando el lanzamiento no trajo `grademax` -- un plugin anterior al que manda
# ese claim. Es un default explícito y no una suposición: la alternativa sería
# publicar la nota en la escala de la rúbrica haciéndola pasar por la de
# Moodle, que es peor porque nadie se entera.
GRADEMAX_POR_DEFECTO = 100.0

_TIMEOUT_S = 15


class ErrorDeMoodle(RuntimeError):
    """El servicio web contestó, pero contestó que no. Se distingue de un error
    de red (`httpx.*`) porque son dos problemas distintos para quien lea el log:
    uno es "Moodle no está", el otro es "Moodle dice que no podés"."""


def reescalar(score: float, max_score: float | None, grademax: float) -> float:
    """La nota de la rúbrica, llevada a la escala del libro de Moodle.

    La rúbrica tiene su propia escala y encima varía entre respuestas (las
    preguntas condicionales cambian el puntaje total posible), así que el
    número que se guarda casi nunca está en la escala del `grade_item`.

    Un `max_score` en 0 o ausente no se puede reescalar (sería dividir por
    cero): se manda tal cual y que decida Moodle, que tiene el `max` en el mismo
    cuerpo para darse cuenta."""
    if not max_score or float(max_score) <= 0:
        return float(score)
    if float(max_score) == float(grademax):
        return float(score)
    return float(score) / float(max_score) * float(grademax)


async def publicar_nota(
    *,
    wwwroot: str,
    ws_token: str,
    cmid: int,
    sub: str,
    grade: float,
    grademax: float,
    needs_review: bool,
) -> None:
    """Un POST al servicio web de Moodle. Levanta si algo salió mal.

    Los parámetros van en el **cuerpo** y no en la query, aunque la
    documentación de Moodle los muestre pegados a la URL: `wstoken` es un bearer
    de larga vida y en la query queda escrito en los logs de acceso de Moodle,
    de nginx y de cualquier proxy del camino. `webservice/rest/server.php` los
    lee con `required_param`, que mira POST y GET indistintamente."""
    # En CADA envío, no sólo al registrar: entre el registro y esta llamada
    # pueden haber pasado meses y una edición de la fila.
    assert_public_url(wwwroot, require_https=True)

    url = f"{wwwroot.rstrip('/')}/webservice/rest/server.php"
    # `follow_redirects` se queda en el default de httpx (`False`) A PROPÓSITO,
    # y por eso está escrito: este POST lleva el `ws_token` en el cuerpo. Si un
    # `wwwroot` secuestrado (o un Moodle mal configurado detrás de un proxy)
    # contesta 302 hacia otro host, seguir el redirect reenviaría el cuerpo --
    # con la credencial adentro -- a un destino que `assert_public_url` nunca
    # miró. Poner `follow_redirects=True` acá para "arreglar" un 302 convierte
    # esto en una fuga de credencial.
    async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
        resp = await client.post(
            url,
            data={
                "wstoken": ws_token,
                "wsfunction": WS_FUNCTION,
                "moodlewsrestformat": "json",
                "cmid": str(int(cmid)),
                "sub": sub,
                "grade": str(float(grade)),
                "max": str(float(grademax)),
                # El servicio lo declara como PARAM_BOOL: Moodle lo lee como
                # 0/1, no como "true"/"false".
                "needs_review": "1" if needs_review else "0",
            },
        )
    resp.raise_for_status()
    _verificar_cuerpo(resp)


def _verificar_cuerpo(resp: httpx.Response) -> None:
    """El vicio de la API REST de Moodle: un error es un **200** con
    `{"exception": ...}` adentro. Sin esto, un token revocado, una capacidad que
    falta o un `cmid` que ya no existe se registran como notas publicadas y
    nadie se entera nunca.

    Un cuerpo que ni siquiera es JSON también es una falla: un Moodle con
    `debugdisplay` prendido escupe HTML antes del JSON, y un proxy intermedio
    puede devolver su propia página de error con 200."""
    try:
        cuerpo = resp.json()
    except ValueError as exc:
        raise ErrorDeMoodle(
            f"el servicio web no devolvió JSON (status {resp.status_code}): {resp.text[:200]!r}"
        ) from exc

    # Una función `void` con `moodlewsrestformat=json` devuelve `null`: eso es
    # éxito. Sólo un objeto con `exception`/`errorcode` es una falla.
    if isinstance(cuerpo, dict) and ("exception" in cuerpo or "errorcode" in cuerpo):
        raise ErrorDeMoodle(
            f"{cuerpo.get('errorcode') or cuerpo.get('exception')}: "
            f"{cuerpo.get('message') or cuerpo.get('exception')}"
        )


async def entregar_nota(response_id: uuid.UUID) -> None:
    """Toma la respuesta ya corregida de una actividad del módulo y publica su
    nota. **Propaga** lo que falle: el `except` único está en `_deliver`.

    Todo lo que se lee de la base se copia a variables locales antes de soltar
    la sesión. No es manía: en este repositorio un `session.rollback()` (el que
    hace `get_tool_key` para recuperarse de una carrera, por ejemplo) expira el
    identity map entero, y leer un atributo de un objeto expirado en contexto
    async revienta con `MissingGreenlet` -- una falla que este camino se
    tragaría en silencio. Ya mordió tres veces en `app/lti/ags.py`."""
    from app.db import _session_maker
    from app.models import MoodleSite, SurveyResponse

    async with _session_maker() as session:
        r = await session.get(SurveyResponse, response_id)
        if r is None or r.mod_site_id is None or r.score is None:
            return
        # Sin `sub` no hay a quién calificar. Es el caso de una actividad
        # anónima -- y es exactamente acá donde el anonimato corta, antes de
        # cualquier request saliente. Postear `sub=""` sólo cambiaría un
        # "no se intentó" por un "se intentó y Moodle lo rechazó".
        if not r.lti_sub:
            return
        # Sin `cmid` no hay actividad de Moodle a la que ponerle la nota.
        if r.mod_cmid is None:
            return
        sitio = await session.get(MoodleSite, r.mod_site_id)
        if sitio is None or not sitio.ws_token:
            # Un sitio conectado sin token de servicio no puede publicar notas.
            # El registro lo acepta (`ws_token` es opcional) porque conectar y
            # calificar son dos decisiones distintas del administrador.
            return

        cmid = int(r.mod_cmid)
        sub = str(r.lti_sub)
        score = float(r.score)
        max_score = float(r.max_score) if r.max_score is not None else None
        grademax = float(r.mod_grademax) if r.mod_grademax is not None else GRADEMAX_POR_DEFECTO
        needs_review = bool(r.needs_review)
        wwwroot = str(sitio.wwwroot)
        ws_token = str(sitio.ws_token)

    await publicar_nota(
        wwwroot=wwwroot,
        ws_token=ws_token,
        cmid=cmid,
        sub=sub,
        grade=reescalar(score, max_score, grademax),
        grademax=grademax,
        needs_review=needs_review,
    )
