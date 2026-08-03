"""Flujo de lanzamiento: login init, launch, y acceso a la encuesta sin PIN."""

import time
import uuid
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.lti.validate import CLAIM
from app.main import app
from app.models import LtiPlatform, LtiResourceLink, Survey

ISSUER = "https://moodle.test"
CLIENT_ID = "cid-1"


@pytest.fixture
def platform_pem():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


@pytest_asyncio.fixture
async def registered(platform_pem, monkeypatch, db_session):
    """Deja en la base una plataforma, una encuesta con PIN y su resource link."""
    public = serialization.load_pem_private_key(platform_pem.encode(), password=None).public_key()

    async def fake_jwks(url, kid=None):
        import json

        from jwt.algorithms import RSAAlgorithm

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "pk"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake_jwks)

    async with db_session() as session:
        from sqlmodel import select as _select

        # La base es compartida entre tests dentro de la misma sesión de
        # pytest: si un test anterior ya dejó una plataforma con este mismo
        # (issuer, client_id), hay que limpiarla antes de volver a insertar
        # o la unique constraint la rechaza.
        previa = (
            await session.scalars(
                _select(LtiPlatform).where(
                    LtiPlatform.issuer == ISSUER, LtiPlatform.client_id == CLIENT_ID
                )
            )
        ).first()
        if previa is not None:
            viejos_links = (
                await session.scalars(
                    _select(LtiResourceLink).where(LtiResourceLink.platform_id == previa.id)
                )
            ).all()
            for viejo in viejos_links:
                await session.delete(viejo)
            await session.delete(previa)
            await session.commit()

        org_id = uuid.uuid4()
        survey = Survey(org_id=org_id, title="Examen", status="published", access_mode="pin",
                        access_pin="1234", json_schema={"pages": []})
        session.add(survey)
        platform = LtiPlatform(
            issuer=ISSUER, client_id=CLIENT_ID, deployment_ids=["1"],
            auth_login_url=f"{ISSUER}/mod/lti/auth.php",
            auth_token_url=f"{ISSUER}/mod/lti/token.php",
            jwks_url=f"{ISSUER}/mod/lti/certs.php", org_id=org_id,
        )
        session.add(platform)
        await session.commit()
        link = LtiResourceLink(platform_id=platform.id, resource_link_id="rl-1",
                               context_id="course-9", survey_id=survey.id)
        session.add(link)
        await session.commit()
        return {"platform": platform, "survey": survey, "link": link, "pem": platform_pem}


def _id_token(pem, nonce, **over):
    now = int(time.time())
    claims = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "u-42", "exp": now + 300, "iat": now,
        "nonce": nonce, "email": "alumno@escuela.test", "name": "Ana Alumna",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.test/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": "rl-1"},
        CLAIM["CONTEXT"]: {"id": "course-9", "title": "Historia"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }
    claims.update(over)
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "pk"})


@pytest.mark.asyncio
async def test_login_redirige_al_authorize_de_la_plataforma(lti_on, registered):
    client = TestClient(app)
    r = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["response_type"] == ["id_token"]
    assert q["response_mode"] == ["form_post"]
    assert q["scope"] == ["openid"]
    assert q["client_id"] == [CLIENT_ID]
    assert q["login_hint"] == ["42"]
    assert q["state"] and q["nonce"]
    assert "enc_lti_state" in r.cookies


@pytest.mark.asyncio
async def test_launch_valido_redirige_a_la_encuesta_y_siembra_la_cookie(lti_on, registered):
    client = TestClient(app)
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post(
        "/lti/launch",
        data={"id_token": token, "state": q["state"][0]},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == f"/s/{registered['survey'].slug}"
    assert "enc_lti" in r.cookies


@pytest.mark.asyncio
async def test_launch_con_state_ajeno_es_rechazado(lti_on, registered):
    client = TestClient(app)
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])

    r = client.post("/lti/launch", data={"id_token": token, "state": "otro-state"},
                    follow_redirects=False)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_la_cookie_lti_saltea_el_pin_de_la_encuesta(lti_on, registered):
    client = TestClient(app)
    slug = registered["survey"].slug

    # Sin cookie LTI, la encuesta con PIN no entrega su contenido: viene gated.
    sin = TestClient(app).get(f"/api/v1/survey/public/{slug}")
    assert sin.json()["gated"] is True

    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)

    # Con la cookie puesta, se puede enviar sin access_token.
    r = client.post(f"/api/v1/survey/public/{slug}/submit",
                    json={"answers": {"q1": "hola"}, "completed": True})
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_la_respuesta_queda_atribuida_al_alumno(lti_on, registered, db_session):
    from sqlmodel import select

    from app.models import SurveyResponse

    client = TestClient(app)
    slug = registered["survey"].slug
    login = client.post(
        "/lti/login",
        data={"iss": ISSUER, "client_id": CLIENT_ID, "login_hint": "42",
              "target_link_uri": "https://encuestum.test/lti/launch"},
        follow_redirects=False,
    )
    q = parse_qs(urlparse(login.headers["location"]).query)
    token = _id_token(registered["pem"], nonce=q["nonce"][0])
    client.post("/lti/launch", data={"id_token": token, "state": q["state"][0]},
                follow_redirects=False)
    client.post(f"/api/v1/survey/public/{slug}/submit",
                json={"answers": {"q1": "hola"}, "completed": True})

    async with db_session() as session:
        r = (await session.scalars(
            select(SurveyResponse).where(SurveyResponse.survey_id == registered["survey"].id)
        )).first()
        assert r.lti_sub == "u-42"
        assert r.lti_link_id == registered["link"].id
        assert r.respondent_email == "alumno@escuela.test"
