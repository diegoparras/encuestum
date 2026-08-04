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

from app.lti.state import LTI_STATE_COOKIE
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
async def test_borrado_de_cookie_de_state_en_deep_linking_lleva_samesite_none_y_secure(
    lti_on, dl_setup
):
    """El redirect a /lti-select también es un form-POST cross-site (Moodle
    posteando el id_token al iframe de /lti/launch): si el borrado de
    enc_lti_state no lleva los mismos atributos con los que se la escribió
    (SameSite=None; Secure), el navegador ignora el Set-Cookie y la cookie de
    state sobrevive. Como no hay ningún store de nonces server-side, ese
    borrado es la única defensa contra reusar el mismo (state, nonce) para
    volver a pedir un content item durante toda la ventana de STATE_TTL_S."""
    client = _client()
    r = _launch_deeplink(client, dl_setup)
    borrado = [c for c in r.headers.get_list("set-cookie") if c.startswith(f"{LTI_STATE_COOKIE}=")]
    assert borrado, "la respuesta de deep linking debe borrar la cookie de state"
    header = borrado[0].lower()
    assert "samesite=none" in header
    assert "secure" in header


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
async def test_el_selector_no_lista_encuestas_de_otra_organizacion(lti_on, dl_setup, db_session):
    """El listado tiene que filtrar por `Survey.org_id == platform.org_id`:
    sin ese filtro, este test seguiría en verde igual que
    test_el_selector_lista_las_encuestas_de_la_organizacion (que sólo mira
    que la propia esté presente, nunca que una ajena esté ausente)."""
    async with db_session() as session:
        ajena = Survey(org_id=uuid.uuid4(), title="Encuesta Ajena", status="published",
                       json_schema={"pages": []})
        session.add(ajena)
        await session.commit()

    client = _client()
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]
    listado = client.get(f"/lti/select/surveys?dl={dl}")
    assert listado.status_code == 200
    titles = [s["title"] for s in listado.json()["surveys"]]
    assert "Encuesta Ajena" not in titles


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
async def test_el_content_item_usa_la_url_publica_de_launch(lti_on, dl_setup):
    """`items[0]["url"]` tiene que salir de `public_base_url`, no de
    `request.url_for("launch")`: detrás del nginx de este despliegue el
    scheme interno da http://, y Moodle rechaza un content item con una URL
    de lanzamiento que no sea https. Este test sólo mira `url`: los otros
    campos (type, title, custom.survey_id) ya los cubre
    test_el_retorno_firma_un_content_item_verificable, pero ninguno de esos
    hubiera detectado una regresión a request.url_for."""
    from app.config import get_settings

    client = _client()
    r = _launch_deeplink(client, dl_setup)
    dl = r.headers["location"].split("dl=", 1)[1]

    ret = client.post("/lti/select/return",
                      json={"dl": dl, "survey_id": str(dl_setup["survey"].id)})
    assert ret.status_code == 200
    body = ret.json()

    jwks = client.get("/lti/jwks.json").json()
    public_key = RSAAlgorithm.from_jwk(jwks["keys"][0])
    claims = jwt.decode(body["jwt"], public_key, algorithms=["RS256"], audience=ISSUER)
    items = claims[CLAIM["DL_CONTENT_ITEMS"]]
    assert items[0]["url"] == f"{get_settings().public_base_url}/lti/launch"


@pytest.mark.asyncio
async def test_dl_con_platform_id_invalido_da_400(lti_on, dl_setup):
    """Un `platform_id` corrupto dentro del token de deep linking (dato viejo
    o manipulado) tiene que dar el mismo 400 que cualquier otra sesión de
    deep linking inválida, no un 500 — mismo contrato que
    test_launch_con_platform_id_invalido_en_cookie_da_400 en
    test_lti_launch.py."""
    from app.lti.deeplink import DL_PURPOSE
    from app.lti.state import STATE_TTL_S
    from app.security import create_purpose_token

    dl = create_purpose_token(
        DL_PURPOSE,
        {"platform_id": "no-es-un-uuid", "deployment_id": "1", "settings": {}},
        ttl_minutes=STATE_TTL_S / 60,
    )
    client = _client()
    r = client.get(f"/lti/select/surveys?dl={dl}")
    assert r.status_code == 400


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
