"""Registro de plataformas: alta manual y Dynamic Registration.

El link de `GET /lti/register` no lleva más un `org_id` en claro (ver
`app/routers/lti.py`): un admin autenticado lo mintea desde
`POST /api/v1/lti/registration-url` como un token de propósito de vida corta
(`enc`), y el endpoint público deriva el `org_id` únicamente de ese token."""

import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.main import app
from app.models import LtiPlatform
from app.routers.lti import LTI_REGISTER_PURPOSE
from app.security import create_purpose_token
from tests.conftest import new_client, register

ISSUER = "https://moodle.reg"


def _resp(method: str, url: str, status: int, json_body):
    """Respuesta de test con su `Request` adjunto -- httpx sólo arma ese
    vínculo cuando la respuesta viene de una petición real, y `raise_for_status`
    explota con un RuntimeError si no está (mismo patrón que test_lti_ags.py)."""
    return httpx.Response(status, json=json_body, request=httpx.Request(method, url))


@pytest.fixture
def ssrf_guard_on(monkeypatch):
    """Prende el guard SSRF de verdad para un test puntual.

    `conftest.py` deja `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND=true` para toda la
    suite -- así ningún otro test depende de resolución DNS real -- lo que
    vuelve `assert_public_url` un no-op salvo acá. Los tests que usan esta
    fixture arman sus URLs con IPs literales (no hostnames) para no depender
    de DNS tampoco una vez prendido el guard."""
    from app.config import get_settings

    monkeypatch.setenv("ENCUESTUM_ALLOW_PRIVATE_OUTBOUND", "false")
    get_settings.cache_clear()
    yield
    monkeypatch.setenv("ENCUESTUM_ALLOW_PRIVATE_OUTBOUND", "true")
    get_settings.cache_clear()


async def _limpiar_previa(db_session, issuer: str) -> None:
    """La base es compartida entre tests dentro de la misma sesión de pytest:
    si una corrida anterior ya dejó una plataforma con este issuer, hay que
    limpiarla antes de que el endpoint intente insertar otra (mismo patrón que
    test_lti_launch.py)."""
    async with db_session() as session:
        previa = (
            await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).first()
        if previa is not None:
            await session.delete(previa)
            await session.commit()


def _fake_conf(issuer: str, *, sufijo: str = "") -> dict:
    """`sufijo` deja armar un documento con URLs distintas para el mismo
    `issuer` -- lo usa el test cross-tenant para que el documento del
    "atacante" no sea byte-idéntico al de la víctima (ver el comentario ahí)."""
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/mod/lti/auth{sufijo}.php",
        "token_endpoint": f"{issuer}/mod/lti/token{sufijo}.php",
        "jwks_uri": f"{issuer}/mod/lti/certs{sufijo}.php",
        "registration_endpoint": f"{issuer}/mod/lti/openid-registration.php",
    }


def _mint(client: TestClient) -> tuple[str, str]:
    """Pide el link de registro autenticado y devuelve (url, enc)."""
    r = client.post("/api/v1/lti/registration-url")
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    enc = parse_qs(urlparse(url).query)["enc"][0]
    return url, enc


async def _no_hay_plataforma(db_session, issuer: str) -> bool:
    async with db_session() as session:
        p = (await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))).first()
        return p is None


# ── POST /api/v1/lti/registration-url ────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_puede_generar_link_de_registro(lti_on):
    admin = new_client()
    register(admin)
    url, enc = _mint(admin)

    from app.config import get_settings
    from app.security import read_purpose_token

    public_base = get_settings().public_base_url
    assert public_base != "http://testserver"  # el TestClient por defecto
    assert url.startswith(f"{public_base}/lti/register?")
    parsed = parse_qs(urlparse(url).query)
    assert parsed["enc"][0] == enc

    payload = read_purpose_token(LTI_REGISTER_PURPOSE, enc)
    assert payload is not None
    assert payload["purpose"] == LTI_REGISTER_PURPOSE


@pytest.mark.asyncio
async def test_generar_link_no_usa_el_host_del_request(lti_on):
    """Si el código volviera a construir la URL desde `request.base_url` en vez
    de `public_base_url`, este test detectaría la regresión: el TestClient
    habla con `http://testserver`, que nunca coincide con `public_base_url`."""
    admin = new_client()
    register(admin)
    url, _ = _mint(admin)
    assert not url.startswith("http://testserver")


@pytest.mark.asyncio
async def test_generar_link_requiere_sesion(lti_on):
    client = new_client()
    r = client.post("/api/v1/lti/registration-url")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_generar_link_requiere_rango_admin(lti_on):
    owner = new_client()
    register(owner)
    org = owner.get("/api/v1/auth/me").json()["orgs"][0]["id"]

    invite = owner.post(f"/api/v1/orgs/{org}/invitations", json={"email": "miembro-lti@example.com"}).json()
    assert invite["role"] == "member"

    member = new_client()
    register(member, email="miembro-lti@example.com")
    token = parse_qs(urlparse(invite["accept_url"]).query)["token"][0]
    accepted = member.post("/api/v1/orgs/accept-invite", json={"token": token})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["active_org_id"] == org

    r = member.post("/api/v1/lti/registration-url")
    assert r.status_code == 403


# ── GET /lti/register ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dynamic_registration_da_de_alta_la_plataforma(monkeypatch, lti_on, db_session):
    await _limpiar_previa(db_session, ISSUER)
    admin = new_client()
    _, _, me = register(admin)
    org_id = me["orgs"][0]["id"]
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {
            **_fake_conf(ISSUER),
            "https://purl.imsglobal.org/spec/lti-platform-configuration": {
                "product_family_code": "moodle",
                "version": "5.0",
            },
        })

    async def fake_post(self, url, **kw):
        assert url == f"{ISSUER}/mod/lti/openid-registration.php"
        # El LMS devuelve el client_id que nos asigna.
        return _resp("POST", url, 201, {
            "client_id": "assigned-client-id",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {
                "deployment_id": "7",
            },
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{ISSUER}/mod/lti/openid-configuration.php",
            "registration_token": "reg-token",
            "enc": enc,
        },
    )
    assert r.status_code == 200
    assert "postMessage" in r.text  # avisa a Moodle que terminó

    async with db_session() as session:
        p = (await session.scalars(
            select(LtiPlatform).where(LtiPlatform.issuer == ISSUER)
        )).first()
        assert p is not None
        assert p.client_id == "assigned-client-id"
        assert p.deployment_ids == ["7"]
        assert str(p.org_id) == org_id
        assert p.auth_token_url == f"{ISSUER}/mod/lti/token.php"


@pytest.mark.asyncio
async def test_dynamic_registration_usa_la_url_publica_no_la_del_request(monkeypatch, lti_on, db_session):
    """El tool config que mandamos al LMS (initiate_login_uri, redirect_uris,
    jwks_uri, target_link_uri, domain) tiene que salir de `public_base_url`
    (ENCUESTUM_PUBLIC_URL), no de la URL con la que llega el pedido: detrás del
    nginx de este despliegue TLS termina en el proxy y el scheme que ve la app
    adentro es http://. Ese registro queda persistido del lado de Moodle -- si
    saliera de `request.base_url` (que el TestClient completa como
    https://testserver, distinto de `public_base_url` en los tests), Moodle
    guardaría URLs que no matchean el dominio público real y el tool jamás
    podría lanzar."""
    from app.config import get_settings

    issuer = "https://moodle.reg2"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    enviado = {}

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 201, {
            "client_id": "cid-2",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app, base_url="https://testserver")
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 200

    public_base = get_settings().public_base_url
    assert public_base != "https://testserver"
    tool = enviado["json"]
    assert tool["initiate_login_uri"] == f"{public_base}/lti/login"
    assert tool["redirect_uris"] == [f"{public_base}/lti/launch"]
    assert tool["jwks_uri"] == f"{public_base}/lti/jwks.json"
    tool_config = tool["https://purl.imsglobal.org/spec/lti-tool-configuration"]
    assert tool_config["target_link_uri"] == f"{public_base}/lti/launch"
    assert tool_config["domain"] == urlparse(public_base).netloc


def _fake_transporte_exitoso(llamadas_post: list, issuer: str):
    """Instala un `get`/`post` que, si el endpoint llegara a usarlos, darían de
    alta la plataforma sin problema. Sin esto, un test de "no crea plataforma"
    es casi tautológico: sin transporte instalado, el `httpx.AsyncClient` real
    intentaría salir a la red, fallaría (sandbox sin acceso), y "no hay fila"
    sería cierto por una razón completamente ajena al guard bajo prueba. Con
    este transporte, si el guard bajo prueba se rompiera, el flujo llegaría
    hasta el final y SÍ crearía una fila -- así la ausencia de fila queda
    atribuida al guard, no a que la red esté cortada en el sandbox de test."""

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {
            "client_id": "no-deberia-registrarse",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    return fake_get, fake_post


@pytest.mark.asyncio
async def test_register_sin_enc_da_403_y_no_crea_plataforma(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.sin-enc"
    await _limpiar_previa(db_session, issuer)
    llamadas_post: list = []
    fake_get, fake_post = _fake_transporte_exitoso(llamadas_post, issuer)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={"openid_configuration": f"{issuer}/mod/lti/openid-configuration.php"},
    )
    assert r.status_code == 403
    assert not llamadas_post  # nunca se llegó a pedir el registro contra la plataforma
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_malformado_da_403_y_no_crea_plataforma(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.enc-malformado"
    await _limpiar_previa(db_session, issuer)
    llamadas_post: list = []
    fake_get, fake_post = _fake_transporte_exitoso(llamadas_post, issuer)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": "esto-no-es-un-jwt",
        },
    )
    assert r.status_code == 403
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_vencido_da_403_y_no_crea_plataforma(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.enc-vencido"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    _, _, me = register(admin)
    org_id = me["orgs"][0]["id"]  # org real: si el chequeo de vencimiento no
    # cortara acá, el resto del flujo (org existente + transporte que
    # funciona) alcanzaría para crear la fila.
    enc = create_purpose_token(LTI_REGISTER_PURPOSE, {"org_id": org_id}, ttl_minutes=-1)
    llamadas_post: list = []
    fake_get, fake_post = _fake_transporte_exitoso(llamadas_post, issuer)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 403
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_de_otro_proposito_da_403_y_no_crea_plataforma(monkeypatch, lti_on, db_session):
    """Un token minteado para otra cosa (p. ej. el state OIDC) no puede
    reutilizarse acá -- el `purpose` firmado adentro tiene que matchear."""
    from app.lti.state import LTI_STATE_PURPOSE

    issuer = "https://moodle.otro-proposito"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    _, _, me = register(admin)
    org_id = me["orgs"][0]["id"]  # org real, misma razón que en el test de arriba.
    enc = create_purpose_token(LTI_STATE_PURPOSE, {"org_id": org_id}, ttl_minutes=30)
    llamadas_post: list = []
    fake_get, fake_post = _fake_transporte_exitoso(llamadas_post, issuer)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 403
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_org_inexistente_da_404_y_no_crea_plataforma(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.org-inexistente"
    await _limpiar_previa(db_session, issuer)
    enc = create_purpose_token(LTI_REGISTER_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=30)
    llamadas_post: list = []
    fake_get, fake_post = _fake_transporte_exitoso(llamadas_post, issuer)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 404
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_ignora_org_id_que_mande_el_llamador(monkeypatch, lti_on, db_session):
    """El org al que queda atada la plataforma tiene que salir del token, no de
    ningún parámetro que el llamador pueda mandar -- ni siquiera si manda un
    `org_id` de más en la query string apuntando a otra organización."""
    issuer = "https://moodle.org-id-ignorado"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    _, _, me = register(admin)
    org_legitimo = me["orgs"][0]["id"]
    _, enc = _mint(admin)
    org_ajeno = str(uuid.uuid4())
    assert org_ajeno != org_legitimo

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-suplantado",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
            "org_id": org_ajeno,  # ignorado: el endpoint ya no acepta este parámetro
        },
    )
    assert r.status_code == 200

    async with db_session() as session:
        p = (await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))).first()
        assert p is not None
        assert str(p.org_id) == org_legitimo
        assert str(p.org_id) != org_ajeno


# ── Critical: no adoptar una fila que ya pertenece a otra organización ───────
#
# `(issuer, client_id)` sale enteramente de datos que controla quien llama:
# `issuer` es un string suelto dentro del JSON que sirve el host al que el
# propio admin apunta `openid_configuration` (nada lo ata a ese host), y
# `client_id` sale de la respuesta del `registration_endpoint` de ESE MISMO
# host -- también bajo control del llamador. Un admin de la organización A
# podía mintear su propio `enc`, apuntar el registro a un host HTTPS propio, y
# hacer que ese host devolviera el `issuer` y el `client_id` de la
# organización B a propósito: el manejo de `uq_lti_platform_issuer_client` de
# más arriba adoptaba la fila de B sin chequear que ya perteneciera a otro
# `org_id` -- reasignándole `org_id`, `jwks_url`, `auth_token_url` y
# `auth_login_url` al atacante. Compromiso total de la confianza LTI de B.


@pytest.mark.asyncio
async def test_dynamic_registration_no_adopta_fila_de_otra_organizacion(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.cross-tenant"
    client_id_compartido = "client-compartido"
    await _limpiar_previa(db_session, issuer)

    # Organización A registra su plataforma legítimamente.
    admin_a = new_client()
    _, _, me_a = register(admin_a)
    org_a = me_a["orgs"][0]["id"]
    _, enc_a = _mint(admin_a)

    async def fake_get_a(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post_a(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": client_id_compartido,
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get_a)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post_a)

    client = TestClient(app)
    r1 = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc_a,
        },
    )
    assert r1.status_code == 200, r1.text

    async with db_session() as session:
        fila_original = (
            await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).first()
        assert fila_original is not None
        assert str(fila_original.org_id) == org_a
        snapshot = {
            "id": fila_original.id,
            "issuer": fila_original.issuer,
            "client_id": fila_original.client_id,
            "deployment_ids": list(fila_original.deployment_ids),
            "auth_login_url": fila_original.auth_login_url,
            "auth_token_url": fila_original.auth_token_url,
            "jwks_url": fila_original.jwks_url,
            "org_id": fila_original.org_id,
            "name": fila_original.name,
        }

    # Organización B es genuinamente distinta -- otro admin, otra cuenta. El
    # atacante apunta su propio `openid_configuration` a un documento que él
    # mismo controla, y ese documento devuelve -- a propósito -- el issuer y
    # el client_id que YA usa la organización A. `sufijo="-atacante"` hace que
    # `auth_login_url`, `auth_token_url` y `jwks_url` NO sean byte-idénticas a
    # las de A (antes, las dos organizaciones armaban su documento con el
    # mismo `_fake_conf(issuer)`, así que esas tres URLs coincidían siempre --
    # las comparaciones de más abajo no podían fallar ni bajo adopción total
    # de la fila). Con URLs propias, esas tres comparaciones sí tienen dientes
    # -- en particular `jwks_url`, que es el premio que el comentario de más
    # arriba nombra explícitamente: si el ownership check no cortara, el
    # atacante dejaría sus propias claves ahí para poder forjar lanzamientos
    # contra el issuer de A.
    admin_b = new_client()
    _, _, me_b = register(admin_b)
    org_b = me_b["orgs"][0]["id"]
    assert org_b != org_a
    _, enc_b = _mint(admin_b)

    async def fake_get_b(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer, sufijo="-atacante"))

    async def fake_post_b(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": client_id_compartido,  # coincide a propósito con el de A
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "666"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get_b)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post_b)

    r2 = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc_b,
        },
    )
    assert r2.status_code == 409, r2.text
    assert "issuer" in r2.json()["detail"]
    assert "client_id" in r2.json()["detail"]

    async with db_session() as session:
        fila_final = (
            await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).first()
        assert fila_final is not None
        # La fila de la organización A queda intacta -- campo por campo, no
        # sólo el status code. En particular org_id y jwks_url: si el ownership
        # check no corriera, estos dos serían justo los que el atacante
        # reescribiría (org_id -> su propia org; jwks_url -> sus propias
        # claves, para poder forjar lanzamientos contra el issuer de A).
        assert fila_final.id == snapshot["id"]
        assert fila_final.issuer == snapshot["issuer"]
        assert fila_final.client_id == snapshot["client_id"]
        assert fila_final.deployment_ids == snapshot["deployment_ids"]
        assert fila_final.auth_login_url == snapshot["auth_login_url"]
        assert fila_final.auth_token_url == snapshot["auth_token_url"]
        assert fila_final.jwks_url == snapshot["jwks_url"]
        assert fila_final.org_id == snapshot["org_id"]
        assert str(fila_final.org_id) == org_a
        assert fila_final.name == snapshot["name"]

    # No se creó una segunda fila -- el intento de B murió en el 409, no en
    # una fila nueva suelta.
    async with db_session() as session:
        filas = (
            await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).all()
        assert len(filas) == 1


# ── Minor 1: campos no-string en el documento también dan 502, no 500 ────────
#
# El chequeo de "faltantes" sólo probaba truthiness: un documento hostil que
# devuelva, p. ej., `{"jwks_uri": 123}` lo pasaba igual (123 es truthy) y
# después reventaba el guard SSRF -- `(123 or "").strip()` explota con
# AttributeError -- o el commit del modelo (SQLModel con `table=True` no
# valida tipos). Mismo problema para un `issuer` o `client_id` no-string.


@pytest.mark.asyncio
async def test_dynamic_registration_jwks_uri_no_string_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.jwks-no-string"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["jwks_uri"] = 123  # no-string, pero truthy
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502, r.text  # no un 500 crudo
    assert "jwks_uri" in r.json()["detail"]
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_issuer_no_string_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.issuer-no-string"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["issuer"] = ["no", "es", "un", "string"]
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502, r.text
    assert "issuer" in r.json()["detail"]
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_client_id_no_string_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.client-id-no-string"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": 42,  # no-string, pero truthy
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502, r.text  # no un 500 crudo (ni un IntegrityError en el commit)
    assert "client_id" in r.json()["detail"]
    assert await _no_hay_plataforma(db_session, issuer)


# ── Minor 1b: contenedores de extensión no-dict, deployment_id y name hostiles
#
# `_texto_no_vacio` ya cubre los campos de nivel superior del documento
# (issuer, *_endpoint, jwks_uri, client_id), pero tres puntos seguían leyendo
# `(doc.get(EXTENSION) or {}).get(campo)` asumiendo que el valor de la
# extensión es un dict cuando es truthy. Un documento hostil que devuelva,
# p. ej., `"lti-tool-configuration": "x"` hace que `"x".get(...)` reviente con
# AttributeError -- un 500 crudo, no el 502 que el resto del endpoint ya
# garantiza. `deployment_id` y `name` (`product_family_code`) tampoco
# validaban que el valor final fuera un string usable.


@pytest.mark.asyncio
async def test_dynamic_registration_tool_config_no_dict_da_502(
    monkeypatch, lti_on, db_session
):
    """`registered[_TOOL_CONFIG]` no es un dict -- antes del guard, leer
    `.get("deployment_id")` sobre un string revienta con AttributeError (500
    crudo). Con el guard, se trata como si la extensión no viniera: falta
    deployment_id, mismo 502 de siempre."""
    issuer = "https://moodle.tool-config-no-dict"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-tool-config-no-dict",
            # Extensión hostil: un string en vez de un objeto.
            "https://purl.imsglobal.org/spec/lti-tool-configuration": "x",
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502, r.text  # no un 500 crudo
    assert "deployment_id" in r.json()["detail"]
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_platform_config_no_dict_omite_name(
    monkeypatch, lti_on, db_session
):
    """`conf[_PLATFORM_CONFIG]` no es un dict -- mismo AttributeError que el
    caso anterior, pero del lado del documento de configuración (afecta
    `name`, no `deployment_id`). El registro tiene que seguir andando: `name`
    queda en None en vez de tumbar el endpoint."""
    issuer = "https://moodle.platform-config-no-dict"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        # Extensión hostil: un string en vez de un objeto.
        conf["https://purl.imsglobal.org/spec/lti-platform-configuration"] = "x"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-platform-config-no-dict",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 200, r.text  # no un 500 crudo -- el registro igual anda

    async with db_session() as session:
        p = (await session.scalars(
            select(LtiPlatform).where(LtiPlatform.issuer == issuer)
        )).first()
        assert p is not None
        assert p.name is None  # omitido, no un valor basura


@pytest.mark.asyncio
async def test_dynamic_registration_deployment_id_no_string_da_502(
    monkeypatch, lti_on, db_session
):
    """`deployment_id` no-string (ej. un número) persistiría sin problema en la
    columna JSON y nunca matchearía el claim string del lanzamiento --
    exactamente el escenario "registro exitoso, plataforma inerte" que el
    chequeo de ausencia ya existía para evitar. Mismo trato: 502, no fila."""
    issuer = "https://moodle.deployment-id-no-string"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-deployment-id-no-string",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": 123},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502, r.text
    assert "deployment_id" in r.json()["detail"]
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_name_no_string_omite_name(
    monkeypatch, lti_on, db_session
):
    """`product_family_code` no-string (ej. una lista) guarda bien en SQLite
    pero rompe el driver de Postgres en el commit -- error que `except
    IntegrityError` no atrapa (500 crudo). El registro tiene que completarse
    igual, con `name` en None en vez de ese valor basura."""
    issuer = "https://moodle.name-no-string"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["https://purl.imsglobal.org/spec/lti-platform-configuration"] = {
            "product_family_code": ["no", "es", "un", "string"],
        }
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-name-no-string",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 200, r.text  # no un 500 crudo -- el registro igual anda

    async with db_session() as session:
        p = (await session.scalars(
            select(LtiPlatform).where(LtiPlatform.issuer == issuer)
        )).first()
        assert p is not None
        assert p.name is None  # omitido, no un valor basura


# ── Minor 2: las respuestas de error también tienen que ser frameables ───────
#
# Sólo la página de éxito (`_DONE_HTML`) tenía el tratamiento frameable. Un
# 400/403/404/502 renderizado adentro del iframe de registro de Moodle
# quedaba bloqueado por el `X-Frame-Options: DENY` por default de `main.py`
# -- el admin veía un iframe en blanco en vez del motivo del fallo, el mismo
# síntoma de "asistente colgado" que el fix original resolvió sólo para el
# camino feliz.


@pytest.mark.asyncio
async def test_dynamic_registration_error_403_es_frameable(lti_on):
    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={"openid_configuration": "https://moodle.no-importa/conf.php"},
    )
    assert r.status_code == 403
    assert r.headers.get("x-frame-options") == ""
    assert r.headers.get("content-security-policy") == "frame-ancestors *"


@pytest.mark.asyncio
async def test_dynamic_registration_error_502_es_frameable(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.error-502-frameable"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 500, {"error": "server_error"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert r.headers.get("x-frame-options") == ""
    assert r.headers.get("content-security-policy") == "frame-ancestors *"


@pytest.mark.asyncio
async def test_dynamic_registration_error_409_es_frameable(monkeypatch, lti_on, db_session):
    """El propio 409 del hallazgo crítico (fila de otra organización) también
    tiene que ser frameable -- es el error que más importa que el admin vea,
    porque significa que su LMS quedó sin registrar."""
    issuer = "https://moodle.error-409-frameable"
    client_id_compartido = "client-409-frameable"
    await _limpiar_previa(db_session, issuer)

    admin_a = new_client()
    register(admin_a)
    _, enc_a = _mint(admin_a)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": client_id_compartido,
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r1 = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc_a,
        },
    )
    assert r1.status_code == 200, r1.text

    admin_b = new_client()
    register(admin_b)
    _, enc_b = _mint(admin_b)
    r2 = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc_b,
        },
    )
    assert r2.status_code == 409, r2.text
    assert r2.headers.get("x-frame-options") == ""
    assert r2.headers.get("content-security-policy") == "frame-ancestors *"


@pytest.mark.asyncio
async def test_alta_manual_requiere_sesion(lti_on):
    client = TestClient(app)
    r = client.post("/api/v1/lti/platforms", json={
        "issuer": "https://otro.moodle", "client_id": "x", "deployment_ids": ["1"],
        "auth_login_url": "https://otro.moodle/a", "auth_token_url": "https://otro.moodle/t",
        "jwks_url": "https://otro.moodle/j",
    })
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_alta_manual_admin_puede_dar_de_alta_una_plataforma(lti_on, db_session):
    issuer = "https://moodle.manual-ok"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    _, _, me = register(admin)
    org_id = me["orgs"][0]["id"]

    r = admin.post("/api/v1/lti/platforms", json={
        "issuer": issuer,
        "client_id": "cid-manual-ok",
        "deployment_ids": ["1"],
        "auth_login_url": f"{issuer}/auth",
        "auth_token_url": f"{issuer}/token",
        "jwks_url": f"{issuer}/certs",
    })
    assert r.status_code == 201, r.text
    platform_id = r.json()["id"]

    async with db_session() as session:
        p = await session.get(LtiPlatform, uuid.UUID(platform_id))
        assert p is not None
        assert p.issuer == issuer
        assert str(p.org_id) == org_id


@pytest.mark.asyncio
async def test_alta_manual_requiere_rango_admin(lti_on, db_session):
    """Mismo chequeo de rango que `POST /registration-url` (ver el comentario
    en `registration_url`): un miembro sin rango admin no puede dar de alta
    una plataforma para la organización."""
    issuer = "https://moodle.manual-403"
    await _limpiar_previa(db_session, issuer)
    owner = new_client()
    register(owner)
    org = owner.get("/api/v1/auth/me").json()["orgs"][0]["id"]

    invite = owner.post(
        f"/api/v1/orgs/{org}/invitations", json={"email": "miembro-lti-manual@example.com"}
    ).json()
    assert invite["role"] == "member"

    member = new_client()
    register(member, email="miembro-lti-manual@example.com")
    token = parse_qs(urlparse(invite["accept_url"]).query)["token"][0]
    accepted = member.post("/api/v1/orgs/accept-invite", json={"token": token})
    assert accepted.status_code == 200, accepted.text

    r = member.post("/api/v1/lti/platforms", json={
        "issuer": issuer,
        "client_id": "cid-manual-403",
        "deployment_ids": ["1"],
        "auth_login_url": f"{issuer}/auth",
        "auth_token_url": f"{issuer}/token",
        "jwks_url": f"{issuer}/certs",
    })
    assert r.status_code == 403
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_alta_manual_rechaza_url_privada(ssrf_guard_on, lti_on, db_session):
    """Mismo guard SSRF que Dynamic Registration, y por el mismo motivo: estas
    tres URLs se vuelven a pedir sin ningún guard después (`app/lti/validate.py`
    para `jwks_url`, `app/lti/ags.py` para `auth_token_url`) -- si el alta
    manual las persistiera sin validar, sería el mismo agujero por una puerta
    distinta."""
    issuer = "https://moodle.manual-privado"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)

    r = admin.post("/api/v1/lti/platforms", json={
        "issuer": issuer,
        "client_id": "cid-manual-privado",
        "deployment_ids": ["1"],
        "auth_login_url": "https://93.184.216.34/auth",
        "auth_token_url": "https://93.184.216.34/token",
        "jwks_url": "http://127.0.0.1:6379/",
    })
    assert r.status_code == 400
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_login_uri_resuelve_a_lti_login_y_no_colisiona_con_auth(monkeypatch, lti_on, db_session):
    """`request.app.url_path_for('lti_login')` tiene que resolver a `/lti/login`.
    Sin el `name="lti_login"` explícito en la ruta, el nombre por defecto
    ('login') colisiona con `auth.py`, y `url_path_for` devuelve
    `/api/v1/auth/login` -- un `initiate_login_uri` roto para cualquier Moodle
    que se registre."""
    issuer = "https://moodle.name-collision"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    enviado = {}

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        enviado["json"] = kw.get("json")
        return _resp("POST", url, 201, {
            "client_id": "cid-name-collision",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 200

    from app.config import get_settings

    assert enviado["json"]["initiate_login_uri"] == f"{get_settings().public_base_url}/lti/login"


# ── Important 1: SSRF -- las URLs que la fila PERSISTE también pasan el guard ─
#
# `openid_configuration` y `registration_endpoint` ya pasaban por
# `assert_public_url` porque el propio endpoint las dereferencia. Pero
# `authorization_endpoint`, `token_endpoint` y `jwks_uri` venían del mismo
# documento no confiable y se guardaban tal cual -- para volver a pedirse
# después SIN ningún guard: `jwks_url` en cada lanzamiento
# (`app/lti/validate.py::fetch_jwks`) y `auth_token_url` en cada AGS
# (`app/lti/ags.py::get_access_token`). Un admin de la propia organización
# (sin privilegio extra) podía mintear su propio `enc` y apuntar esos fetches
# futuros a la red interna del host -- ni siquiera hacía falta comprometer
# nada.


@pytest.mark.asyncio
async def test_dynamic_registration_rechaza_authorization_endpoint_privado(
    ssrf_guard_on, monkeypatch, lti_on, db_session
):
    issuer = "https://93.184.216.34"  # IP pública literal: no depende de DNS
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["authorization_endpoint"] = "http://127.0.0.1:6379/"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 400
    assert not llamadas_post  # el guard corta antes de pedir el registro
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_rechaza_token_endpoint_privado(
    ssrf_guard_on, monkeypatch, lti_on, db_session
):
    issuer = "https://93.184.216.35"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["token_endpoint"] = "http://169.254.169.254/latest/meta-data"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 400
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_rechaza_jwks_uri_privada(
    ssrf_guard_on, monkeypatch, lti_on, db_session
):
    """El escenario exacto del hallazgo: `jwks_uri` apuntando a un puerto de la
    red interna (acá, un Redis local) -- y la validación tiene que cortar
    ANTES de mandar el POST de registro, no después."""
    issuer = "https://93.184.216.36"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["jwks_uri"] = "http://127.0.0.1:6379/"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 400
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


# ── Minor: registration_endpoint http:// no puede llevar el bearer en claro ──


@pytest.mark.asyncio
async def test_dynamic_registration_exige_https_en_registration_endpoint(
    monkeypatch, lti_on, db_session
):
    """`registration_endpoint` recibe el `registration_token` de la plataforma
    como bearer (más abajo, `headers["Authorization"]`). Sin exigir HTTPS acá,
    un `registration_endpoint` `http://` se lo llevaría en texto plano. Este
    chequeo corre ANTES del escape `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND` de los
    tests (ver `assert_public_url`), así que no hace falta `ssrf_guard_on`."""
    issuer = "https://moodle.reg-http"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        conf["registration_endpoint"] = f"http://{urlparse(issuer).netloc}/mod/lti/openid-registration.php"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "registration_token": "el-secreto-de-moodle",
            "enc": enc,
        },
    )
    assert r.status_code == 400
    assert "HTTPS" in r.json()["detail"]
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


# ── Minor: el registration_token realmente llega al endpoint de la plataforma


@pytest.mark.asyncio
async def test_dynamic_registration_reenvia_registration_token(monkeypatch, lti_on, db_session):
    """Los dos fakes de transporte del resto del archivo descartan los headers
    -- una regresión en el reenvío del bearer daría 401 contra un Moodle real
    sin que ningún test lo note. Se verifica explícitamente que el header
    llegue al POST de registro."""
    issuer = "https://moodle.reg-token"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    recibido = {}

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        recibido["headers"] = kw.get("headers")
        return _resp("POST", url, 201, {
            "client_id": "cid-reg-token",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "registration_token": "el-secreto-de-moodle",
            "enc": enc,
        },
    )
    assert r.status_code == 200, r.text
    assert recibido["headers"]["Authorization"] == "Bearer el-secreto-de-moodle"


# ── Important 2: la página de "listo" tiene que poder vivir en un iframe ─────


@pytest.mark.asyncio
async def test_dynamic_registration_es_frameable(monkeypatch, lti_on, db_session):
    """`main.py` manda `X-Frame-Options: DENY` en todas las respuestas por
    default (`setdefault`). Si Moodle encapsula el paso final del asistente en
    un iframe (en vez de abrir un popup), el navegador bloquearía el frame
    entero, el branch `window.parent.postMessage(...)` de `_DONE_HTML` nunca
    correría, y el asistente se quedaría esperando el
    `org.imsglobal.lti.close` que ya no va a llegar -- con el registro ya
    persistido del lado de Moodle. Esta respuesta puntual tiene que pisar el
    default global, mismo tratamiento que nginx le da a `/lti-select`."""
    issuer = "https://moodle.frameable"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {
            "client_id": "cid-frameable",
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "1"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 200
    # Vacío (no ausente): así queda "ya presente" para el `setdefault` de
    # `main.py`, que entonces no lo pisa con DENY (ver el comentario en
    # `dynamic_registration`).
    assert r.headers.get("x-frame-options") == ""
    assert r.headers.get("content-security-policy") == "frame-ancestors *"


# ── Important 3: sin deployment_id la fila queda inerte -- fallar, no persistir


@pytest.mark.asyncio
async def test_dynamic_registration_sin_deployment_id_no_crea_plataforma(
    monkeypatch, lti_on, db_session
):
    """Sin `deployment_id`, `validate_launch` compara contra una lista vacía
    y rechaza TODOS los lanzamientos -- guardar la fila igual dejaría una
    plataforma "registrada con éxito" pero inerte para siempre. Moodle sí
    manda `deployment_id`; esto protege contra un LMS no-Moodle que no lo
    haga."""
    issuer = "https://moodle.sin-deployment"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        # Respuesta de registro sin `lti-tool-configuration` -> sin deployment_id.
        return _resp("POST", url, 201, {"client_id": "cid-sin-deployment"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert "deployment_id" in r.json()["detail"]
    assert await _no_hay_plataforma(db_session, issuer)


# ── Important 4: respuestas hostiles/no conformes de la plataforma ───────────


@pytest.mark.asyncio
async def test_dynamic_registration_conf_sin_campo_obligatorio_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.conf-incompleta"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamadas_post = []

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        del conf["authorization_endpoint"]
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamadas_post.append(url)
        return _resp("POST", url, 201, {"client_id": "no-deberia-registrarse"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert "authorization_endpoint" in r.json()["detail"]
    assert not llamadas_post
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_conf_no_json_da_502(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.conf-no-json"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return httpx.Response(200, content=b"esto no es json", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_conf_endpoint_devuelve_error_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.conf-error"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 500, {"error": "server_error"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_conf_fetch_de_red_da_502(monkeypatch, lti_on, db_session):
    issuer = "https://moodle.conf-caida"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        raise httpx.ConnectError("conexión rechazada", request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_platform_rechaza_el_registro_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.registro-rechazado"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 400, {"error": "invalid_client_metadata"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_respuesta_de_registro_sin_client_id_da_502(
    monkeypatch, lti_on, db_session
):
    issuer = "https://moodle.sin-client-id"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, _fake_conf(issuer))

    async def fake_post(self, url, **kw):
        return _resp("POST", url, 201, {"algo_que_no_es_client_id": True})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 502
    assert "client_id" in r.json()["detail"]
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_dynamic_registration_reintento_actualiza_la_fila_existente(
    monkeypatch, lti_on, db_session
):
    """El caso que el docstring de `dynamic_registration` nombra explícitamente
    como soportado por no exigir un `enc` de un solo uso: el admin recarga el
    paso final del asistente, o reintenta un registro que ya había completado
    contra el LMS. El segundo commit choca contra `uq_lti_platform_issuer_client`
    -- en vez de un 500 (con el registro contra el LMS ya exitoso en ese
    punto), la fila existente se actualiza."""
    issuer = "https://moodle.reintento"
    await _limpiar_previa(db_session, issuer)
    admin = new_client()
    register(admin)
    _, enc = _mint(admin)
    llamada = {"n": 0}

    async def fake_get(self, url, **kw):
        conf = _fake_conf(issuer)
        if llamada["n"] >= 1:
            # La segunda vuelta trae un jwks_uri distinto -- si el código
            # sólo tragara el IntegrityError sin actualizar, este valor
            # nunca llegaría a la fila.
            conf["jwks_uri"] = f"{issuer}/mod/lti/certs-v2.php"
        return _resp("GET", url, 200, conf)

    async def fake_post(self, url, **kw):
        llamada["n"] += 1
        return _resp("POST", url, 201, {
            "client_id": "cid-reintento",  # mismo client_id las dos veces
            "https://purl.imsglobal.org/spec/lti-tool-configuration": {"deployment_id": "9"},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    client = TestClient(app)
    params = {"openid_configuration": f"{issuer}/mod/lti/openid-configuration.php", "enc": enc}
    r1 = client.get("/lti/register", params=params)
    assert r1.status_code == 200, r1.text

    r2 = client.get("/lti/register", params=params)
    assert r2.status_code == 200, r2.text  # no un 500

    async with db_session() as session:
        filas = (
            await session.scalars(select(LtiPlatform).where(LtiPlatform.issuer == issuer))
        ).all()
        assert len(filas) == 1  # no duplicó la fila
        assert filas[0].jwks_url == f"{issuer}/mod/lti/certs-v2.php"  # y la actualizó
