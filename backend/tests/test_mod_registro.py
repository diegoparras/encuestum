"""Registro de sitios Moodle del módulo nativo (`mod_encuestum`).

A diferencia de LTI, este registro es la única puerta que decide **con qué
clave se van a verificar los lanzamientos** de un sitio. La firma es asimétrica
(RS256): Moodle genera el par y manda sólo la pública, así que un volcado de
`mod_sites` no sirve para falsificar nada. Lo que sí sirve es *reemplazar* esa
clave pública, y por eso los dos tests críticos de este archivo son:

- `test_no_se_puede_robar_el_sitio_de_otra_organizacion`: registrar el wwwroot
  de otra organización tiene que dar 409 sin tocar nada. Quien logre pisar la
  clave de verificación pasa a poder firmar lanzamientos de ese sitio con la
  privada que sólo él tiene.
- `test_no_se_acepta_una_clave_que_no_sirve`: una clave rota, una clave privada
  pegada por error o una RSA de 1024 bits tienen que dar 400 y no guardarse.
  Ninguna de las tres se caza en una prueba funcional -- las dos últimas firman
  y verifican perfecto.

El `org_id` sale **únicamente** del token de conexión que mintea
`POST /api/v1/mod/connect-url` (un admin autenticado de esa organización),
nunca de un parámetro que controle quien llama: el mismo diseño que ya usa
`GET /lti/register`, cuya primera versión aceptaba `?org_id=<uuid>` sin
autenticar y era un IDOR."""

import uuid
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from sqlmodel import select

from app.models import MoodleSite
from app.routers.modapi import MOD_REGISTER_PURPOSE
from app.security import create_purpose_token
from tests.conftest import new_client, register

WWWROOT_A = "https://moodle.escuela-a.test"
WWWROOT_B = "https://moodle.escuela-b.test"


# ── Claves de prueba ─────────────────────────────────────────────────────────
#
# Generar RSA es caro (medio segundo por clave de 2048 bits), así que las pocas
# que hacen falta se arman una vez a nivel de módulo y se reusan. Son de
# prueba: no hay ninguna razón para que sean distintas en cada test, salvo
# donde el test compara dos claves entre sí (la rotación), y para eso están
# `_PUB_1` y `_PUB_2`.


def _par(bits: int = 2048) -> tuple[rsa.RSAPrivateKey, str]:
    """Un par RSA nuevo y su clave pública en PEM."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv, pub


_PRIV_1, _PUB_1 = _par()
_PRIV_2, _PUB_2 = _par()

# Lo que el módulo NUNCA tiene que aceptar. Cada una entra por un camino
# distinto de `_validar_clave_publica`.
_PRIV_PEM = _PRIV_1.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode()
_PUB_1024 = _par(1024)[1]
_PUB_EC = (
    ec.generate_private_key(ec.SECP256R1())
    .public_key()
    .public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    .decode()
)
# PEM válido al que le falta el final: parsea hasta la mitad y revienta.
_PUB_TRUNCADA = "\n".join(_PUB_1.splitlines()[:3]) + "\n"


def _conectar(client) -> str:
    """Pide el link de conexión autenticado y devuelve el token que lleva."""
    r = client.post("/api/v1/mod/connect-url")
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _alta_de_org(nombre_wwwroot: str = WWWROOT_A):
    """Un admin nuevo (con su propia organización) y su token de conexión."""
    admin = new_client()
    _, _, me = register(admin)
    return admin, me["orgs"][0]["id"], _conectar(admin)


def _cuerpo(token: str, wwwroot: str, **extra) -> dict:
    """El cuerpo mínimo de un registro válido. `public_key` es obligatoria: sin
    ella pydantic devolvería 422 antes de llegar al endpoint, y varios de estos
    tests verifican un 400 que nace adentro."""
    return {"token": token, "wwwroot": wwwroot, "public_key": _PUB_1, **extra}


async def _sitios(db_session, wwwroot: str) -> list[MoodleSite]:
    async with db_session() as session:
        return list(
            (await session.scalars(select(MoodleSite).where(MoodleSite.wwwroot == wwwroot))).all()
        )


async def _limpiar_previa(db_session, *wwwroots: str) -> None:
    """La base es compartida entre tests dentro de la misma sesión de pytest
    (mismo patrón que `test_lti_register.py`): un sitio dejado por otra corrida
    haría que este test arranque contra una fila que no creó."""
    async with db_session() as session:
        for wwwroot in wwwroots:
            for previo in (
                await session.scalars(select(MoodleSite).where(MoodleSite.wwwroot == wwwroot))
            ).all():
                await session.delete(previo)
        await session.commit()


# ── POST /api/v1/mod/connect-url ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_connect_url_requiere_sesion(mod_on):
    client = new_client()
    r = client.post("/api/v1/mod/connect-url")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_connect_url_requiere_rango_admin(mod_on):
    owner = new_client()
    register(owner)
    org = owner.get("/api/v1/auth/me").json()["orgs"][0]["id"]

    invite = owner.post(
        f"/api/v1/orgs/{org}/invitations", json={"email": "miembro-mod@example.com"}
    ).json()
    assert invite["role"] == "member"

    member = new_client()
    register(member, email="miembro-mod@example.com")
    token = parse_qs(urlparse(invite["accept_url"]).query)["token"][0]
    aceptada = member.post("/api/v1/orgs/accept-invite", json={"token": token})
    assert aceptada.status_code == 200, aceptada.text

    r = member.post("/api/v1/mod/connect-url")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_connect_url_no_usa_el_host_del_request(mod_on):
    """Detrás del nginx de este proyecto el esquema del request sale `http://`:
    si la URL se armara con `request.base_url` en vez de `public_base_url`, el
    admin pegaría en Moodle un link al host interno del TestClient."""
    from app.config import get_settings

    admin, _, _ = _alta_de_org()
    r = admin.post("/api/v1/mod/connect-url")
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert not url.startswith("http://testserver")
    assert url.startswith(f"{get_settings().public_base_url}/mod/register?")


@pytest.mark.asyncio
async def test_el_token_de_conexion_lleva_la_org_de_quien_lo_pide(mod_on):
    from app.security import read_purpose_token

    admin, org_id, token = _alta_de_org()
    datos = read_purpose_token(MOD_REGISTER_PURPOSE, token)
    assert datos is not None
    assert datos["org_id"] == org_id


# ── POST /mod/register ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_registro_da_de_alta_el_sitio(mod_on, db_session):
    await _limpiar_previa(db_session, WWWROOT_A)
    admin, org_id, token = _alta_de_org()

    r = new_client().post(
        "/mod/register",
        json=_cuerpo(token, WWWROOT_A, ws_token="wst-1", name="Escuela A"),
    )
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo["site_id"]
    # No hay ningún secreto que devolver, y no se devuelve ninguno.
    assert "secret" not in cuerpo

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    assert str(sitios[0].org_id) == org_id
    assert sitios[0].ws_token == "wst-1"
    assert sitios[0].name == "Escuela A"
    # Lo guardado es la clave pública, reserializada en SubjectPublicKeyInfo.
    assert sitios[0].public_key.strip() == _PUB_1.strip()


@pytest.mark.asyncio
async def test_registro_de_la_misma_org_rota_la_clave(mod_on, db_session):
    """Reconectar desde el mismo Moodle no crea una segunda fila: rota la clave
    sobre la que ya está. Es la forma soportada de recuperarse de un par
    comprometido."""
    await _limpiar_previa(db_session, WWWROOT_A)
    admin, org_id, token = _alta_de_org()
    anon = new_client()

    r1 = anon.post("/mod/register", json=_cuerpo(token, WWWROOT_A))
    assert r1.status_code == 200, r1.text

    token2 = _conectar(admin)
    r2 = anon.post(
        "/mod/register",
        json={
            "token": token2,
            "wwwroot": WWWROOT_A,
            "public_key": _PUB_2,
            "ws_token": "wst-2",
        },
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["site_id"] == r1.json()["site_id"]

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    # La clave vieja ya no está: los lanzamientos firmados con la privada
    # anterior dejan de verificar, que es justo el punto de rotar.
    assert sitios[0].public_key.strip() == _PUB_2.strip()
    assert sitios[0].public_key.strip() != _PUB_1.strip()
    assert sitios[0].ws_token == "wst-2"


@pytest.mark.asyncio
async def test_registro_sin_token_da_400(mod_on, db_session):
    await _limpiar_previa(db_session, WWWROOT_B)
    r = new_client().post("/mod/register", json=_cuerpo("", WWWROOT_B))
    assert r.status_code == 400
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_registro_con_token_vencido_da_400(mod_on, db_session):
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, _ = _alta_de_org()
    vencido = create_purpose_token(MOD_REGISTER_PURPOSE, {"org_id": org_id}, ttl_minutes=-1)

    r = new_client().post("/mod/register", json=_cuerpo(vencido, WWWROOT_B))
    assert r.status_code == 400
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_un_token_de_otro_proposito_no_sirve(mod_on, db_session):
    """`read_purpose_token` compara el propósito: un token de registro LTI --
    que un admin de cualquier organización puede pedir -- no puede dar de alta
    un sitio del módulo."""
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, _ = _alta_de_org()
    ajeno = create_purpose_token("lti_register", {"org_id": org_id}, ttl_minutes=30)

    r = new_client().post("/mod/register", json=_cuerpo(ajeno, WWWROOT_B))
    assert r.status_code == 400
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_el_wwwroot_tiene_que_ser_https(mod_on, db_session):
    """La clave pública no es secreta, pero el `ws_token` que viaja en el mismo
    cuerpo sí, y una clave que va por HTTP plano la puede reemplazar cualquiera
    en el camino -- justo el ataque que la firma asimétrica cierra."""
    await _limpiar_previa(db_session, "http://moodle.inseguro.test")
    admin, _, token = _alta_de_org()

    r = new_client().post("/mod/register", json=_cuerpo(token, "http://moodle.inseguro.test"))
    assert r.status_code == 400
    assert await _sitios(db_session, "http://moodle.inseguro.test") == []


@pytest.mark.asyncio
async def test_el_org_id_del_cuerpo_se_ignora(mod_on, db_session):
    """El `org_id` sale sólo del token. Mandarlo suelto en el cuerpo -- el IDOR
    que tuvo la primera versión del registro LTI -- no cambia nada."""
    await _limpiar_previa(db_session, WWWROOT_A)
    admin_a, org_a, token_a = _alta_de_org()
    admin_b, org_b, _ = _alta_de_org()
    assert org_a != org_b

    r = new_client().post("/mod/register", json=_cuerpo(token_a, WWWROOT_A, org_id=org_b))
    assert r.status_code == 200, r.text

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    assert str(sitios[0].org_id) == org_a


@pytest.mark.asyncio
async def test_el_wwwroot_se_normaliza(mod_on, db_session):
    """`https://moodle.x/` y `https://MOODLE.x` son el mismo sitio: si cada
    variante fuera una fila distinta, la unicidad -- y con ella el chequeo de
    dueño de más abajo -- se esquivaría con una barra final."""
    await _limpiar_previa(db_session, WWWROOT_A)
    admin, org_id, token = _alta_de_org()
    anon = new_client()

    r1 = anon.post("/mod/register", json=_cuerpo(token, f"{WWWROOT_A}/"))
    assert r1.status_code == 200, r1.text
    assert r1.json()["wwwroot"] == WWWROOT_A

    token2 = _conectar(admin)
    r2 = anon.post(
        "/mod/register",
        json=_cuerpo(token2, WWWROOT_A.upper().replace("HTTPS", "https")),
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["site_id"] == r1.json()["site_id"]

    assert len(await _sitios(db_session, WWWROOT_A)) == 1


# ── CRÍTICO 1: no se puede robar el sitio de otra organización ───────────────


@pytest.mark.asyncio
async def test_no_se_puede_robar_el_sitio_de_otra_organizacion(mod_on, db_session):
    """CRÍTICO. Registrar el mismo wwwroot desde otra org debe dar 409 y dejar
    la fila original intacta -- si se sobreescribe, el Moodle de la escuela A
    pasa a lanzar contra los datos de la escuela B, sin ningún error visible
    para nadie. Que lo que se pisaría sea una clave pública no lo hace menos
    grave: el atacante manda SU clave pública y se queda con la privada, así
    que a partir de ahí firma lanzamientos válidos para el sitio de A. Es
    exactamente el hallazgo que la revisión del registro LTI cazó como toma de
    control entre organizaciones."""
    await _limpiar_previa(db_session, WWWROOT_A)

    admin_a, org_a, token_a = _alta_de_org()
    anon = new_client()
    r_a = anon.post(
        "/mod/register",
        json=_cuerpo(token_a, WWWROOT_A, ws_token="wst-de-A", name="Escuela A"),
    )
    assert r_a.status_code == 200, r_a.text
    site_id_de_a = r_a.json()["site_id"]

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    original = {
        "id": sitios[0].id,
        "org_id": sitios[0].org_id,
        "wwwroot": sitios[0].wwwroot,
        "name": sitios[0].name,
        "public_key": sitios[0].public_key,
        "ws_token": sitios[0].ws_token,
    }

    # La organización B es genuinamente otra -- otro admin, otra cuenta -- y
    # apunta su registro al wwwroot que ya usa A, con SU propia clave.
    admin_b, org_b, token_b = _alta_de_org()
    assert org_b != org_a

    r_b = anon.post(
        "/mod/register",
        json={
            "token": token_b,
            "wwwroot": WWWROOT_A,
            "public_key": _PUB_2,
            "ws_token": "wst-del-atacante",
            "name": "Escuela B",
        },
    )
    assert r_b.status_code == 409, r_b.text

    # Ni el site_id de A filtrado en la respuesta del 409.
    assert site_id_de_a not in r_b.text

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1, "el 409 no debe dejar una segunda fila para el mismo wwwroot"
    final = sitios[0]
    # Campo por campo, no sólo el status code: si el manejo del choque
    # adoptara la fila, `org_id` y `public_key` son justo los dos que el
    # atacante reescribiría para lanzar como cualquier alumno de A.
    assert final.id == original["id"]
    assert final.org_id == original["org_id"]
    assert str(final.org_id) == org_a
    assert final.wwwroot == original["wwwroot"]
    assert final.name == original["name"]
    assert final.public_key == original["public_key"]
    assert final.ws_token == original["ws_token"]
    # La clave que vale sigue siendo la de A: la de B no entró por ningún lado.
    assert final.public_key.strip() == _PUB_1.strip()
    assert _PUB_2.strip() not in final.public_key


# ── CRÍTICO 2: no se acepta una clave que no sirve ───────────────────────────


@pytest.mark.parametrize(
    "etiqueta,clave",
    [
        ("vacía", ""),
        ("basura", "no soy una clave"),
        ("pem truncado", _PUB_TRUNCADA),
        ("clave privada", _PRIV_PEM),
        ("rsa de 1024 bits", _PUB_1024),
        ("clave ec", _PUB_EC),
    ],
)
@pytest.mark.asyncio
async def test_no_se_acepta_una_clave_que_no_sirve(mod_on, db_session, etiqueta, clave):
    """CRÍTICO. La clave que se guarda acá es la que va a decidir qué
    lanzamiento es auténtico, así que una que no sirva tiene que dar 400 y no
    quedar guardada. Los tres casos que importan y que ninguna prueba funcional
    caza:

    - **La clave privada pegada por error** es el accidente más probable de
      todos, y guardarla sería persistir en claro justo la credencial que todo
      este diseño existe para no tener.
    - **Una RSA de 1024 bits** firma y verifica perfecto: si se acepta, el
      sitio queda funcionando con una clave que hoy se considera rompible y
      nadie se entera nunca.
    - **Una clave EC** no sirve para RS256; el error aparecería recién en el
      primer lanzamiento de un alumno, lejos de acá.

    Verificado que discrimina: sacando `_validar_clave_publica` de
    `register_site`, los seis casos devuelven 200 y guardan la fila."""
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, token = _alta_de_org()

    r = new_client().post(
        "/mod/register",
        json={"token": token, "wwwroot": WWWROOT_B, "public_key": clave, "ws_token": "wst-x"},
    )
    assert r.status_code == 400, f"{etiqueta}: {r.status_code} {r.text}"
    assert await _sitios(db_session, WWWROOT_B) == [], f"{etiqueta}: quedó guardada"


@pytest.mark.asyncio
async def test_la_clave_publica_es_obligatoria(mod_on, db_session):
    """Sin `public_key` no hay nada con qué verificar un lanzamiento, así que
    el campo es requerido y pydantic corta con 422 antes de tocar la base. Si
    fuera opcional, un sitio podría quedar registrado sin clave y el error
    saldría recién cuando entrara el primer alumno."""
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, token = _alta_de_org()

    r = new_client().post("/mod/register", json={"token": token, "wwwroot": WWWROOT_B})
    assert r.status_code == 422, r.text
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_la_clave_se_guarda_en_forma_canonica(mod_on, db_session):
    """Moodle puede mandar la misma clave en PKCS#1 (`BEGIN RSA PUBLIC KEY`) o
    en SubjectPublicKeyInfo, y con basura pegada después del bloque PEM. Lo que
    se guarda es siempre la reserialización de lo que se parseó: si no, dos
    registros de la MISMA clave quedarían como textos distintos y cualquier
    comparación posterior mentiría."""
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, token = _alta_de_org()

    pkcs1 = _PRIV_1.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.PKCS1,
    ).decode()
    assert "BEGIN RSA PUBLIC KEY" in pkcs1

    r = new_client().post(
        "/mod/register",
        json={"token": token, "wwwroot": WWWROOT_B, "public_key": pkcs1 + "\nbasura al final\n"},
    )
    assert r.status_code == 200, r.text

    sitios = await _sitios(db_session, WWWROOT_B)
    assert len(sitios) == 1
    assert sitios[0].public_key.strip() == _PUB_1.strip()
    assert "basura" not in sitios[0].public_key


# ── MOD_ENABLED apagado: la superficie no existe ─────────────────────────────


@pytest.mark.asyncio
async def test_con_mod_apagado_la_superficie_no_existe(db_session):
    """404, no 403: con la bandera abajo no se revela que el endpoint está ahí.
    Mismo criterio que `require_lti()`."""
    admin = new_client()
    register(admin)

    r = admin.post("/api/v1/mod/connect-url")
    assert r.status_code == 404

    r = new_client().post(
        "/mod/register",
        json=_cuerpo(
            create_purpose_token(
                MOD_REGISTER_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=30
            ),
            WWWROOT_B,
        ),
    )
    assert r.status_code == 404
