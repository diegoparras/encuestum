"""JWKS del tool: se publica una clave RSA usable y estable entre llamadas."""

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_jwks_404_cuando_lti_esta_apagado(monkeypatch):
    # conftest no enciende LTI, así que el default vale: apagado.
    r = client.get("/lti/jwks.json")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_jwks_publica_una_clave_rsa(lti_on):
    r = client.get("/lti/jwks.json")
    assert r.status_code == 200
    keys = r.json()["keys"]
    assert len(keys) == 1
    k = keys[0]
    assert k["kty"] == "RSA"
    assert k["alg"] == "RS256"
    assert k["use"] == "sig"
    assert k["kid"]
    assert k["n"] and k["e"]


@pytest.mark.asyncio
async def test_la_clave_es_estable_entre_llamadas(lti_on):
    a = client.get("/lti/jwks.json").json()["keys"][0]
    b = client.get("/lti/jwks.json").json()["keys"][0]
    assert a["kid"] == b["kid"]
    assert a["n"] == b["n"]


@pytest.mark.asyncio
async def test_se_puede_verificar_un_jwt_firmado_por_el_tool(lti_on, db_session):
    from app.lti.keys import get_tool_key, sign

    async with db_session() as session:
        key = await get_tool_key(session)
    token = sign({"iss": "encuestum", "sub": "x"}, key)

    jwks = client.get("/lti/jwks.json").json()
    from jwt.algorithms import RSAAlgorithm

    public_key = RSAAlgorithm.from_jwk(jwks["keys"][0])
    claims = jwt.decode(token, public_key, algorithms=["RS256"], options={"verify_aud": False})
    assert claims["sub"] == "x"
