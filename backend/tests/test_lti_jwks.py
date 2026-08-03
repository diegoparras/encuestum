"""JWKS del tool: se publica una clave RSA usable y estable entre llamadas."""

import uuid

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

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


@pytest.mark.asyncio
async def test_get_tool_key_sobrevive_a_una_carrera_de_insercion(lti_on, db_session, monkeypatch):
    """Dos requests concurrentes llegan con la tabla `lti_keys` vacía (para ese
    `kid`): ambas ven `row is None`, generan su propia clave e intentan
    insertarla. Una gana la carrera e inserta primero; el commit de la otra
    choca con la unique constraint de `kid` -> IntegrityError. `get_tool_key`
    tiene que recuperarse (rollback + releer) y devolver la clave que
    efectivamente quedó persistida en la tabla -- si devolviera la suya propia
    (sin persistir), habría dos claves distintas en circulación y la
    verificación de firmas del otro caller se rompería."""
    from sqlalchemy.exc import IntegrityError

    from app.config import get_settings
    from app.lti.keys import _generate, get_tool_key
    from app.models import LtiKey

    # `lti_keys` es compartida entre tests (mismo sqlite para toda la sesión),
    # así que usamos un kid propio para no pisar ni depender de otros tests.
    monkeypatch.setenv("LTI_KEY_ID", f"race-test-{uuid.uuid4().hex}")
    get_settings.cache_clear()
    settings = get_settings()

    # La clave que "gana" la carrera y ya está persistida cuando nuestro
    # propio commit se ejecuta.
    winning_private_pem, winning_public_pem = _generate()

    async with db_session() as session:
        real_commit = session.commit
        state = {"first_call": True}

        async def fake_commit():
            if state["first_call"]:
                state["first_call"] = False
                # Soltamos nuestra transacción antes de que la "otra request"
                # inserte y confirme, para no pelear por locks de sqlite --
                # esto simula el resultado de la carrera de forma
                # determinística, sin necesidad de concurrencia real.
                await session.rollback()
                async with db_session() as other:
                    other.add(
                        LtiKey(
                            kid=settings.lti_key_id,
                            private_pem=winning_private_pem,
                            public_pem=winning_public_pem,
                        )
                    )
                    await other.commit()
                raise IntegrityError(
                    "insert", {}, Exception("UNIQUE constraint failed: lti_keys.kid")
                )
            await real_commit()

        monkeypatch.setattr(session, "commit", fake_commit)

        key = await get_tool_key(session)

    # El caller que "perdió" la carrera termina con la MISMA clave que ganó,
    # no con la suya propia (nunca persistida).
    assert key.kid == settings.lti_key_id
    assert key.private_pem == winning_private_pem
    assert key.public_pem == winning_public_pem

    # Y sólo hay una fila para ese kid -- no dos claves en circulación.
    async with db_session() as session:
        rows = (
            await session.scalars(select(LtiKey).where(LtiKey.kid == settings.lti_key_id))
        ).all()
    assert len(rows) == 1
