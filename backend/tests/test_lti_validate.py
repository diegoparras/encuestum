"""Validación del id_token: firma, claims obligatorios, deployment y nonce."""

import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.lti.validate import CLAIM, LtiValidationError, validate_launch
from app.models import LtiPlatform

ISSUER = "https://moodle.localhost"
CLIENT_ID = "abc123"


@pytest.fixture
def platform_key():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return pem


@pytest.fixture
def platform():
    return LtiPlatform(
        id=uuid.uuid4(),
        issuer=ISSUER,
        client_id=CLIENT_ID,
        deployment_ids=["1"],
        auth_login_url=f"{ISSUER}/mod/lti/auth.php",
        auth_token_url=f"{ISSUER}/mod/lti/token.php",
        jwks_url=f"{ISSUER}/mod/lti/certs.php",
    )


def _launch_claims(**over):
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "moodle-user-42",
        "exp": now + 300,
        "iat": now,
        "nonce": "n-1",
        CLAIM["MESSAGE_TYPE"]: "LtiResourceLinkRequest",
        CLAIM["VERSION"]: "1.3.0",
        CLAIM["DEPLOYMENT_ID"]: "1",
        CLAIM["TARGET_LINK_URI"]: "https://encuestum.localhost/lti/launch",
        CLAIM["RESOURCE_LINK"]: {"id": "rl-7"},
        CLAIM["ROLES"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    }
    claims.update(over)
    return claims


def _sign(claims, pem):
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": "platform-key"})


def _patch_jwks(monkeypatch, pem):
    """Sustituye la descarga del JWKS por la clave pública local."""
    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()

    async def fake(url):
        from jwt.algorithms import RSAAlgorithm
        import json

        return [json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": "platform-key"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake)


@pytest.mark.asyncio
async def test_launch_valido_devuelve_los_claims(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(), platform_key)
    claims = await validate_launch(token, platform, expected_nonce="n-1")
    assert claims["sub"] == "moodle-user-42"
    assert claims[CLAIM["RESOURCE_LINK"]]["id"] == "rl-7"


@pytest.mark.asyncio
async def test_rechaza_firma_de_otra_clave(monkeypatch, platform_key, platform):
    otra = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(), otra)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_nonce_distinto(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(nonce="otro"), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_deployment_desconocido(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(**{CLAIM["DEPLOYMENT_ID"]: "99"}), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_version_incorrecta(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(**{CLAIM["VERSION"]: "1.1.0"}), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_token_vencido(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    now = int(time.time())
    token = _sign(_launch_claims(exp=now - 10, iat=now - 400), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_alg_none(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = jwt.encode(_launch_claims(), key="", algorithm="none")
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")
