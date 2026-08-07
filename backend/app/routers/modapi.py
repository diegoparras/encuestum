"""Endpoints de `mod_encuestum`, la actividad nativa de Moodle.

Nada de esto usa LTI: Moodle firma un token corto de lanzamiento con **su clave
privada RSA** y Encuestum lo verifica con la pública que quedó registrada acá.
Todo el router vive detrás de `MOD_ENABLED`.

El diseño está en `docs/superpowers/specs/2026-08-06-mod-encuestum-design.md`.
Acá viven el registro del sitio y el lanzamiento. La verificación del token en
sí está en `app/mod/launch.py`, aparte de FastAPI y de la base, y la nota de
vuelta en `app/mod/grades.py` (el POST al servicio web de Moodle), despachada
por `_deliver` en `app/lti/ags.py` -- que es también donde `MOD_ENABLED` corta
cualquier request saliente, no sólo acá.

La firma es asimétrica y no un secreto compartido por una razón concreta:
verificar un HMAC exige tener la misma clave que lo firmó, así que con secreto
compartido Encuestum tendría que guardarlo en claro y de forma reversible --
una credencial que alcanza para lanzar como cualquier alumno de cualquier
curso. Acá lo que se guarda es una clave pública: un volcado de `mod_sites` no
sirve para falsificar ningún lanzamiento. El razonamiento completo (y por qué
la primera versión de esta tarea, con `secret_hash` de bcrypt, era
incompatible con la Tarea 2) está en `.superpowers/sdd/task-mod-1b-report.md`.
"""

import logging
import uuid
from urllib.parse import urlencode

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import RedirectResponse

from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.lti.state import ACCESS_TTL_S, LTI_COOKIE, LTI_PURPOSE, lti_cookie_kwargs
from app.mod.launch import (
    PROPOSITO_LANZAMIENTO,
    PROPOSITO_LISTADO,
    LanzamientoInvalido,
    site_id_declarado,
    verificar_token_moodle,
)
from app.mod.wwwroot import normalizar_wwwroot
from app.models import ROLE_ADMIN, ROLE_RANK, MoodleSite, Organization, Survey
from app.net_guard import UnsafeUrlError, assert_public_url
from app.security import create_purpose_token, read_purpose_token
from app.summarizing import count_questions

LOGGER = logging.getLogger(__name__)

# Propósito del token que autoriza a `POST /mod/register` a dar de alta un
# sitio contra un `org_id` puntual. Lo mintea `POST /api/v1/mod/connect-url`
# (admin autenticado de esa organización) y es la ÚNICA fuente del `org_id`:
# nunca sale de un parámetro que controle quien llama. La primera versión del
# registro LTI aceptaba `?org_id=<uuid>` sin autenticar y era un IDOR sobre el
# único endpoint cuyo trabajo es crear confianza.
MOD_REGISTER_PURPOSE = "mod_register"
MOD_REGISTER_TOKEN_TTL_MIN = 30

# Piso de tamaño de la clave con la que Moodle firma los lanzamientos: el mismo
# que este repositorio usa para generar su propio par LTI (`app/lti/keys.py`),
# así que no hay dos criterios distintos conviviendo. Una RSA de 1024 bits se
# parsea sin problemas y firma tokens que verifican perfecto -- por eso hay que
# rechazarla acá y no confiar en que "si anda, está bien": aceptarla dejaría la
# puerta de entrada al valor de una clave que hoy se considera débil.
_BITS_MINIMOS = 2048

# Una clave RSA de 8192 bits en PEM ronda los 1,6 kB; el tope corta payloads
# absurdos antes de que `load_pem_public_key` (que es C y no tiene límite
# propio) los procese.
_PEM_MAX_BYTES = 8192

# Sin prefijo de versión, igual que `/lti/`: son URLs que el plugin de Moodle
# guarda en sus ajustes y tienen que quedar estables.
router = APIRouter(prefix="/mod", tags=["mod"])
# El alta del link de conexión sí va bajo /api/v1 y detrás de sesión.
admin_router = APIRouter(prefix="/mod", tags=["mod"])


def require_mod() -> None:
    """Con el módulo apagado, la superficie entera no existe: 404, no 403, para
    no revelar que el endpoint está ahí. Mismo criterio que `require_lti()`."""
    if not get_settings().mod_enabled:
        raise HTTPException(status_code=404, detail="Not Found")


def _exigir_admin(ctx: OrgContext) -> None:
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Necesitás ser admin de la organización.")


def _validar_clave_publica(pem: str) -> str:
    """Devuelve la clave en PEM canónico, o levanta 400 si no sirve para nada.

    Esta función es la única barrera entre "Moodle mandó algo" y "Encuestum va
    a verificar firmas de lanzamiento con eso". Una clave que no se pueda usar
    no puede guardarse: el error saldría recién en el primer lanzamiento de un
    alumno, lejos del registro y sin nadie mirando. Se rechazan tres cosas
    distintas, cada una por su motivo:

    - **No parsea** (basura, PEM truncado, texto suelto): no hay con qué
      verificar nada.
    - **No es una clave pública RSA**: pegar la clave PRIVADA por error es el
      accidente más probable de todos, y guardarla sería persistir en claro
      justo la credencial que todo este diseño existe para no tener. También
      cae acá una clave EC o DSA, que no sirve para RS256.
    - **Menos de `_BITS_MINIMOS`**: una RSA de 1024 bits firma y verifica sin
      quejarse, así que ninguna prueba funcional la caza.

    Lo que vuelve es la reserialización en SubjectPublicKeyInfo, no el texto
    que llegó: así lo guardado es exactamente lo que se parseó (sin basura
    pegada después del bloque PEM, y con PKCS#1 y SPKI convergiendo a una sola
    forma, para que dos registros de la misma clave no queden distintos)."""
    pem = (pem or "").strip()
    if not pem:
        raise HTTPException(status_code=400, detail="public_key: falta la clave pública.")
    crudo = pem.encode("utf-8", "replace")
    if len(crudo) > _PEM_MAX_BYTES:
        raise HTTPException(status_code=400, detail="public_key: la clave es demasiado grande.")
    try:
        clave = serialization.load_pem_public_key(crudo)
    except Exception as exc:
        # `load_pem_public_key` levanta ValueError, UnsupportedAlgorithm y algún
        # error propio de OpenSSL según lo que le entre: se atrapa ancho a
        # propósito, porque acá cualquier fallo significa lo mismo.
        raise HTTPException(
            status_code=400,
            detail="public_key: no es una clave pública en formato PEM.",
        ) from exc
    if not isinstance(clave, rsa.RSAPublicKey):
        raise HTTPException(
            status_code=400,
            detail="public_key: tiene que ser una clave pública RSA.",
        )
    if clave.key_size < _BITS_MINIMOS:
        raise HTTPException(
            status_code=400,
            detail=f"public_key: la clave RSA tiene que ser de al menos {_BITS_MINIMOS} bits.",
        )
    return clave.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")


# ── POST /api/v1/mod/connect-url ─────────────────────────────────────────────


class ConnectUrlOut(BaseModel):
    url: str
    token: str
    expires_in: int


@admin_router.post("/connect-url", dependencies=[Depends(require_mod)])
async def connect_url(
    request: Request,
    ctx: OrgContext = Depends(current_context),
) -> ConnectUrlOut:
    """El link que el admin pega en los ajustes del plugin de Moodle.

    Requiere sesión y rango de admin de la organización -- mismo chequeo que
    `POST /api/v1/lti/registration-url` -- porque es la única puerta que decide
    a qué organización queda atado el sitio que se registre en
    `POST /mod/register`.

    Deliberadamente no es de un solo uso, por el mismo razonamiento que el
    `enc` de LTI: la superficie de reuso ya está acotada por los otros dos
    lados (expira en `MOD_REGISTER_TOKEN_TTL_MIN` minutos y sólo lo pudo emitir
    un admin de esa organización), y exigir un solo uso rompería el caso normal
    de que el admin reintente una conexión fallida sin volver a pedir el link.

    La URL sale de `public_base_url`, no de `request.url_for`/`request.base_url`:
    detrás del nginx de este proyecto TLS termina en el proxy y el esquema
    interno es `http://`, así que el link quedaría apuntando al host interno
    -- y encima sin HTTPS, que es justo lo que el registro exige del otro
    lado."""
    _exigir_admin(ctx)
    token = create_purpose_token(
        MOD_REGISTER_PURPOSE,
        {"org_id": str(ctx.org.id)},
        ttl_minutes=MOD_REGISTER_TOKEN_TTL_MIN,
    )
    base = get_settings().public_base_url
    path = request.app.url_path_for("mod_register")
    # El token viaja también en la query para que el admin tenga UNA sola cosa
    # que copiar; el plugin la parte en endpoint + token y lo manda en el
    # cuerpo, que es de donde lo lee `register_site` (una sola vía de entrada).
    return ConnectUrlOut(
        url=f"{base}{path}?{urlencode({'enc': token})}",
        token=token,
        expires_in=MOD_REGISTER_TOKEN_TTL_MIN * 60,
    )


# ── POST /mod/register ───────────────────────────────────────────────────────


class RegisterIn(BaseModel):
    token: str
    wwwroot: str
    # Clave PÚBLICA RSA en PEM: la mitad que Moodle puede regalar del par que
    # generó al conectar. La privada -- la que firma los lanzamientos -- no sale
    # nunca de Moodle, así que Encuestum no la puede perder.
    public_key: str
    # Token de servicio web con el que después le empujamos la nota a Moodle.
    ws_token: str | None = None
    name: str | None = None


class RegisterOut(BaseModel):
    site_id: str
    # Forma canónica del `wwwroot`: el plugin la necesita para saber contra qué
    # `iss` va a firmar. No hay ningún secreto en esta respuesta -- no hay
    # ninguno que dar.
    wwwroot: str


@router.post("/register", name="mod_register", dependencies=[Depends(require_mod)])
async def register_site(
    payload: RegisterIn,
    session: AsyncSession = Depends(get_session),
) -> RegisterOut:
    """Da de alta (o reconecta) un Moodle y guarda su clave pública de firma.

    Es necesariamente anónimo: lo llama el servidor de Moodle, sin ninguna
    sesión de Encuestum. Por eso el `org_id` sale ÚNICAMENTE del token de
    conexión (ver `MOD_REGISTER_PURPOSE`) y cualquier `org_id` que venga en el
    cuerpo se ignora -- pydantic descarta los campos extra.

    **Un `wwwroot` que ya está bajo otra organización da 409 y no se toca
    nada.** Sin ese chequeo, el Moodle de la escuela A pasaría a lanzar contra
    los datos de la escuela B con sólo registrarse segundo, sin ningún error
    visible para nadie: es el mismo hallazgo que la revisión del registro LTI
    cazó como toma de control entre organizaciones (ver
    `dynamic_registration` en `routers/lti.py`). Y no importa que lo que se
    pise sea una clave pública en vez de un secreto: quien reemplaza la clave
    de verificación pasa a poder firmar los lanzamientos de ese sitio con la
    privada que sólo él tiene. Un sitio propio, en cambio, sí rota la clave:
    reconectar es la forma soportada de recuperarse de un par comprometido.

    `require_https`: la clave pública no es secreta, pero el `ws_token` que
    viene en este mismo cuerpo sí lo es, y además una clave que viaje por HTTP
    plano la puede reemplazar cualquiera en el camino -- que es exactamente el
    ataque que la firma asimétrica existe para cerrar."""
    datos = read_purpose_token(MOD_REGISTER_PURPOSE, payload.token or "")
    if not datos:
        raise HTTPException(
            status_code=400,
            detail="Link de conexión vencido o inválido. Generá uno nuevo desde Encuestum.",
        )
    try:
        org_id = uuid.UUID(datos["org_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Link de conexión vencido o inválido. Generá uno nuevo desde Encuestum.",
        ) from exc

    if await session.get(Organization, org_id) is None:
        # Sin esto la FK reventaría en el commit con un 500 crudo. No se guarda
        # ninguna referencia al objeto: más abajo puede haber un `rollback()`
        # que expira todo el identity map de la sesión.
        raise HTTPException(status_code=404, detail="La organización ya no existe.")

    wwwroot = normalizar_wwwroot(payload.wwwroot)
    try:
        assert_public_url(wwwroot, require_https=True)
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=400, detail=f"wwwroot: {exc}") from exc

    # Antes de tocar la base: una clave que no sirve no se guarda. Si esto
    # pasara después del INSERT, una reconexión con la clave equivocada dejaría
    # el sitio sin poder lanzar hasta que alguien lo notara.
    public_key = _validar_clave_publica(payload.public_key)

    existente = await _sitio_por_wwwroot(session, wwwroot)
    if existente is None:
        sitio = MoodleSite(
            org_id=org_id,
            wwwroot=wwwroot,
            name=payload.name,
            public_key=public_key,
            ws_token=payload.ws_token,
        )
        # El id se captura ANTES del commit, no después: hoy el sessionmaker va
        # con `expire_on_commit=False` (`app/db.py`) y leerlo después funciona,
        # pero con el default de SQLAlchemy ese acceso dispara un refresh
        # perezoso que en contexto async revienta con `MissingGreenlet`. Mismo
        # criterio que los locales que captura `routers/lti.py` alrededor de sus
        # commits.
        site_id = sitio.id
        session.add(sitio)
        try:
            await session.commit()
        except IntegrityError:
            # Dos registros del mismo `wwwroot` casi a la vez: el segundo choca
            # contra `uq_mod_site`. Se deshace el intento propio y se sigue con
            # la fila que ganó -- que puede ser de otra organización, y ahí el
            # 409 de abajo es lo único que separa esto de una toma de control.
            await session.rollback()
            existente = await _sitio_por_wwwroot(session, wwwroot)
            if existente is None:
                # No era la carrera esperada: que salga el error real.
                raise
        else:
            LOGGER.info("sitio Moodle registrado: %s (org %s)", wwwroot, org_id)
            return RegisterOut(site_id=str(site_id), wwwroot=wwwroot)

    if existente.org_id != org_id:
        # La fila ya es de OTRA organización: no se adopta ni se toca nada. El
        # mensaje no dice de quién es ni devuelve su `site_id` -- quién tiene
        # qué Moodle conectado no es información que corresponda filtrar.
        raise HTTPException(
            status_code=409,
            detail="Ese Moodle ya está conectado a otra organización de Encuestum.",
        )

    # Reconexión del mismo sitio: rota la clave sobre la fila que ya está, no
    # crea una segunda. `ws_token` y `name` sólo se pisan si vinieron: una
    # reconexión que no los manda no debe borrar los que ya estaban. La clave
    # sí se pisa siempre, porque siempre viene: es obligatoria en el cuerpo.
    site_id = existente.id
    existente.public_key = public_key
    if payload.ws_token is not None:
        existente.ws_token = payload.ws_token
    if payload.name is not None:
        existente.name = payload.name
    session.add(existente)
    await session.commit()
    LOGGER.info("sitio Moodle reconectado (clave rotada): %s (org %s)", wwwroot, org_id)
    return RegisterOut(site_id=str(site_id), wwwroot=wwwroot)


async def _sitio_por_wwwroot(session: AsyncSession, wwwroot: str) -> MoodleSite | None:
    """La fila del sitio, buscada SÓLO por `wwwroot` -- nunca por
    `(org_id, wwwroot)`. Filtrar también por organización devolvería `None`
    para el sitio de otra org y el registro seguiría de largo hacia el INSERT:
    exactamente el camino que el 409 existe para cortar."""
    return (
        await session.scalars(select(MoodleSite).where(MoodleSite.wwwroot == wwwroot))
    ).first()


# ── GET /mod/launch ──────────────────────────────────────────────────────────


def _rechazar(motivo: str, token: str) -> HTTPException:
    """Un solo 401 para todos los motivos por los que un token no vale.

    El motivo se registra pero **no** se devuelve: distinguir "firma inválida"
    de "sitio desconocido" o de "jti repetido" le dice a quien está probando
    exactamente qué le falta ajustar. El texto que ve el alumno tiene que
    servirle al alumno, que lo único que puede hacer es volver a entrar a la
    actividad -- Moodle firma un token nuevo en cada carga."""
    LOGGER.warning("lanzamiento de mod_encuestum rechazado: %s (token=%.12s…)", motivo, token)
    return HTTPException(
        status_code=401,
        detail="Este lanzamiento no es válido o ya venció. Volvé a entrar a la actividad desde Moodle.",
    )


async def _sitio_del_token(session: AsyncSession, t: str, proposito: str) -> tuple[MoodleSite, dict]:
    """El sitio que firmó el token y sus claims ya verificados.

    Es el tramo idéntico de los dos endpoints que Moodle llama firmando
    (`/mod/launch` y `/mod/surveys`), y está compartido para que no haya dos
    copias de la resolución del sitio que puedan divergir. Lo que **no** se
    comparte es el `proposito`: cada endpoint pasa el suyo y por eso el token de
    uno no vale en el otro."""
    site_id = site_id_declarado(t)
    if site_id is None:
        # Ni siquiera se puede leer a qué sitio dice pertenecer: no hay clave
        # con la que verificarlo.
        raise _rechazar("el token no declara un site_id usable", t)

    sitio = await session.get(MoodleSite, site_id)
    if sitio is None:
        # 401 y no 404: qué organización tiene qué Moodle conectado no es
        # información que corresponda filtrar, y para quien lanza el remedio es
        # el mismo (reconectar el plugin).
        raise _rechazar(f"site_id desconocido: {site_id}", t)

    try:
        claims = verificar_token_moodle(t, sitio.public_key, sitio.wwwroot, proposito)
    except LanzamientoInvalido as exc:
        raise _rechazar(str(exc), t) from exc
    return sitio, claims


@router.get("/launch", name="mod_launch", dependencies=[Depends(require_mod)])
async def launch(
    t: str = Query(default="", description="Token de lanzamiento firmado por Moodle (RS256)."),
    session: AsyncSession = Depends(get_session),
):
    """Canjea el token firmado por Moodle por la cookie de sesión de Encuestum.

    Se carga **dentro del iframe de Moodle**, así que el `/mod/` de `nginx.conf`
    lleva la misma relajación de framing que `/lti/` (y `start.sh` genera el
    bloque enmarcable de `/s/` también con `MOD_ENABLED`, no sólo con
    `LTI_ENABLED`): sin eso, el error que se devuelva acá se renderiza con
    `X-Frame-Options: SAMEORIGIN` y el alumno ve un iframe en blanco en vez del
    motivo.

    **La cookie es la de LTI, a propósito** (`LTI_COOKIE`, `LTI_PURPOSE`,
    `lti_cookie_kwargs()`). El lado público (`_lti_context` en
    `routers/public.py`) ya sabe leerla y saltear el PIN con ella; una cookie
    propia obligaría a enseñarle a leer dos y a que `submit` decidiera de cuál
    sacar el anonimato -- dos fuentes de verdad para la misma pregunta.

    Los cinco chequeos (firma, ventana, `jti`, `alg` y organización de la
    encuesta) están repartidos entre `app/mod/launch.py` (los cuatro primeros,
    que no necesitan la base) y esta función (el último, que sí). Cada uno tiene
    su test en `tests/test_mod_launch.py`, verificado rompiendo la validación.

    El sexto es el `purpose`: este endpoint sólo acepta tokens de lanzamiento, y
    el del selector (`/mod/surveys`) sólo los suyos. Ver `app/mod/launch.py`.
    """
    sitio, claims = await _sitio_del_token(session, t, PROPOSITO_LANZAMIENTO)

    try:
        survey_id = uuid.UUID(str(claims.get("survey_id")))
    except (TypeError, ValueError) as exc:
        # 400 y no 401: el token era auténtico, lo que está mal es lo que trae.
        # Es un error del plugin, no de quien lanza, y confundirlo con "token
        # inválido" mandaría a reconectar el sitio para nada.
        raise HTTPException(
            status_code=400, detail="El lanzamiento no trae una encuesta válida."
        ) from exc

    encuesta = await session.get(Survey, survey_id)
    # El mismo 404 para "no existe", "está en la papelera" y "es de otra
    # organización": son el mismo mensaje para el docente que configuró la
    # actividad, y distinguirlos convertiría este endpoint en un oráculo de qué
    # ids de encuesta existen en el resto de la instalación.
    if encuesta is None or encuesta.deleted_at is not None or encuesta.org_id != sitio.org_id:
        LOGGER.warning(
            "lanzamiento de mod_encuestum a una encuesta que no corresponde: %s (sitio %s)",
            survey_id, sitio.id,
        )
        raise HTTPException(
            status_code=404, detail="Esta actividad no apunta a una encuesta de esta organización."
        )

    # `anonymous` congela acá lo que dice Moodle porque Encuestum **no tiene
    # fila** para esta actividad -- a diferencia de LTI, donde `submit` relee
    # `link.anonymous` de la base en cada envío. La fuente de verdad vive del
    # lado de Moodle y sólo llega con el lanzamiento. La ventana de desfasaje
    # es la de la cookie (ACCESS_TTL_S): si el docente marca la actividad como
    # anónima mientras un alumno ya está adentro, ese alumno sigue con la
    # cookie vieja hasta que recargue desde Moodle.
    anonimo = bool(claims.get("anonymous"))
    datos = {
        "slug": encuesta.slug,
        # Sin `link_id`: no hay `LtiResourceLink` que apuntar, y `submit` lo
        # trata como opcional justamente para distinguir los dos orígenes.
        "anonymous": anonimo,
        # Lo que hace falta para empujar la nota al servicio web de Moodle: de
        # qué sitio y de qué actividad vino. No hay otro lado de donde sacarlo
        # -- Encuestum no persiste la actividad.
        "mod_site_id": str(sitio.id),
        "cmid": claims.get("cmid"),
        # La escala del libro la define Moodle, no la rúbrica: es el `grademax`
        # del `grade_item` de esta actividad, y viaja en el token porque el
        # único otro camino sería preguntárselo a Moodle con un round-trip más
        # (y una segunda función de servicio web) por cada nota. La ventana de
        # desfasaje es la misma que la de `anonymous`, acá arriba; el detalle
        # de por qué es aceptable está en `app/mod/grades.py`.
        "grademax": claims.get("grademax"),
    }
    if not anonimo:
        # Con la actividad anónima, Moodle ya no manda nombre ni email; el
        # `sub` sí lo manda igual. Se filtran los tres acá de todas formas: que
        # el anonimato dependa de que el otro lado se acuerde de omitirlos es
        # exactamente la clase de acuerdo que se rompe en la próxima versión
        # del plugin.
        datos["sub"] = claims.get("sub")
        datos["email"] = claims.get("email")
        datos["name"] = claims.get("name")

    token = create_purpose_token(LTI_PURPOSE, datos, ttl_minutes=ACCESS_TTL_S / 60)
    # `/s/{slug}` relativo, no `public_base_url`: detrás del nginx de este
    # proyecto el esquema del request sale `http://`, y un redirect absoluto mal
    # armado sacaría al alumno del iframe (o lo mandaría al host interno).
    resp = RedirectResponse(f"/s/{encuesta.slug}", status_code=302)
    resp.set_cookie(LTI_COOKIE, token, max_age=ACCESS_TTL_S, **lti_cookie_kwargs())
    return resp


# ── GET /mod/surveys ─────────────────────────────────────────────────────────


@router.get("/surveys", name="mod_surveys", dependencies=[Depends(require_mod)])
async def listar_encuestas(
    t: str = Query(default="", description="Token de listado firmado por Moodle (RS256)."),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Las encuestas publicadas de la organización del sitio que firmó.

    Es lo que alimenta el selector de encuesta del `mod_form.php`: lo llama el
    **servidor** de Moodle, no el navegador del docente, así que no hay sesión de
    Encuestum de la que colgarse y la autenticación es la misma firma RS256 del
    lanzamiento -- con `PROPOSITO_LISTADO`, que es lo que impide que este token
    sirva para entrar como alumno (ver `app/mod/launch.py`).

    **El filtro por `org_id` no es una comodidad de presentación.** Es el mismo
    que hace `/lti/select/surveys` y por el mismo motivo: sin él, cualquier
    Moodle conectado -- o sea cualquier escuela -- ve los títulos de las
    encuestas de todas las demás. Sale de `sitio.org_id`, que viene de la fila
    de `mod_sites`, no de nada que traiga el token.

    La forma de la respuesta es la de `/lti/select/surveys` a propósito: es el
    mismo selector con otra puerta de entrada, y `questions` se cuenta con la
    misma función que el resto del producto para que no diga un número distinto
    del que el docente ve en Encuestum."""
    sitio, _ = await _sitio_del_token(session, t, PROPOSITO_LISTADO)

    filas = (
        await session.scalars(
            select(Survey)
            .where(
                Survey.org_id == sitio.org_id,
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
                "questions": count_questions(s.json_schema or {}),
                "updated_at": s.updated_at.isoformat(),
            }
            for s in filas
        ]
    }
