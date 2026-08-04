"""Registro de plataformas: alta manual y Dynamic Registration."""

import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.main import app
from app.models import LtiPlatform

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


@pytest.mark.asyncio
async def test_dynamic_registration_da_de_alta_la_plataforma(monkeypatch, lti_on, db_session):
    await _limpiar_previa(db_session, ISSUER)
    org_id = uuid.uuid4()

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {
            "issuer": ISSUER,
            "authorization_endpoint": f"{ISSUER}/mod/lti/auth.php",
            "token_endpoint": f"{ISSUER}/mod/lti/token.php",
            "jwks_uri": f"{ISSUER}/mod/lti/certs.php",
            "registration_endpoint": f"{ISSUER}/mod/lti/openid-registration.php",
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
            "org_id": str(org_id),
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
        assert p.org_id == org_id
        assert p.auth_token_url == f"{ISSUER}/mod/lti/token.php"


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
    org_id = uuid.uuid4()
    enviado = {}

    async def fake_get(self, url, **kw):
        return _resp("GET", url, 200, {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/mod/lti/auth.php",
            "token_endpoint": f"{issuer}/mod/lti/token.php",
            "jwks_uri": f"{issuer}/mod/lti/certs.php",
            "registration_endpoint": f"{issuer}/mod/lti/openid-registration.php",
        })

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
            "org_id": str(org_id),
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
    from urllib.parse import urlparse
    assert tool_config["domain"] == urlparse(public_base).netloc
