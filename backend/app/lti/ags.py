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

import httpx

from app.lti.keys import ToolKey, sign
from app.models import LtiPlatform, LtiResourceLink

LOGGER = logging.getLogger(__name__)

SCOPE_LINEITEM = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem"
SCOPE_LINEITEM_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly"
SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score"

_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"

# Escala con la que damos de alta el ítem del libro cuando lo creamos nosotros.
# La rúbrica tiene su propia escala y varía entre respuestas (preguntas
# condicionales), así que el libro se fija acá y cada nota se reescala.
DEFAULT_SCORE_MAXIMUM = 100.0


def _check(resp: httpx.Response, what: str) -> None:
    """Equivalente a `resp.raise_for_status()`, pero sin exigir que la
    respuesta lleve adjunto el `Request` que la originó. httpx sólo lo asocia
    cuando la respuesta viene de una petición real hecha por el propio
    cliente; alcanza con chequear el código de estado."""
    if resp.status_code >= 400:
        raise RuntimeError(f"{what}: HTTP {resp.status_code} — {resp.text}")


async def get_access_token(platform: LtiPlatform, key: ToolKey, scopes: list[str]) -> str:
    """Token OAuth2 para hablar con los servicios de la plataforma."""
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
    _check(resp, "pedido de token AGS")
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
    _check(resp, "alta de line item AGS")
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
    _check(resp, "lectura de line item AGS")
    return float(resp.json().get("scoreMaximum") or DEFAULT_SCORE_MAXIMUM)


async def post_score(
    platform: LtiPlatform,
    link: LtiResourceLink,
    key: ToolKey,
    *,
    sub: str,
    score: float,
    score_maximum: float,
    comment: str | None = None,
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
        "gradingProgress": "FullyGraded",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if comment:
        body["comment"] = comment

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{lineitem.split('?')[0]}/scores",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/vnd.ims.lis.v1.score+json",
            },
            json=body,
        )
    _check(resp, "publicación de score AGS")


async def _deliver(response_id: uuid.UUID) -> None:
    """Toma la respuesta ya corregida y publica su nota. Nunca propaga errores:
    que falle el LMS no puede romper el envío del alumno."""
    from app.db import _session_maker
    from app.lti.keys import get_tool_key
    from app.models import Survey, SurveyResponse

    try:
        async with _session_maker() as session:
            r = await session.get(SurveyResponse, response_id)
            if r is None or r.lti_link_id is None or r.score is None:
                return
            link = await session.get(LtiResourceLink, r.lti_link_id)
            if link is None:
                return
            platform = await session.get(LtiPlatform, link.platform_id)
            if platform is None:
                return
            survey = await session.get(Survey, r.survey_id)
            key = await get_tool_key(session)

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
                sub=r.lti_sub or "",
                score=given,
                score_maximum=maximum,
                comment=(r.grade or {}).get("feedback") if isinstance(r.grade, dict) else None,
            )
    except Exception as exc:  # noqa: BLE001 — el LMS no puede romper el submit del alumno
        LOGGER.warning("no se pudo publicar la nota LTI de %s: %s", response_id, exc)


def schedule_score(response_id: uuid.UUID) -> None:
    """Dispara el envío sin bloquear la respuesta al alumno, igual que los webhooks."""
    try:
        asyncio.get_running_loop().create_task(_deliver(response_id))
    except RuntimeError:  # sin loop corriendo (tests sincrónicos): no hacemos nada
        LOGGER.debug("sin event loop: se omite el envío de nota LTI de %s", response_id)
