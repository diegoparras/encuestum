"""Deep Linking 2.0: el docente elige la encuesta desde adentro del LMS.

La plataforma nos manda un `LtiDeepLinkingRequest` con una URL de retorno. Le
contestamos con un `LtiDeepLinkingResponse` firmado por nosotros, que contiene un
`content_item` describiendo la actividad elegida. Moodle lo guarda y a partir de
ahí lanza esa encuesta.
"""

from __future__ import annotations

import time
import uuid

from app.lti.keys import ToolKey, sign
from app.lti.validate import CLAIM
from app.models import LtiPlatform, Survey

DL_PURPOSE = "lti_deeplink"


def build_response_jwt(
    *,
    platform: LtiPlatform,
    deployment_id: str,
    settings_claim: dict,
    survey: Survey,
    launch_url: str,
    key: ToolKey,
) -> str:
    """El JWT que la plataforma espera de vuelta, con la encuesta elegida."""
    now = int(time.time())
    item = {
        "type": "ltiResourceLink",
        "title": survey.title or "Encuesta",
        "url": launch_url,
        "custom": {"survey_id": str(survey.id), "survey_slug": survey.slug},
        "presentation": {"documentTarget": "iframe"},
    }
    # Si la encuesta es un examen, declaramos la escala para que el LMS cree el
    # ítem del libro de calificaciones al aceptar el content item.
    #
    # Siempre 100: el puntaje máximo real depende de la rúbrica y recién se
    # conoce al corregir (`grade["max"]`), que puede variar entre respuestas si
    # hay preguntas condicionales. Se fija el libro en 100 y `ags._deliver`
    # reescala cada nota antes de publicarla.
    if (survey.evaluation or {}).get("enabled"):
        item["lineItem"] = {
            "scoreMaximum": 100.0,
            "label": survey.title or "Encuesta",
            "resourceId": str(survey.id),
        }

    payload = {
        "iss": platform.client_id,  # en la respuesta, el emisor es el tool
        "aud": platform.issuer,
        "sub": platform.client_id,
        "exp": now + 600,
        "iat": now,
        "nonce": uuid.uuid4().hex,
        CLAIM["MESSAGE_TYPE"]: "LtiDeepLinkingResponse",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: deployment_id,
        CLAIM["DL_CONTENT_ITEMS"]: [item],
    }
    if settings_claim.get("data"):
        payload[CLAIM["DL_DATA"]] = settings_claim["data"]
    return sign(payload, key)
