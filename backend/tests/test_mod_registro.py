"""Registro de sitios Moodle del módulo nativo (`mod_encuestum`).

A diferencia de LTI, acá **el secreto compartido es la única barrera**: quien lo
tenga puede lanzar como cualquier alumno. Por eso dos de estos tests son
críticos y los dos fallan en silencio si la protección se saca --
`test_no_se_puede_robar_el_sitio_de_otra_organizacion` y
`test_el_secreto_no_se_guarda_en_claro`. Están marcados como tales en su propio
docstring; el resto es el contorno normal del endpoint.

El `org_id` sale **únicamente** del token de conexión que mintea
`POST /api/v1/mod/connect-url` (un admin autenticado de esa organización),
nunca de un parámetro que controle quien llama: el mismo diseño que ya usa
`GET /lti/register`, cuya primera versión aceptaba `?org_id=<uuid>` sin
autenticar y era un IDOR."""

import uuid
from urllib.parse import parse_qs, urlparse

import pytest
from sqlmodel import select

from app.models import MoodleSite
from app.routers.modapi import MOD_REGISTER_PURPOSE
from app.security import create_purpose_token, verify_password
from tests.conftest import new_client, register

WWWROOT_A = "https://moodle.escuela-a.test"
WWWROOT_B = "https://moodle.escuela-b.test"


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
        json={"token": token, "wwwroot": WWWROOT_A, "ws_token": "wst-1", "name": "Escuela A"},
    )
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo["site_id"]
    assert len(cuerpo["secret"]) >= 40

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    assert str(sitios[0].org_id) == org_id
    assert sitios[0].ws_token == "wst-1"
    assert sitios[0].name == "Escuela A"


@pytest.mark.asyncio
async def test_registro_de_la_misma_org_rota_el_secreto(mod_on, db_session):
    """Reconectar desde el mismo Moodle no crea una segunda fila: rota el
    secreto sobre la que ya está."""
    await _limpiar_previa(db_session, WWWROOT_A)
    admin, org_id, token = _alta_de_org()
    anon = new_client()

    r1 = anon.post("/mod/register", json={"token": token, "wwwroot": WWWROOT_A})
    assert r1.status_code == 200, r1.text

    token2 = _conectar(admin)
    r2 = anon.post(
        "/mod/register", json={"token": token2, "wwwroot": WWWROOT_A, "ws_token": "wst-2"}
    )
    assert r2.status_code == 200, r2.text

    assert r2.json()["site_id"] == r1.json()["site_id"]
    assert r2.json()["secret"] != r1.json()["secret"]

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    # El secreto viejo ya no vale; el nuevo sí.
    assert not verify_password(r1.json()["secret"], sitios[0].secret_hash)
    assert verify_password(r2.json()["secret"], sitios[0].secret_hash)
    assert sitios[0].ws_token == "wst-2"


@pytest.mark.asyncio
async def test_registro_sin_token_da_400(mod_on, db_session):
    await _limpiar_previa(db_session, WWWROOT_B)
    r = new_client().post("/mod/register", json={"token": "", "wwwroot": WWWROOT_B})
    assert r.status_code == 400
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_registro_con_token_vencido_da_400(mod_on, db_session):
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, _ = _alta_de_org()
    vencido = create_purpose_token(MOD_REGISTER_PURPOSE, {"org_id": org_id}, ttl_minutes=-1)

    r = new_client().post("/mod/register", json={"token": vencido, "wwwroot": WWWROOT_B})
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

    r = new_client().post("/mod/register", json={"token": ajeno, "wwwroot": WWWROOT_B})
    assert r.status_code == 400
    assert await _sitios(db_session, WWWROOT_B) == []


@pytest.mark.asyncio
async def test_el_wwwroot_tiene_que_ser_https(mod_on, db_session):
    """El secreto vuelve en el cuerpo de esta respuesta y después viaja en cada
    llamada al servicio web: sin HTTPS iría en claro."""
    await _limpiar_previa(db_session, "http://moodle.inseguro.test")
    admin, _, token = _alta_de_org()

    r = new_client().post(
        "/mod/register", json={"token": token, "wwwroot": "http://moodle.inseguro.test"}
    )
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

    r = new_client().post(
        "/mod/register",
        json={"token": token_a, "wwwroot": WWWROOT_A, "org_id": org_b},
    )
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

    r1 = anon.post("/mod/register", json={"token": token, "wwwroot": f"{WWWROOT_A}/"})
    assert r1.status_code == 200, r1.text
    assert r1.json()["wwwroot"] == WWWROOT_A

    token2 = _conectar(admin)
    r2 = anon.post(
        "/mod/register", json={"token": token2, "wwwroot": WWWROOT_A.upper().replace("HTTPS", "https")}
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["site_id"] == r1.json()["site_id"]

    assert len(await _sitios(db_session, WWWROOT_A)) == 1


# ── CRÍTICO 1: no se puede robar el sitio de otra organización ───────────────


@pytest.mark.asyncio
async def test_no_se_puede_robar_el_sitio_de_otra_organizacion(mod_on, db_session):
    """CRÍTICO. Registrar el mismo wwwroot desde otra org debe dar 409 y dejar
    el secreto original intacto -- si se sobreescribe, el Moodle de la escuela
    A pasa a lanzar contra los datos de la escuela B, sin ningún error visible
    para nadie. Es exactamente el hallazgo que la revisión del registro LTI
    cazó como toma de control entre organizaciones."""
    await _limpiar_previa(db_session, WWWROOT_A)

    admin_a, org_a, token_a = _alta_de_org()
    anon = new_client()
    r_a = anon.post(
        "/mod/register",
        json={"token": token_a, "wwwroot": WWWROOT_A, "ws_token": "wst-de-A", "name": "Escuela A"},
    )
    assert r_a.status_code == 200, r_a.text
    secreto_de_a = r_a.json()["secret"]
    site_id_de_a = r_a.json()["site_id"]

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1
    original = {
        "id": sitios[0].id,
        "org_id": sitios[0].org_id,
        "wwwroot": sitios[0].wwwroot,
        "name": sitios[0].name,
        "secret_hash": sitios[0].secret_hash,
        "ws_token": sitios[0].ws_token,
    }

    # La organización B es genuinamente otra -- otro admin, otra cuenta -- y
    # apunta su registro al wwwroot que ya usa A.
    admin_b, org_b, token_b = _alta_de_org()
    assert org_b != org_a

    r_b = anon.post(
        "/mod/register",
        json={
            "token": token_b,
            "wwwroot": WWWROOT_A,
            "ws_token": "wst-del-atacante",
            "name": "Escuela B",
        },
    )
    assert r_b.status_code == 409, r_b.text

    # Ni un secreto nuevo ni el site_id de A filtrados en la respuesta del 409.
    assert "secret" not in r_b.text
    assert site_id_de_a not in r_b.text

    sitios = await _sitios(db_session, WWWROOT_A)
    assert len(sitios) == 1, "el 409 no debe dejar una segunda fila para el mismo wwwroot"
    final = sitios[0]
    # Campo por campo, no sólo el status code: si el manejo del choque
    # adoptara la fila, `org_id` y `secret_hash` son justo los dos que el
    # atacante reescribiría para lanzar como cualquier alumno de A.
    assert final.id == original["id"]
    assert final.org_id == original["org_id"]
    assert str(final.org_id) == org_a
    assert final.wwwroot == original["wwwroot"]
    assert final.name == original["name"]
    assert final.secret_hash == original["secret_hash"]
    assert final.ws_token == original["ws_token"]
    # El secreto de A sigue siendo el que vale: no lo rotó el intento de B.
    assert verify_password(secreto_de_a, final.secret_hash)


# ── CRÍTICO 2: el secreto no se guarda en claro ──────────────────────────────


@pytest.mark.asyncio
async def test_el_secreto_no_se_guarda_en_claro(mod_on, db_session):
    """CRÍTICO. Lo que queda en la base no tiene que servir para firmar un
    lanzamiento: se genera una vez, se devuelve una vez, y de ahí en más sólo
    se compara el hash."""
    await _limpiar_previa(db_session, WWWROOT_B)
    admin, org_id, token = _alta_de_org()

    r = new_client().post(
        "/mod/register", json={"token": token, "wwwroot": WWWROOT_B, "ws_token": "wst-x"}
    )
    assert r.status_code == 200, r.text
    secreto = r.json()["secret"]
    assert secreto

    sitios = await _sitios(db_session, WWWROOT_B)
    assert len(sitios) == 1
    sitio = sitios[0]

    # Ninguna columna de la fila contiene el secreto -- ni entera ni como
    # substring, y ni siquiera en la que guarda el token de Moodle.
    for campo, valor in sitio.model_dump().items():
        if isinstance(valor, str):
            assert secreto not in valor, f"el secreto quedó en claro en la columna {campo}"

    # Lo guardado sólo sirve para COMPARAR, y compara bien.
    assert sitio.secret_hash != secreto
    assert verify_password(secreto, sitio.secret_hash)
    assert not verify_password(secreto + "x", sitio.secret_hash)

    # Dos registros del mismo secreto nunca darían el mismo hash (salt), así
    # que el hash tampoco sirve como identificador estable del secreto.
    from app.security import hash_password

    assert hash_password(secreto) != sitio.secret_hash

    # Y no hay ninguna superficie que lo devuelva de nuevo: el segundo registro
    # entrega un secreto NUEVO, no el mismo.
    token2 = _conectar(admin)
    r2 = new_client().post("/mod/register", json={"token": token2, "wwwroot": WWWROOT_B})
    assert r2.status_code == 200, r2.text
    assert r2.json()["secret"] != secreto


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
        json={
            "token": create_purpose_token(
                MOD_REGISTER_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=30
            ),
            "wwwroot": WWWROOT_B,
        },
    )
    assert r.status_code == 404
