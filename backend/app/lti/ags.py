"""Assignment and Grade Services: devolver la nota al libro de calificaciones.

La plataforma no acepta cualquier request: hay que pedirle un token OAuth2
`client_credentials` probando quiénes somos con un `client_assertion` firmado con
la clave privada del tool. Con ese token se crea el line item (el ítem del libro)
si falta, y se publica el score.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.lti.keys import ToolKey, sign
from app.models import LtiPlatform, LtiResourceLink
from app.net_guard import UnsafeUrlError, assert_public_url

LOGGER = logging.getLogger(__name__)

SCOPE_LINEITEM = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
SCOPE_LINEITEM_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly"
SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score"

# Todos los scopes AGS que este módulo llega a pedir (lineitem para crear el
# ítem, lineitem.readonly para leerlo/buscarlo, score para publicar la nota).
# `app/routers/lti.py` deriva de acá el `scope` que declara al registrarse
# dinámicamente contra la plataforma -- así una plataforma estricta que
# de verdad valide scopes (a diferencia de Moodle, que en la práctica mapea
# el par lineitem/score a sync completo) no rechaza la entrega con
# `invalid_scope` por faltar uno que este módulo pide pero el registro nunca
# declaró.
ALL_SCOPES = (SCOPE_LINEITEM, SCOPE_LINEITEM_RO, SCOPE_SCORE)

_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

# Escala con la que damos de alta el ítem del libro cuando lo creamos nosotros.
# La rúbrica tiene su propia escala y varía entre respuestas (preguntas
# condicionales), así que el libro se fija acá y cada nota se reescala.
DEFAULT_SCORE_MAXIMUM = 100.0


async def get_access_token(platform: LtiPlatform, key: ToolKey, scopes: list[str]) -> str:
    """Token OAuth2 para hablar con los servicios de la plataforma."""
    # Defensa en profundidad: `app/routers/lti.py` ya valida `auth_token_url`
    # al registrar la plataforma (dynamic y manual). Esto cubre una fila
    # creada antes de ese fix -- este POST corre en cada entrega de nota, sin
    # que medie ningún admin.
    try:
        assert_public_url(platform.auth_token_url)
    except UnsafeUrlError as exc:
        raise RuntimeError(f"auth_token_url no permitida: {exc}") from exc

    now = int(time.time())
    assertion = sign(
        {
            "iss": platform.client_id,
            "sub": platform.client_id,
            "aud": platform.auth_token_url,
            "iat": now,
            "exp": now + 300,
            "jti": uuid.uuid4().hex,
        },
        key,
    )
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            platform.auth_token_url,
            data={
                "grant_type": "client_credentials",
                "client_assertion_type": _ASSERTION_TYPE,
                "client_assertion": assertion,
                "scope": " ".join(scopes),
            },
        )
    resp.raise_for_status()
    return resp.json()["access_token"]


async def ensure_lineitem(
    platform: LtiPlatform,
    link: LtiResourceLink,
    key: ToolKey,
    *,
    label: str,
    score_maximum: float,
) -> str:
    """URL del line item de esta actividad, creándolo si la plataforma no lo hizo."""
    if link.lineitem_url:
        return link.lineitem_url
    if not link.lineitems_url:
        raise RuntimeError("La actividad no expone el servicio de notas (falta lineitems).")

    # Dos submits casi simultáneos de la primera respuesta de un launch sin
    # `lineitem` claim leen ambos `link.lineitem_url is None` en la fila que
    # obtuvieron de la base, y sin nada más ambos crearían su propio line item
    # -- dos columnas en el libro, con parte de las notas de la clase varadas
    # en la que no quedó guardada. Antes de crear, se pregunta a la plataforma
    # si ya existe uno para este resource link (AGS permite filtrar por
    # `resource_link_id`) y, si aparece, se adopta en vez de duplicar.
    #
    # Esto angosta la ventana de carrera, no la cierra: entre este GET y el
    # POST de más abajo sigue habiendo hueco para que dos requests concurrentes
    # se crucen. Cerrarla del todo requeriría un lock de base de datos
    # sostenido durante un round-trip de red a Moodle, que es peor que el
    # riesgo residual que queda (muy improbable, y recuperable a mano si
    # ocurre). Es una decisión, no un descuido.
    ro_token = await get_access_token(platform, key, [SCOPE_LINEITEM_RO])
    async with httpx.AsyncClient(timeout=15) as client:
        existentes = await client.get(
            link.lineitems_url,
            params={"resource_link_id": link.resource_link_id},
            headers={
                "Authorization": f"Bearer {ro_token}",
                "Accept": "application/vnd.ims.lis.v2.lineitemcontainer+json",
            },
        )
    existentes.raise_for_status()
    items = existentes.json()
    if items:
        return items[0]["id"]

    token = await get_access_token(platform, key, [SCOPE_LINEITEM])
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            link.lineitems_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/vnd.ims.lis.v2.lineitem+json",
            },
            json={
                "scoreMaximum": float(score_maximum),
                "label": label,
                "resourceLinkId": link.resource_link_id,
                "resourceId": str(link.survey_id),
            },
        )
    resp.raise_for_status()
    return resp.json()["id"]


async def get_lineitem_max(platform: LtiPlatform, lineitem_url: str, key: ToolKey) -> float:
    """Escala real del ítem del libro.

    AGS rechaza un score cuyo `scoreMaximum` no coincide con el del line item, y
    el docente puede haber cambiado la nota máxima en Moodle después de crearlo.
    Por eso se lee en vez de asumirse."""
    token = await get_access_token(platform, key, [SCOPE_LINEITEM_RO])
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            lineitem_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.ims.lis.v2.lineitem+json",
            },
        )
    resp.raise_for_status()
    # `or` trataría un `scoreMaximum: 0` legítimo (el docente puede configurar
    # el ítem así) como si faltara, y lo pisaría con el default -- justo lo
    # que después hace que AGS rechace el score por no coincidir la escala.
    # Sólo la ausencia del campo (`None`) debe caer al default.
    maximo = resp.json().get("scoreMaximum")
    return float(maximo) if maximo is not None else DEFAULT_SCORE_MAXIMUM


def _scores_url(lineitem_url: str) -> str:
    """La URL de `/scores` de un line item, tal como la pide la spec de AGS:
    `/scores` se inserta ANTES del query string, que se preserva -- no se
    descarta. Las URLs de line item de Moodle llevan `?type_id=N`, que
    identifica el tipo de herramienta; perderlo (como hacía
    `lineitem.split('?')[0]`) hace que el POST le pegue a una URL que Moodle
    ya no reconoce -- un 403 o 404 en el último paso del flujo, después de que
    todo lo anterior (token, line item, nota calculada) salió bien."""
    parts = urlsplit(lineitem_url)
    return urlunsplit(parts._replace(path=parts.path + "/scores"))


async def post_score(
    platform: LtiPlatform,
    link: LtiResourceLink,
    key: ToolKey,
    *,
    sub: str,
    score: float,
    score_maximum: float,
    comment: str | None = None,
    needs_review: bool = False,
) -> None:
    """Publica la nota de un alumno en el line item de la actividad."""
    lineitem = link.lineitem_url
    if not lineitem:
        raise RuntimeError("La actividad no tiene line item donde publicar la nota.")

    token = await get_access_token(platform, key, [SCOPE_SCORE])
    body = {
        "userId": sub,
        "scoreGiven": float(score),
        "scoreMaximum": float(score_maximum),
        "activityProgress": "Completed",
        # AGS define `PendingManual` para una nota todavía no definitiva --
        # exactamente el caso de una respuesta marcada `needs_review`. Publicar
        # `FullyGraded` ahí le mentiría al libro de calificaciones del docente
        # sobre qué notas son provisorias.
        "gradingProgress": "PendingManual" if needs_review else "FullyGraded",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if comment:
        body["comment"] = comment

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            _scores_url(lineitem),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/vnd.ims.lis.v1.score+json",
            },
            json=body,
        )
    resp.raise_for_status()


async def _origen(response_id: uuid.UUID) -> str | None:
    """Por qué transporte tiene que volver la nota de esta respuesta.

    `"lti"` (AGS, contra un `LtiResourceLink`), `"mod"` (el servicio web de
    `mod_encuestum`) o `None` si no vino de Moodle, si todavía no hay nota, o si
    la integración por la que hubiera vuelto está **apagada**.

    Ese último caso es el interruptor de emergencia y por eso vive acá y en un
    solo lugar: `MOD_ENABLED=0` (o `LTI_ENABLED=0`) tiene que significar que
    nada de este módulo le habla al LMS, no sólo que no se generen
    lanzamientos nuevos. Las filas no se borran al apagar la bandera -- una
    respuesta guarda su `mod_site_id`/`lti_link_id` para siempre -- así que sin
    este gate una recorrección seguía sacando un POST con el `ws_token` del
    sitio adentro, que es justamente la credencial por la que alguien apagaría
    el módulo de apuro.

    Se gatea el DESPACHO y no cada trigger porque los triggers son varios
    (`submit`, `override_grade`, `grade_one`, `grade_all`) y crecen: la
    garantía tiene que vivir donde se decide el request saliente, no repartida
    en cada quien podría pedirlo.

    No hay ningún caso ambiguo que desempatar: el CHECK
    `ck_survey_responses_un_solo_origen` (ver `app/models.py`) impide a nivel de
    motor que una respuesta tenga los dos orígenes. El orden de los `if` no es
    una desambiguación, es sólo un orden.

    Abre su propia sesión y la cierra antes de que arranque el transporte. El
    camino LTI necesita pedir la clave del tool ANTES de cargar cualquier fila
    (ver el comentario adentro de `_deliver_lti`), así que sostener esta sesión
    hasta ahí reintroduciría justo el problema que ese orden existe para evitar.
    """
    from app.config import get_settings
    from app.db import _session_maker
    from app.models import SurveyResponse

    async with _session_maker() as session:
        r = await session.get(SurveyResponse, response_id)
        if r is None or r.score is None:
            return None
        ajustes = get_settings()
        if r.mod_site_id is not None:
            return "mod" if ajustes.mod_enabled else None
        if r.lti_link_id is not None:
            return "lti" if ajustes.lti_enabled else None
        return None


async def _deliver(response_id: uuid.UUID) -> None:
    """Despacha la nota de una respuesta ya corregida por el transporte que le
    corresponde, y nunca propaga errores: que falle el LMS no puede romper el
    envío del alumno, que del lado de Encuestum ya salió bien y está guardado.

    Este es el ÚNICO `except` de los dos caminos: tanto `_deliver_lti` como
    `app/mod/grades.py` propagan a propósito, para que la garantía viva en un
    solo lugar y no haya que confiar en que cada transporte se acuerde.

    El *momento* de publicar (al responder y al recorregir) lo decide
    `schedule_score`, que es único para las dos integraciones. Lo único que
    cambia entre ellas es el transporte, y eso es lo que elige esta función.

    El *si* -- `LTI_ENABLED`/`MOD_ENABLED` -- lo decide `_origen`, no cada quien
    llama a `schedule_score`: los triggers son varios y crecen, y la garantía de
    que una integración apagada no le hable al LMS tiene que vivir donde se
    resuelve el request saliente."""
    try:
        origen = await _origen(response_id)
        if origen == "mod":
            from app.mod.grades import entregar_nota

            await entregar_nota(response_id)
        elif origen == "lti":
            await _deliver_lti(response_id)
    except Exception as exc:  # noqa: BLE001 — el LMS no puede romper el submit del alumno
        # Este catch también atrapa errores de programación, no sólo fallas de
        # red -- y esta línea es el único diagnóstico que queda, porque para
        # el docente el envío falló en silencio. Sin exc_info no hay traceback.
        LOGGER.warning(
            "no se pudo publicar la nota de %s: %s", response_id, exc, exc_info=True
        )


async def _deliver_lti(response_id: uuid.UUID) -> None:
    """Publica la nota por AGS: el camino de `mod_lti`/`local_encuestum`.

    **Propaga** lo que falle; el `except` único está en `_deliver`."""
    from app.db import _session_maker
    from app.lti.keys import get_tool_key
    from app.models import Survey, SurveyResponse

    async with _session_maker() as session:
        # `get_tool_key` corre PRIMERO, antes de cargar `r`/`link`/
        # `platform`/`survey`: mismo hallazgo del rollback sweep del fix
        # de la carrera de `LtiResourceLink` en `app/routers/lti.py` (ver
        # `_upsert_lti_user`/`_link_from_deep_link_claims` ahí). Si
        # todavía no existe la fila de `LtiKey` (primer arranque) y dos
        # entregas piden una clave casi a la vez, `get_tool_key`
        # (`app/lti/keys.py`) hace su propio `session.rollback()` para
        # recuperarse -- y ese rollback expira TODO el identity map de la
        # sesión. Si `platform`/`link`/`survey` ya estuvieran cargados en
        # ese momento, `ensure_lineitem`/`get_access_token` (que leen sus
        # atributos de forma síncrona, sin `await`) reventarían con
        # `MissingGreenlet` -- silenciado por el `except Exception` de
        # `_deliver`, pero la nota nunca se publicaría. Pidiendo la clave
        # antes de cargar nada más, ese rollback no tiene nada que
        # invalidar. Por el mismo motivo `_origen` cierra su sesión antes
        # de llamar acá, en vez de pasarnos la fila ya cargada.
        key = await get_tool_key(session)

        r = await session.get(SurveyResponse, response_id)
        if r is None or r.lti_link_id is None or r.score is None or not r.lti_sub:
            # `lti_sub` es nullable: sin él no hay a quién asignarle la
            # nota en el libro, y postear `userId: ""` sólo cambia un
            # "no se intentó" por un "se intentó y la plataforma lo
            # rechazó", igual de silencioso para el docente.
            return
        link = await session.get(LtiResourceLink, r.lti_link_id)
        if link is None:
            return
        # Vínculo anónimo: no se publica nota. Publicar un score por alumno
        # es identificarlo, así que el anonimato y la nota son excluyentes.
        if link.anonymous:
            return
        platform = await session.get(LtiPlatform, link.platform_id)
        if platform is None:
            return
        survey = await session.get(Survey, r.survey_id)

        link.lineitem_url = await ensure_lineitem(
            platform, link, key,
            label=(survey.title if survey else None) or "Encuesta",
            score_maximum=DEFAULT_SCORE_MAXIMUM,
        )
        # La escala la manda el libro, no la rúbrica: puede haberla cambiado
        # el docente en Moodle.
        maximum = await get_lineitem_max(platform, link.lineitem_url, key)
        link.max_score = maximum
        session.add(link)
        await session.commit()

        # La rúbrica tiene su propia escala: se reescala antes de publicar.
        given = float(r.score)
        if r.max_score and float(r.max_score) > 0 and float(r.max_score) != maximum:
            given = given / float(r.max_score) * maximum

        await post_score(
            platform, link, key,
            sub=r.lti_sub,
            score=given,
            score_maximum=maximum,
            comment=(r.grade or {}).get("feedback") if isinstance(r.grade, dict) else None,
            needs_review=bool(r.needs_review),
        )


def schedule_score(response_id: uuid.UUID) -> None:
    """Dispara el envío sin bloquear la respuesta al alumno, igual que los
    webhooks. Es el único disparador de los DOS transportes (AGS y el servicio
    web de `mod_encuestum`): quién publica lo decide `_deliver`, no quien llama
    acá. Por eso `routers/public.py` no tiene que saber de dónde vino la
    respuesta para pedir que se publique la nota."""
    try:
        asyncio.get_running_loop().create_task(_deliver(response_id))
    except RuntimeError:  # sin loop corriendo (tests sincrónicos): no hacemos nada
        LOGGER.debug("sin event loop: se omite el envío de nota de %s", response_id)
