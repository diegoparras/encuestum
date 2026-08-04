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


def _fake_conf(issuer: str) -> dict:
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/mod/lti/auth.php",
        "token_endpoint": f"{issuer}/mod/lti/token.php",
        "jwks_uri": f"{issuer}/mod/lti/certs.php",
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
        return _resp("POST", url, 201, {"client_id": "cid-2"})

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


@pytest.mark.asyncio
async def test_register_sin_enc_da_403_y_no_crea_plataforma(lti_on, db_session):
    issuer = "https://moodle.sin-enc"
    await _limpiar_previa(db_session, issuer)
    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={"openid_configuration": f"{issuer}/mod/lti/openid-configuration.php"},
    )
    assert r.status_code == 403
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_malformado_da_403_y_no_crea_plataforma(lti_on, db_session):
    issuer = "https://moodle.enc-malformado"
    await _limpiar_previa(db_session, issuer)
    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": "esto-no-es-un-jwt",
        },
    )
    assert r.status_code == 403
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_vencido_da_403_y_no_crea_plataforma(lti_on, db_session):
    issuer = "https://moodle.enc-vencido"
    await _limpiar_previa(db_session, issuer)
    enc = create_purpose_token(LTI_REGISTER_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=-1)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 403
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_enc_de_otro_proposito_da_403_y_no_crea_plataforma(lti_on, db_session):
    """Un token minteado para otra cosa (p. ej. el state OIDC) no puede
    reutilizarse acá -- el `purpose` firmado adentro tiene que matchear."""
    from app.lti.state import LTI_STATE_PURPOSE

    issuer = "https://moodle.otro-proposito"
    await _limpiar_previa(db_session, issuer)
    enc = create_purpose_token(
        LTI_STATE_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=30
    )

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 403
    assert await _no_hay_plataforma(db_session, issuer)


@pytest.mark.asyncio
async def test_register_con_org_inexistente_da_404_y_no_crea_plataforma(lti_on, db_session):
    issuer = "https://moodle.org-inexistente"
    await _limpiar_previa(db_session, issuer)
    enc = create_purpose_token(LTI_REGISTER_PURPOSE, {"org_id": str(uuid.uuid4())}, ttl_minutes=30)

    client = TestClient(app)
    r = client.get(
        "/lti/register",
        params={
            "openid_configuration": f"{issuer}/mod/lti/openid-configuration.php",
            "enc": enc,
        },
    )
    assert r.status_code == 404
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
        return _resp("POST", url, 201, {"client_id": "cid-suplantado"})

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
        return _resp("POST", url, 201, {"client_id": "cid-name-collision"})

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
