"""Endpoints LTI 1.3. Todo el router vive detrás de LTI_ENABLED."""

import logging
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import RedirectResponse

from app.config import get_settings
from app.db import get_session
from app.lti.keys import get_tool_key, public_jwk
from app.lti.state import (
    ACCESS_TTL_S,
    LTI_COOKIE,
    LTI_PURPOSE,
    LTI_STATE_COOKIE,
    LTI_STATE_PURPOSE,
    STATE_TTL_S,
    new_state,
)
from app.lti.validate import (
    CLAIM,
    MESSAGE_DEEP_LINKING,
    LtiValidationError,
    validate_launch,
)
from app.models import LtiPlatform, LtiResourceLink, LtiUser, Survey
from app.security import create_purpose_token, read_purpose_token

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/lti", tags=["lti"])


def require_lti() -> None:
    """Con LTI apagado, la superficie entera no existe: 404, no 403, para no
    revelar que el endpoint está ahí."""
    if not get_settings().lti_enabled:
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("/jwks.json", dependencies=[Depends(require_lti)])
async def jwks(session: AsyncSession = Depends(get_session)) -> dict:
    """Claves públicas del tool, para que la plataforma verifique lo que firmamos."""
    key = await get_tool_key(session)
    return {"keys": [public_jwk(key)]}


def _lti_cookie_kwargs() -> dict:
    """Las cookies del flujo LTI viajan dentro de un iframe de otro dominio:
    sin SameSite=None; Secure el navegador las descarta. `secure` sigue la
    misma configuración que el resto de las cookies de la app (apagada en
    tests, donde el TestClient habla HTTP plano)."""
    return {
        "httponly": True,
        "secure": get_settings().cookie_secure,
        "samesite": "none",
        "path": "/",
    }


async def _platform_for(session: AsyncSession, issuer: str, client_id: str | None) -> LtiPlatform:
    q = select(LtiPlatform).where(LtiPlatform.issuer == issuer)
    if client_id:
        q = q.where(LtiPlatform.client_id == client_id)
    platform = (await session.scalars(q)).first()
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")
    return platform


@router.api_route("/login", methods=["GET", "POST"], dependencies=[Depends(require_lti)])
async def login(request: Request, session: AsyncSession = Depends(get_session)):
    """OIDC third-party initiated login: la plataforma nos avisa que viene un
    lanzamiento y nosotros la mandamos a su propio authorize."""
    params = dict(request.query_params)
    if request.method == "POST":
        params.update({k: str(v) for k, v in (await request.form()).items()})

    issuer = (params.get("iss") or "").strip()
    if not issuer:
        raise HTTPException(status_code=400, detail="Falta iss.")
    platform = await _platform_for(session, issuer, (params.get("client_id") or "").strip() or None)

    state, nonce = new_state()
    target = params.get("target_link_uri") or str(request.url_for("launch"))
    query = {
        "scope": "openid",
        "response_type": "id_token",
        "response_mode": "form_post",
        "prompt": "none",
        "client_id": platform.client_id,
        "redirect_uri": target,
        "state": state,
        "nonce": nonce,
    }
    if params.get("login_hint"):
        query["login_hint"] = params["login_hint"]
    if params.get("lti_message_hint"):
        query["lti_message_hint"] = params["lti_message_hint"]

    resp = RedirectResponse(f"{platform.auth_login_url}?{urlencode(query)}", status_code=302)
    resp.set_cookie(
        LTI_STATE_COOKIE,
        create_purpose_token(
            LTI_STATE_PURPOSE,
            {"state": state, "nonce": nonce, "platform_id": str(platform.id)},
            ttl_minutes=STATE_TTL_S / 60,
        ),
        max_age=STATE_TTL_S,
        **_lti_cookie_kwargs(),
    )
    return resp


@router.post("/launch", name="launch", dependencies=[Depends(require_lti)])
async def launch(
    request: Request,
    id_token: str = Form(...),
    state: str = Form(...),
    session: AsyncSession = Depends(get_session),
):
    """Recibe el id_token firmado, lo valida, y deja al alumno adentro de la encuesta."""
    stored = read_purpose_token(LTI_STATE_PURPOSE, request.cookies.get(LTI_STATE_COOKIE) or "")
    if not stored or stored.get("state") != state:
        raise HTTPException(status_code=400, detail="Lanzamiento LTI inválido o vencido.")

    platform = await session.get(LtiPlatform, uuid.UUID(stored["platform_id"]))
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")

    try:
        claims = await validate_launch(id_token, platform, expected_nonce=stored.get("nonce"))
    except LtiValidationError as exc:
        LOGGER.warning("lanzamiento LTI rechazado (%s): %s", platform.issuer, exc)
        raise HTTPException(status_code=400, detail="Lanzamiento LTI inválido.") from exc

    # Alta o actualización del usuario del LMS.
    sub = claims["sub"]
    user = (
        await session.scalars(
            select(LtiUser).where(LtiUser.platform_id == platform.id, LtiUser.sub == sub)
        )
    ).first()
    if user is None:
        user = LtiUser(platform_id=platform.id, sub=sub)
    user.email = claims.get("email")
    user.name = claims.get("name")
    user.roles = claims.get(CLAIM["ROLES"]) or []
    session.add(user)
    await session.commit()

    if claims.get(CLAIM["MESSAGE_TYPE"]) == MESSAGE_DEEP_LINKING:
        return await _deep_linking_redirect(claims, platform, session)

    return await _resource_link_redirect(claims, platform, user, session)


async def _resource_link_redirect(claims, platform, user, session):
    """Lanzamiento normal: buscar la encuesta atada a esta actividad y entrar."""
    resource_link_id = (claims.get(CLAIM["RESOURCE_LINK"]) or {}).get("id")
    if not resource_link_id:
        raise HTTPException(status_code=400, detail="El lanzamiento no trae resource_link.")

    link = (
        await session.scalars(
            select(LtiResourceLink).where(
                LtiResourceLink.platform_id == platform.id,
                LtiResourceLink.resource_link_id == resource_link_id,
            )
        )
    ).first()
    if link is None:
        raise HTTPException(
            status_code=404,
            detail="Esta actividad todavía no tiene una encuesta asignada.",
        )

    # Guardamos los endpoints de notas que vengan en este lanzamiento: pueden
    # cambiar si el docente reconfigura la actividad.
    ags = claims.get(CLAIM["AGS"]) or {}
    if ags.get("lineitem"):
        link.lineitem_url = ags["lineitem"]
    if ags.get("lineitems"):
        link.lineitems_url = ags["lineitems"]
    session.add(link)
    await session.commit()

    survey = await session.get(Survey, link.survey_id)
    if survey is None or survey.deleted_at is not None:
        raise HTTPException(status_code=404, detail="La encuesta ya no existe.")

    token = create_purpose_token(
        LTI_PURPOSE,
        {
            "slug": survey.slug,
            "link_id": str(link.id),
            "sub": user.sub,
            "email": user.email,
            "name": user.name,
        },
        ttl_minutes=ACCESS_TTL_S / 60,
    )
    resp = RedirectResponse(f"/s/{survey.slug}", status_code=302)
    resp.set_cookie(LTI_COOKIE, token, max_age=ACCESS_TTL_S, **_lti_cookie_kwargs())
    resp.delete_cookie(LTI_STATE_COOKIE, path="/")
    return resp


async def _deep_linking_redirect(claims, platform, session):
    raise HTTPException(status_code=501, detail="Deep linking todavía no implementado.")
