"""Endpoints LTI 1.3. Todo el router vive detrás de LTI_ENABLED."""

import logging
import uuid
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import HTMLResponse, RedirectResponse

from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.lti.ags import SCOPE_LINEITEM, SCOPE_SCORE
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
from app.models import (
    ROLE_ADMIN,
    ROLE_RANK,
    LtiPlatform,
    LtiResourceLink,
    LtiUser,
    Organization,
    Survey,
)
from app.net_guard import UnsafeUrlError, assert_public_url
from app.security import create_purpose_token, read_purpose_token

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/lti", tags=["lti"])

# Propósito del token que autoriza `GET /lti/register` a registrar una
# plataforma contra un `org_id` puntual. Distinto de `registration_token`
# (query param que ya recibe y reenvía el endpoint): ese es el bearer que la
# *plataforma* exige para su propio endpoint de registro; este es un secreto
# nuestro, minteado por `POST /api/v1/lti/registration-url` y nunca visible
# para Moodle. Nombres separados a propósito, para no confundir un secreto
# con el otro.
LTI_REGISTER_PURPOSE = "lti_register"
LTI_REGISTER_TOKEN_TTL_MIN = 30


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


@router.api_route(
    "/login", methods=["GET", "POST"], name="lti_login", dependencies=[Depends(require_lti)]
)
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


_PLATFORM_CONFIG = "https://purl.imsglobal.org/spec/lti-platform-configuration"
_TOOL_CONFIG = "https://purl.imsglobal.org/spec/lti-tool-configuration"

# Página mínima que le avisa a Moodle que el registro terminó bien. Es lo que
# espera el asistente de "registro dinámico" del LMS.
_DONE_HTML = """<!doctype html><meta charset="utf-8"><title>Encuestum</title>
<p>Encuestum quedó conectado. Ya podés cerrar esta ventana.</p>
<script>
  if (window.opener) { window.opener.postMessage({subject: 'org.imsglobal.lti.close'}, '*'); }
  else if (window.parent !== window) { window.parent.postMessage({subject: 'org.imsglobal.lti.close'}, '*'); }
</script>"""


def _texto_no_vacio(valor: object) -> bool:
    """True sólo si `valor` es un string no vacío (más allá de espacios). A
    diferencia de un chequeo de truthiness, un `123` o un `[]` no pasan --
    ambos son el tipo de campo que un documento LTI hostil puede devolver en
    lugar de la URL/string que se espera."""
    return isinstance(valor, str) and bool(valor.strip())


def _campo_extension(doc: dict, clave_extension: str, campo: str) -> object:
    """Lee `doc[clave_extension][campo]`, tratando un contenedor de extensión
    que no sea dict como si estuviera ausente. `_TOOL_CONFIG` y
    `_PLATFORM_CONFIG` son objetos anidados dentro de documentos que no
    controlamos (la respuesta de registro de la plataforma y su configuración
    OpenID); un documento hostil puede mandar, p. ej.,
    `{"lti-tool-configuration": "x"}` en vez de un objeto, y
    `"x".get("deployment_id")` reventaría con AttributeError -- un 500 crudo
    en vez del 502 que el resto de este endpoint ya garantiza."""
    contenedor = doc.get(clave_extension)
    if not isinstance(contenedor, dict):
        return None
    return contenedor.get(campo)


def _frameable(exc: HTTPException) -> HTTPException:
    """Reempaqueta un HTTPException con los mismos headers que vuelven
    frameable a `_DONE_HTML` (ver el comentario ahí sobre por qué). Sin esto,
    un error acá (400/403/404/502) queda bloqueado por el
    `X-Frame-Options: DENY` por default de `main.py` si Moodle encapsula este
    paso del asistente en un iframe -- el admin ve un iframe en blanco en vez
    del motivo del fallo, el mismo síntoma de "asistente colgado" que el
    tratamiento de `_DONE_HTML` ya resuelve para el caso de éxito.
    `HTTPException.headers` los pasa Starlette sin cambios al armar la
    respuesta (`http_exception_handler`), así que alcanza con reconstruir la
    excepción con ellos adentro."""
    headers = {
        **(exc.headers or {}),
        "X-Frame-Options": "",
        "Content-Security-Policy": "frame-ancestors *",
    }
    return HTTPException(status_code=exc.status_code, detail=exc.detail, headers=headers)


@router.get(
    "/register",
    response_class=HTMLResponse,
    dependencies=[Depends(require_lti)],
    name="dynamic_registration",
)
async def dynamic_registration(
    request: Request,
    openid_configuration: str,
    enc: str | None = None,
    registration_token: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    """LTI Dynamic Registration: leemos la configuración del LMS, nos damos de
    alta contra su endpoint de registro y guardamos lo que nos devuelve.

    Este endpoint es necesariamente anónimo -- lo llama el navegador del admin
    de Moodle a mitad del asistente, sin ninguna sesión de Encuestum -- así que
    no puede tomar `org_id` como parámetro suelto: cualquiera que conociera o
    adivinara el UUID de una organización podría registrar ahí una plataforma
    propia y, desde el picker de deep-linking, leer su contenido (IDOR sobre
    el único endpoint cuyo trabajo es crear confianza). En cambio, recibe
    `enc`: un token de propósito minteado por
    `POST /api/v1/lti/registration-url`, que sólo un admin autenticado de esa
    organización puede pedir. El `org_id` sale únicamente de ese token --
    nunca de un parámetro que controle quien llama.

    Deliberadamente no es de un solo uso: no hay tabla de tokens consumidos.
    Se evaluó y se descartó, porque la superficie de reuso ya está acotada por
    otros dos lados -- expira en `LTI_REGISTER_TOKEN_TTL_MIN` minutos y sólo lo
    pudo emitir un admin de esa organización -- y exigir un solo uso rompería
    el caso normal de que Moodle recargue el paso del asistente o el admin
    reintente un registro fallido sin tener que volver a pedir un link nuevo.

    `openid_configuration` (y, adentro de esa respuesta, `registration_endpoint`,
    `authorization_endpoint`, `token_endpoint` y `jwks_uri`) son URLs que trae
    o controla quien llama al endpoint -- todo ese documento sale de un host
    que el admin de la organización elige, no algo que hayamos validado antes.
    Las cinco pasan por el guard SSRF: `openid_configuration` y
    `registration_endpoint` porque este endpoint mismo las dereferencia acá;
    las otras tres porque, aunque acá no se las pide, quedan PERSISTIDAS en la
    fila y se vuelven a pedir después sin ningún guard propio -- `jwks_uri` en
    cada lanzamiento (`app/lti/validate.py::fetch_jwks`) y `token_endpoint` en
    cada AGS (`app/lti/ags.py::get_access_token`). Sin validarlas acá, un
    admin de la propia organización (sin ningún privilegio extra) podía
    apuntar esos fetches futuros a la red interna del host con sólo mintear su
    propio `enc` y armar un `openid_configuration` que él mismo controla.
    `registration_endpoint` además exige HTTPS: es donde le mandamos el
    `registration_token` de la plataforma como bearer, y sin HTTPS viajaría en
    claro.

    Una respuesta hostil o no conforme del LMS (JSON roto, campos faltantes o
    de un tipo que no sea string, status de error) se traduce a un 502 con el
    campo que faltó, no a un 500 crudo. Y si el commit choca contra
    `uq_lti_platform_issuer_client` -- el admin recargó este paso o reintentó
    un registro que ya había completado contra el LMS, el caso que el párrafo
    de arriba nombra como soportado -- se actualiza la fila existente en vez
    de devolver un 500: para cuando llegamos a ese commit, el registro contra
    el LMS ya tuvo éxito, así que fallar le mentiría al admin sobre el estado
    real.

    Esa fila sólo se actualiza si ya era nuestra: `issuer` y `client_id` son
    el par que la fila usa para reconocer un reintento, pero ambos salen
    enteramente de datos que controla quien llama a este mismo endpoint --
    `issuer` de un documento que sirve el host al que el propio admin apunta
    `openid_configuration`, `client_id` de la respuesta del
    `registration_endpoint` de ese mismo host. Un admin de una organización
    podía chocar a propósito contra la fila de OTRA organización con esos dos
    valores y, si el manejo del choque no chequeara dueño, quedarse la fila:
    `org_id`, `jwks_url`, `auth_token_url` y `auth_login_url` pasarían a ser
    los suyos. Si la fila existente pertenece a otro `org_id`, no se adopta:
    mismo 409 que `create_platform` (alta manual) para el mismo choque de
    unicidad, y por el mismo motivo -- no hay nada razonable para adoptar en
    silencio cuando la fila no es tuya."""
    try:
        data = read_purpose_token(LTI_REGISTER_PURPOSE, enc or "")
        if not data:
            raise HTTPException(
                status_code=403,
                detail="Link de registro vencido o inválido. Generá uno nuevo desde Encuestum.",
            )
        try:
            org_id = uuid.UUID(data["org_id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=403,
                detail="Link de registro vencido o inválido. Generá uno nuevo desde Encuestum.",
            ) from exc

        org = await session.get(Organization, org_id)
        if org is None:
            raise HTTPException(status_code=404, detail="La organización ya no existe.")

        try:
            assert_public_url(openid_configuration)
        except UnsafeUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        async with httpx.AsyncClient(timeout=15) as client:
            try:
                conf_resp = await client.get(openid_configuration)
            except httpx.HTTPError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"No se pudo leer la configuración de la plataforma: {exc}",
                ) from exc
        if conf_resp.is_error:
            raise HTTPException(
                status_code=502,
                detail=(
                    "La plataforma devolvió un error al pedir su configuración "
                    f"({conf_resp.status_code})."
                ),
            )
        try:
            conf = conf_resp.json()
        except ValueError as exc:
            raise HTTPException(
                status_code=502,
                detail="La configuración de la plataforma no es JSON válido.",
            ) from exc
        if not isinstance(conf, dict):
            raise HTTPException(
                status_code=502,
                detail="La configuración de la plataforma no es JSON válido.",
            )

        # Campos que esta fila persiste y que después se vuelven a pedir sin
        # ningún guard propio (ver el docstring): faltando cualquiera de estos, ni
        # siquiera tiene sentido seguir. `_texto_no_vacio` exige que sean *string*
        # no vacío, no sólo truthy: un documento hostil que devuelva, por ejemplo,
        # `{"jwks_uri": 123}` pasaría el chequeo de truthiness pero después
        # rompería el guard SSRF (`(123 or "").strip()` explota con AttributeError)
        # o el commit del modelo (SQLModel con `table=True` no valida tipos) -- un
        # 500 crudo por el mismo tipo de respuesta hostil que este bloque ya
        # existía para atajar.
        faltantes = [
            campo
            for campo in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri")
            if not _texto_no_vacio(conf.get(campo))
        ]
        if faltantes:
            raise HTTPException(
                status_code=502,
                detail=f"La configuración de la plataforma no trae: {', '.join(faltantes)}.",
            )

        registration_endpoint = conf.get("registration_endpoint")
        if not isinstance(registration_endpoint, str):
            registration_endpoint = ""
        try:
            # `require_https`: a esta URL le mandamos el `registration_token` de
            # la plataforma como bearer más abajo -- sin HTTPS viajaría en claro.
            assert_public_url(registration_endpoint, require_https=True)
        except UnsafeUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        for campo in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            try:
                assert_public_url(conf[campo])
            except UnsafeUrlError as exc:
                raise HTTPException(status_code=400, detail=f"{campo}: {exc}") from exc

        # Origen público del tool, no el de este `request`: acá adentro nginx
        # habla http plano (TLS termina en el proxy), y lo que le mandamos a
        # Moodle en este paso queda persistido de su lado. Si saliera de
        # `request.base_url` quedaría un registro con scheme http:// que Moodle
        # rechaza al no matchear el dominio público real (mismo motivo que en
        # login() y select_return(), ver comentarios ahí).
        base = get_settings().public_base_url
        login_url = f"{base}{request.app.url_path_for('lti_login')}"
        launch_url = f"{base}{request.app.url_path_for('launch')}"
        jwks_url = f"{base}{request.app.url_path_for('jwks')}"
        tool = {
            "application_type": "web",
            "response_types": ["id_token"],
            "grant_types": ["client_credentials", "implicit"],
            "initiate_login_uri": login_url,
            "redirect_uris": [launch_url],
            "client_name": "Encuestum",
            "jwks_uri": jwks_url,
            "token_endpoint_auth_method": "private_key_jwt",
            "scope": " ".join([SCOPE_LINEITEM, SCOPE_SCORE]),
            _TOOL_CONFIG: {
                "domain": urlparse(base).netloc,
                "target_link_uri": launch_url,
                "claims": ["iss", "sub", "name", "email"],
                "messages": [
                    {
                        "type": "LtiDeepLinkingRequest",
                        "target_link_uri": launch_url,
                        "label": "Elegir una encuesta de Encuestum",
                    }
                ],
            },
        }

        headers = {"Content-Type": "application/json"}
        if registration_token:
            headers["Authorization"] = f"Bearer {registration_token}"
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                resp = await client.post(registration_endpoint, headers=headers, json=tool)
            except httpx.HTTPError as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"No se pudo completar el registro contra la plataforma: {exc}",
                ) from exc
        if resp.is_error:
            raise HTTPException(
                status_code=502,
                detail=f"La plataforma rechazó el registro ({resp.status_code}).",
            )
        try:
            registered = resp.json()
        except ValueError as exc:
            raise HTTPException(
                status_code=502,
                detail="La respuesta de registro de la plataforma no es JSON válido.",
            ) from exc
        if not isinstance(registered, dict) or not _texto_no_vacio(registered.get("client_id")):
            raise HTTPException(
                status_code=502,
                detail="La plataforma no devolvió un client_id.",
            )

        deployment_id = _campo_extension(registered, _TOOL_CONFIG, "deployment_id")
        if not _texto_no_vacio(deployment_id):
            # Sin deployment_id (o con uno que no sea un string usable -- p.
            # ej. un número), `validate_launch` compara contra
            # `deployment_ids` y ese valor nunca matchea el claim string del
            # lanzamiento -- rechaza TODOS los lanzamientos. Guardar la fila
            # igual dejaría una plataforma "registrada con éxito" pero inerte
            # para siempre (Moodle sí manda este campo como string; esto
            # protege contra un LMS que no lo haga, o que lo haga mal). Falla
            # acá, antes de persistir nada.
            raise HTTPException(
                status_code=502,
                detail=(
                    "La plataforma no devolvió un deployment_id en el registro "
                    f"({_TOOL_CONFIG}.deployment_id): sin eso ningún lanzamiento "
                    "va a poder validarse contra esta plataforma."
                ),
            )

        # `name` es puramente informativo (no lo usa ningún guard ni ninguna
        # comparación), a diferencia de `deployment_id` -- así que un valor no
        # usable no amerita fallar el registro entero, sólo omitirlo. Sin este
        # chequeo, un `product_family_code` no-string (p. ej. una lista) entra
        # bien en SQLite (no valida tipos) pero rompe el driver de Postgres en
        # el commit -- un error que el `except IntegrityError` de abajo no
        # atrapa: 500 crudo.
        nombre = _campo_extension(conf, _PLATFORM_CONFIG, "product_family_code")
        platform = LtiPlatform(
            issuer=conf["issuer"],
            client_id=registered["client_id"],
            deployment_ids=[deployment_id],
            auth_login_url=conf["authorization_endpoint"],
            auth_token_url=conf["token_endpoint"],
            jwks_url=conf["jwks_uri"],
            org_id=org_id,
            name=nombre if _texto_no_vacio(nombre) else None,
        )
        session.add(platform)
        try:
            await session.commit()
        except IntegrityError:
            # El admin recargó este paso o reintentó un registro que ya había
            # completado del lado del LMS (ver el docstring de arriba): el
            # commit choca contra `uq_lti_platform_issuer_client`. Actualizamos
            # la fila existente en vez de devolver un 500 -- para cuando
            # llegamos acá, el POST de registro YA tuvo éxito contra el LMS, así
            # que "fallar" le mentiría al admin sobre el estado real, y un 500
            # puntual en el reintento es justo el tropiezo que el diseño
            # no-de-un-solo-uso del `enc` quiso evitar.
            await session.rollback()
            existing = (
                await session.scalars(
                    select(LtiPlatform).where(
                        LtiPlatform.issuer == platform.issuer,
                        LtiPlatform.client_id == platform.client_id,
                    )
                )
            ).first()
            if existing is None:
                # No era la carrera esperada (la fila desapareció entre el fallo
                # y la relectura) -- no hay nada razonable para adoptar en
                # silencio.
                raise
            if existing.org_id != org_id:
                # La fila ya es de OTRA organización (ver el docstring de arriba):
                # no la adoptamos. Mismo 409 -- mismo mensaje -- que el alta
                # manual (`create_platform`) para el mismo choque de unicidad.
                raise HTTPException(
                    status_code=409,
                    detail="Ya existe una plataforma registrada con ese issuer y client_id.",
                )
            existing.deployment_ids = platform.deployment_ids
            existing.auth_login_url = platform.auth_login_url
            existing.auth_token_url = platform.auth_token_url
            existing.jwks_url = platform.jwks_url
            existing.org_id = org_id
            existing.name = platform.name
            session.add(existing)
            await session.commit()
            platform = existing
        LOGGER.info("plataforma LTI registrada: %s (%s)", platform.issuer, platform.client_id)
        response = HTMLResponse(_DONE_HTML)
        # Frameable a propósito en esta respuesta puntual: `main.py` manda
        # `X-Frame-Options: DENY` en todo el backend vía `setdefault` (pensado
        # para una API JSON, que nunca debería vivir en un frame). Esta página sí
        # necesita ser frameable -- si Moodle encapsula este paso del asistente
        # en un iframe en vez de abrir un popup, y el navegador bloquea el frame
        # entero, el branch `window.parent.postMessage(...)` de `_DONE_HTML`
        # jamás corre y el asistente se queda esperando el `org.imsglobal.lti.close`
        # que no va a llegar -- con el registro ya persistido del lado de Moodle.
        # Vacío, no ausente: `setdefault` sólo agrega el header si la clave no
        # está presente, y una clave con valor vacío ya cuenta como presente
        # (ver `MutableHeaders.setdefault` en Starlette) -- así que esto alcanza
        # para que `main.py` no lo pise con DENY. Mismo tratamiento que nginx le
        # da a `/lti-select` (`proxy_hide_header` + `frame-ancestors *`).
        response.headers["X-Frame-Options"] = ""
        response.headers["Content-Security-Policy"] = "frame-ancestors *"
        return response
    except HTTPException as exc:
        # Cualquier error de acá para abajo (403/404/400/502/409) tiene que
        # poder verse dentro del iframe del asistente de Moodle -- ver
        # `_frameable` y el comentario en la respuesta de éxito más abajo.
        raise _frameable(exc) from exc


class PlatformIn(BaseModel):
    issuer: str
    client_id: str
    deployment_ids: list[str]
    auth_login_url: str
    auth_token_url: str
    jwks_url: str
    name: str | None = None


# Router aparte: el alta manual sí va bajo /api/v1 y detrás de sesión.
admin_router = APIRouter(prefix="/lti", tags=["lti"])


@admin_router.post("/platforms", status_code=201, dependencies=[Depends(require_lti)])
async def create_platform(
    payload: PlatformIn,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Alta manual, para los LMS que no soportan registro dinámico."""
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Necesitás ser admin de la organización.")

    # Mismo guard SSRF que `dynamic_registration` y por el mismo motivo (ver
    # el docstring ahí): estas tres URLs se vuelven a pedir después sin
    # ningún guard propio -- `jwks_url` en cada lanzamiento
    # (`app/lti/validate.py::fetch_jwks`) y `auth_token_url` en cada AGS
    # (`app/lti/ags.py::get_access_token`). El alta manual también las recibe
    # sueltas en el payload, sin pasar por ningún documento de la plataforma
    # -- si no se validan acá, es el mismo agujero por una puerta distinta.
    for campo, url in (
        ("auth_login_url", payload.auth_login_url),
        ("auth_token_url", payload.auth_token_url),
        ("jwks_url", payload.jwks_url),
    ):
        try:
            assert_public_url(url)
        except UnsafeUrlError as exc:
            raise HTTPException(status_code=400, detail=f"{campo}: {exc}") from exc

    platform = LtiPlatform(**payload.model_dump(), org_id=ctx.org.id)
    session.add(platform)
    try:
        await session.commit()
    except IntegrityError:
        # A diferencia del reintento de Dynamic Registration (ver el
        # comentario ahí), acá no hay ningún registro contra un LMS que ya
        # haya tenido éxito -- es un admin completando un formulario dos
        # veces. Un 409 explícito, no una actualización silenciosa: quien
        # carga el formulario a mano debería enterarse de que esa plataforma
        # ya existe, no que se sobreescribió sin avisar.
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Ya existe una plataforma registrada con ese issuer y client_id.",
        )
    return {"id": str(platform.id)}


class RegistrationUrlOut(BaseModel):
    url: str


@admin_router.post("/registration-url", dependencies=[Depends(require_lti)])
async def registration_url(
    request: Request,
    ctx: OrgContext = Depends(current_context),
) -> RegistrationUrlOut:
    """El link que el admin pega en el asistente de "registro dinámico" de
    Moodle. Requiere sesión y rango de admin de la organización -- mismo chequeo
    que `create_platform` arriba -- porque es la única puerta de entrada que
    decide a qué organización queda atada la plataforma que se registre en
    `GET /lti/register` (ver el comentario ahí sobre por qué ese endpoint
    anónimo no puede tomar el `org_id` de un parámetro propio)."""
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Necesitás ser admin de la organización.")
    token = create_purpose_token(
        LTI_REGISTER_PURPOSE,
        {"org_id": str(ctx.org.id)},
        ttl_minutes=LTI_REGISTER_TOKEN_TTL_MIN,
    )
    # `public_base_url`, no `request.base_url`/`request.url_for`: mismo motivo
    # que el resto de las URLs LTI que construye este router (ver login(),
    # select_return() y dynamic_registration()) -- acá adentro nginx habla http
    # plano y el link tiene que ser el dominio público real, no el interno.
    base = get_settings().public_base_url
    path = request.app.url_path_for("dynamic_registration")
    return RegistrationUrlOut(url=f"{base}{path}?{urlencode({'enc': token})}")
