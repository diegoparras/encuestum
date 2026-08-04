"""Deep linking: el docente elige una encuesta y el LMS recibe el content item."""

import time
import uuid

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, Survey

ISSUER = "https://moodle.dl"
CLIENT_ID = "cid-dl"
RETURN_URL = f"{ISSUER}/mod/lti/contentitem_return.php"


# Las cookies del flujo LTI van `Secure`, así que el TestClient tiene que
# hablar HTTPS o el cookiejar de httpx las descarta silenciosamente (mismo
# patrón que test_lti_launch.py).
def _client() -> TestClient:
    return TestClient(app, base_url="https://testserver")


@pytest_asyncio.fixture
async def dl_setup(monkeypatch, db_session):
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()

    async def fake_jwks(url, kid=None):
        import json

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with db_session() as session:
        from sqlmodel import select as _select

        # La base es compartida entre tests dentro de la misma sesión de
        # pytest: si un test anterior ya dejó una plataforma con este mismo
        # (issuer, client_id), hay que limpiarla antes de volver a insertar o
        # la unique constraint la rechaza (mismo patrón que test_lti_launch.py).
        previa = (
            await session.scalars(
                _select(LtiPlatform).where(
                    LtiPlatform.issuer == ISSUER, LtiPlatform.client_id == CLIENT_ID
                )
            )
        ).first()
        if previa is not None:
            await session.delete(previa)
            await session.commit()

        org_id = uuid.uuid4()
        survey = Survey(org_id=org_id, title="Quiz de prueba", status="published",
                        json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        return {"pem": pem, "platform": platform, "survey": survey}


def _dl_token(pem, nonce):
    now = int(time.time())
    return jwt.encode(
        {
            "iss": ISSUER, "aud": CLIENT_ID, "sub": "teacher-1", "exp": now + 300,
            "iat": now, "nonce": nonce,
            CLAIM["MESSAGE_TYPE"]: "LtiDeepLinkingRequest",
            CLAIM["VERSION"]: "1.3.0",
            CLAIM["DEPLOYMENT_ID"]: "1",
            CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
            CLAIM["DEEP_LINKING_SETTINGS"]: {
                "deep_link_return_url": RETURN_URL,
                "accept_types": ["ltiResourceLink"],
                "accept_presentation_document_targets": ["iframe", "window"],
                "data": "opaque-123",
            },
        },
        pem,
        algorithm="RS256",
        headers={"kid": "pk"},
    )


def _launch_deeplink(client, setup):
    from urllib.parse import parse_qs, urlparse

    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "1",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    return client.post(
        "/lti/launch",
        data={"id_token": _dl_token(setup["pem"], q["nonce"][0]), "state": q["state"][0]},
        follow_redirects=False,
    )


@pytest.mark.asyncio
async def test_deep_linking_redirige_al_selector(lti_on, dl_setup):
    client = _client()
    r = _launch_deeplink(client, dl_setup)
    assert r.status_code == 302
    assert r.headers["location"].startswith("/lti-select?dl=")


@pytest.mark.asyncio
async def test_el_selector_lista_las_encuestas_de_la_organizacion(lti_on, dl_setup):
    client = _client()
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]
    listado = client.get(f"/lti/select/surveys?dl={dl}")
    assert listado.status_code == 200
    titles = [s["title"] for s in listado.json()["surveys"]]
    assert "Quiz de prueba" in titles


@pytest.mark.asyncio
async def test_el_retorno_firma_un_content_item_verificable(lti_on, dl_setup):
    client = _client()
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]

    ret = client.post("/lti/select/return",
                      json={"dl": dl, "survey_id": str(dl_setup["survey"].id)})
    assert ret.status_code == 200
    body = ret.json()
    assert body["action"] == RETURN_URL

    jwks = client.get("/lti/jwks.json").json()
    public_key = RSAAlgorithm.from_jwk(jwks["keys"][0])
    claims = jwt.decode(body["jwt"], public_key, algorithms=["RS256"], audience=ISSUER)
    assert claims[CLAIM["MESSAGE_TYPE"]] == "LtiDeepLinkingResponse"
    assert claims[CLAIM["DL_DATA"]] == "opaque-123"
    items = claims[CLAIM["DL_CONTENT_ITEMS"]]
    assert len(items) == 1
    assert items[0]["type"] == "ltiResourceLink"
    assert items[0]["title"] == "Quiz de prueba"
    assert str(dl_setup["survey"].id) in items[0]["custom"]["survey_id"]


@pytest.mark.asyncio
async def test_el_retorno_rechaza_una_encuesta_de_otra_organizacion(lti_on, dl_setup, db_session):
    client = _client()
    async with db_session() as session:
        ajena = Survey(org_id=uuid.uuid4(), title="Ajena", status="published", json_schema={})
        session.add(ajena)
        await session.commit()
        ajena_id = ajena.id

    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]
    ret = client.post("/lti/select/return", json={"dl": dl, "survey_id": str(ajena_id)})
    assert ret.status_code == 404
