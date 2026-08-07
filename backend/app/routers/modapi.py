"""Endpoints de `mod_encuestum`, la actividad nativa de Moodle.

Nada de esto usa LTI: Moodle firma un token corto de lanzamiento con **su clave
privada RSA** y Encuestum lo verifica con la pública que quedó registrada acá.
Todo el router vive detrás de `MOD_ENABLED`.

El diseño está en `docs/superpowers/specs/2026-08-06-mod-encuestum-design.md`.
Esta parte es sólo el registro del sitio; el lanzamiento y la nota son otras
tareas.

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
from urllib.parse import urlencode, urlsplit, urlunsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
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
from app.security import create_purpose_token, read_purpose_token

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

    wwwroot = _normalizar_wwwroot(payload.wwwroot)
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
