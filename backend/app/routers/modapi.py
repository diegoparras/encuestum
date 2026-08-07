"""Endpoints de `mod_encuestum`, la actividad nativa de Moodle.

Nada de esto usa LTI: Moodle firma un token corto con un secreto compartido que
se establece acá, en el registro. Todo el router vive detrás de `MOD_ENABLED`.

El diseño está en `docs/superpowers/specs/2026-08-06-mod-encuestum-design.md`.
Esta parte es sólo el registro del sitio; el lanzamiento y la nota son otras
tareas.

OJO para quien siga con el lanzamiento: acá el secreto se guarda **hasheado con
bcrypt**, de una sola vía, y eso es deliberado (un volcado de `mod_sites` no
tiene que alcanzar para lanzar como nadie). Verificar un JWT HS256 firmado por
Moodle con ese mismo secreto exige tener el secreto, no su hash: las dos cosas
no pueden ser ciertas a la vez. La salida recomendada es que Moodle canjee el
secreto por un token de lanzamiento servidor a servidor (comparando el hash) en
vez de firmar el JWT él mismo. Está desarrollado en
`.superpowers/sdd/task-mod-1-report.md`.
"""

import logging
import secrets
import uuid
from urllib.parse import urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import ROLE_ADMIN, ROLE_RANK, MoodleSite, Organization
from app.net_guard import UnsafeUrlError, assert_public_url
from app.security import create_purpose_token, hash_password, read_purpose_token

LOGGER = logging.getLogger(__name__)

# Propósito del token que autoriza a `POST /mod/register` a dar de alta un
# sitio contra un `org_id` puntual. Lo mintea `POST /api/v1/mod/connect-url`
# (admin autenticado de esa organización) y es la ÚNICA fuente del `org_id`:
# nunca sale de un parámetro que controle quien llama. La primera versión del
# registro LTI aceptaba `?org_id=<uuid>` sin autenticar y era un IDOR sobre el
# único endpoint cuyo trabajo es crear confianza.
MOD_REGISTER_PURPOSE = "mod_register"
MOD_REGISTER_TOKEN_TTL_MIN = 30

# 36 bytes al azar -> 48 caracteres url-safe (288 bits). Por debajo del tope de
# 72 bytes de bcrypt, así que `hash_password` no lo trunca.
_SECRET_BYTES = 36

_PUERTO_POR_DEFECTO = {"http": 80, "https": 443}

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


def _normalizar_wwwroot(crudo: str) -> str:
    """Forma canónica del `wwwroot`, para que la unicidad no se pueda esquivar.

    `https://moodle.x/`, `https://MOODLE.X` y `https://moodle.x?a=1` son el
    mismo sitio. Si cada variante de escritura fuera una fila distinta, el
    chequeo de dueño del registro (el 409 de más abajo) se saltearía agregando
    una barra final -- y quedarían dos filas para el mismo Moodle, cada una con
    su secreto, sin que nada avise.

    También descarta el userinfo (`https://user:pass@moodle.x`): son
    credenciales que no tienen por qué quedar persistidas, y dos escrituras del
    mismo host con userinfo distinto son el mismo sitio.

    Una URL que no se pueda partir vuelve tal cual, recortada: no es trabajo de
    esta función rechazarla -- eso lo hace `assert_public_url`, que es la única
    validación de URL de este repositorio."""
    crudo = (crudo or "").strip()
    partes = urlsplit(crudo)
    if not partes.scheme or not partes.netloc:
        return crudo
    esquema = partes.scheme.lower()
    host = (partes.hostname or "").lower()
    if not host:
        return crudo
    if ":" in host:
        # IPv6 literal: `hostname` devuelve la dirección sin corchetes y sin
        # ellos la URL reconstruida no sería parseable.
        host = f"[{host}]"
    autoridad = host
    try:
        puerto = partes.port
    except ValueError:
        # Puerto no numérico: la URL está rota, que la rechace el guard.
        return crudo
    # El puerto por defecto del esquema no aporta nada y separaría dos
    # escrituras del mismo sitio (`https://x` y `https://x:443`).
    if puerto is not None and puerto != _PUERTO_POR_DEFECTO.get(esquema):
        autoridad = f"{host}:{puerto}"
    return urlunsplit((esquema, autoridad, partes.path.rstrip("/"), "", ""))


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
    # Token de servicio web con el que después le empujamos la nota a Moodle.
    ws_token: str | None = None
    name: str | None = None


class RegisterOut(BaseModel):
    site_id: str
    wwwroot: str
    # La única vez que este secreto sale de acá. No hay ningún otro endpoint
    # que lo devuelva: lo que queda guardado es sólo su hash.
    secret: str


@router.post("/register", name="mod_register", dependencies=[Depends(require_mod)])
async def register_site(
    payload: RegisterIn,
    session: AsyncSession = Depends(get_session),
) -> RegisterOut:
    """Da de alta (o reconecta) un Moodle y le entrega su secreto compartido.

    Es necesariamente anónimo: lo llama el servidor de Moodle, sin ninguna
    sesión de Encuestum. Por eso el `org_id` sale ÚNICAMENTE del token de
    conexión (ver `MOD_REGISTER_PURPOSE`) y cualquier `org_id` que venga en el
    cuerpo se ignora -- pydantic descarta los campos extra.

    **Un `wwwroot` que ya está bajo otra organización da 409 y no se toca
    nada.** Sin ese chequeo, el Moodle de la escuela A pasaría a lanzar contra
    los datos de la escuela B con sólo registrarse segundo, sin ningún error
    visible para nadie: es el mismo hallazgo que la revisión del registro LTI
    cazó como toma de control entre organizaciones (ver
    `dynamic_registration` en `routers/lti.py`). Un sitio propio, en cambio, sí
    rota el secreto: reconectar es la forma soportada de recuperarse de un
    secreto perdido o comprometido.

    `require_https`: el secreto vuelve en el cuerpo de esta misma respuesta y
    después viaja en cada llamada al servicio web de Moodle. Sin HTTPS iría en
    claro las dos veces."""
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

    wwwroot = _normalizar_wwwroot(payload.wwwroot)
    try:
        assert_public_url(wwwroot, require_https=True)
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=400, detail=f"wwwroot: {exc}") from exc

    secreto = secrets.token_urlsafe(_SECRET_BYTES)
    secret_hash = hash_password(secreto)

    existente = await _sitio_por_wwwroot(session, wwwroot)
    if existente is None:
        sitio = MoodleSite(
            org_id=org_id,
            wwwroot=wwwroot,
            name=payload.name,
            secret_hash=secret_hash,
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
            return RegisterOut(site_id=str(site_id), wwwroot=wwwroot, secret=secreto)

    if existente.org_id != org_id:
        # La fila ya es de OTRA organización: no se adopta ni se toca nada. El
        # mensaje no dice de quién es ni devuelve su `site_id` -- quién tiene
        # qué Moodle conectado no es información que corresponda filtrar.
        raise HTTPException(
            status_code=409,
            detail="Ese Moodle ya está conectado a otra organización de Encuestum.",
        )

    # Reconexión del mismo sitio: rota el secreto sobre la fila que ya está, no
    # crea una segunda. `ws_token` y `name` sólo se pisan si vinieron: una
    # reconexión que no los manda no debe borrar los que ya estaban.
    site_id = existente.id
    existente.secret_hash = secret_hash
    if payload.ws_token is not None:
        existente.ws_token = payload.ws_token
    if payload.name is not None:
        existente.name = payload.name
    session.add(existente)
    await session.commit()
    LOGGER.info("sitio Moodle reconectado (secreto rotado): %s (org %s)", wwwroot, org_id)
    return RegisterOut(site_id=str(site_id), wwwroot=wwwroot, secret=secreto)


async def _sitio_por_wwwroot(session: AsyncSession, wwwroot: str) -> MoodleSite | None:
    """La fila del sitio, buscada SÓLO por `wwwroot` -- nunca por
    `(org_id, wwwroot)`. Filtrar también por organización devolvería `None`
    para el sitio de otra org y el registro seguiría de largo hacia el INSERT:
    exactamente el camino que el 409 existe para cortar."""
    return (
        await session.scalars(select(MoodleSite).where(MoodleSite.wwwroot == wwwroot))
    ).first()
