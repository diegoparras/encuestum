"""Endpoints LTI 1.3. Todo el router vive detrás de LTI_ENABLED."""

import logging
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import RedirectResponse

from app.config import get_settings
from app.db import get_session
from app.lti.deeplink import DL_PURPOSE, build_response_jwt
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
    sin SameSite=None; Secure el navegador las descarta directamente. A
    diferencia de las cookies de sesión (SameSite=Lax, que sí funcionan sobre
    HTTP plano), acá `Secure` es parte del invariante mismo — no sigue la
    config `cookie_secure` ni se puede apagar. Si esto rompe algo bajo
    TestClient, el fix es que el test hable HTTPS (`base_url="https://..."`),
    no aflojar esta cookie."""
    return {
        "httponly": True,
        "secure": True,
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
    # `target_link_uri` lo manda el llamador (la plataforma, en teoría — pero
    # es un parámetro de request, no algo que hayamos verificado): lo
    # ignoramos siempre y usamos nuestra propia URL de /lti/launch como
    # redirect_uri. Si no, la validación del redirect_uri quedaría delegada
    # por completo a Moodle.
    #
    # Esa URL propia sale de `public_base_url` (ENCUESTUM_PUBLIC_URL), no de
    # `request.url_for`: en el despliegue documentado TLS termina en el
    # proxy, nginx adentro del contenedor habla http y `X-Forwarded-Proto`
    # refleja ese scheme interno (http), no el del cliente original. Usar
    # `request.url_for` calcularía entonces un redirect_uri http:// que
    # Moodle rechaza por no matchear el registrado — y aunque lo aceptara, el
    # form-POST resultante no adjuntaría la cookie `Secure` de state.
    own_launch_url = f"{get_settings().public_base_url}{request.app.url_path_for('launch')}"
    query = {
        "scope": "openid",
        "response_type": "id_token",
        "response_mode": "form_post",
        "prompt": "none",
        "client_id": platform.client_id,
        "redirect_uri": own_launch_url,
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

    try:
        platform_id = uuid.UUID(stored["platform_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Lanzamiento LTI inválido o vencido.") from exc

    platform = await session.get(LtiPlatform, platform_id)
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
    # Defensa en profundidad: el link ya debería atar plataforma y encuesta a
    # la misma org al crearse, pero si un dato mal cargado lo rompiera, no
    # dejar que se convierta en acceso cross-tenant. Mismo 404 que "no hay
    # link" — no hace falta distinguir el caso para quien lanza.
    if platform.org_id is not None and survey.org_id != platform.org_id:
        raise HTTPException(
            status_code=404,
            detail="Esta actividad todavía no tiene una encuesta asignada.",
        )

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
    # El borrado tiene que llevar los mismos atributos con los que se escribió
    # la cookie (SameSite=None; Secure): esta respuesta es un form-POST
    # cross-site, y si el Set-Cookie de borrado no matchea esos atributos el
    # navegador lo descarta — la cookie de state sobreviviría y el par
    # (state, nonce) quedaría reutilizable durante STATE_TTL_S.
    resp.delete_cookie(LTI_STATE_COOKIE, **_lti_cookie_kwargs())
    return resp


async def _deep_linking_redirect(claims, platform, session):
    """Guardamos el contexto del pedido en un token y mandamos al selector."""
    settings_claim = claims.get(CLAIM["DEEP_LINKING_SETTINGS"]) or {}
    if not settings_claim.get("deep_link_return_url"):
        raise HTTPException(status_code=400, detail="El pedido de deep linking no trae URL de retorno.")

    token = create_purpose_token(
        DL_PURPOSE,
        {
            "platform_id": str(platform.id),
            "deployment_id": claims.get(CLAIM["DEPLOYMENT_ID"]),
            "settings": settings_claim,
        },
        ttl_minutes=STATE_TTL_S / 60,
    )
    # Ojo con la ruta: el selector lo sirve Next.js en /lti-select, fuera del
    # espacio /lti/ que nginx manda entero al backend.
    resp = RedirectResponse(f"/lti-select?dl={token}", status_code=302)
    # Mismos atributos con los que se escribió la cookie (SameSite=None;
    # Secure) — no `path="/"` a secas: esta respuesta también es un
    # form-POST cross-site (Moodle posteando el id_token al iframe de
    # /lti/launch), y sin SameSite=None; Secure en el borrado el navegador
    # descarta el Set-Cookie. Sin un store de nonces server-side, este
    # borrado es la única defensa contra reusar el mismo (state, nonce) para
    # volver a pedir un content item durante STATE_TTL_S (ver el comentario
    # análogo en _resource_link_redirect).
    resp.delete_cookie(LTI_STATE_COOKIE, **_lti_cookie_kwargs())
    return resp


async def _dl_platform(session: AsyncSession, dl: str) -> tuple[LtiPlatform, dict]:
    data = read_purpose_token(DL_PURPOSE, dl or "")
    if not data:
        raise HTTPException(status_code=400, detail="Sesión de deep linking vencida.")
    try:
        platform_id = uuid.UUID(data["platform_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Sesión de deep linking vencida.") from exc
    platform = await session.get(LtiPlatform, platform_id)
    if platform is None:
        raise HTTPException(status_code=400, detail="Plataforma LTI no registrada.")
    return platform, data


@router.get("/select/surveys", dependencies=[Depends(require_lti)])
async def select_surveys(dl: str, session: AsyncSession = Depends(get_session)) -> dict:
    """Encuestas publicadas de la organización atada a esta plataforma."""
    platform, _ = await _dl_platform(session, dl)
    rows = (
        await session.scalars(
            select(Survey)
            .where(
                Survey.org_id == platform.org_id,
                Survey.deleted_at.is_(None),
                Survey.status == "published",
            )
            .order_by(Survey.updated_at.desc())
        )
    ).all()
    return {
        "surveys": [
            {
                "id": str(s.id),
                "title": s.title or "Sin título",
                "slug": s.slug,
                "is_exam": bool((s.evaluation or {}).get("enabled")),
            }
            for s in rows
        ]
    }


class DeepLinkReturn(BaseModel):
    dl: str
    survey_id: uuid.UUID


@router.post("/select/return", dependencies=[Depends(require_lti)])
async def select_return(
    payload: DeepLinkReturn,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Firma el content item de la encuesta elegida y dice a dónde postearlo."""
    platform, data = await _dl_platform(session, payload.dl)

    survey = await session.get(Survey, payload.survey_id)
    if survey is None or survey.deleted_at is not None or survey.org_id != platform.org_id:
        raise HTTPException(status_code=404, detail="Encuesta no encontrada.")

    key = await get_tool_key(session)
    # No `request.url_for()`: acá adentro nginx habla http plano y esa URL
    # calcularía scheme http://, que Moodle rechaza al no matchear la
    # registrada (mismo motivo que en login(), ver comentario ahí).
    own_launch_url = f"{get_settings().public_base_url}{request.app.url_path_for('launch')}"
    token = build_response_jwt(
        platform=platform,
        deployment_id=data["deployment_id"],
        settings_claim=data["settings"],
        survey=survey,
        launch_url=own_launch_url,
        key=key,
    )
    return {"action": data["settings"]["deep_link_return_url"], "jwt": token}
