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
JWKS_URL = f"{ISSUER}/mod/lti/certs.php"


@pytest.fixture(autouse=True)
def _limpia_cache_jwks():
    """La caché de `fetch_jwks` es un dict a nivel de módulo — sin esto, el
    orden de ejecución de los tests que sí golpean la caché real (los de
    `fetch_jwks` mismo) contaminaría a los demás."""
    import app.lti.validate as validate_module

    validate_module._jwks_cache.clear()
    yield
    validate_module._jwks_cache.clear()


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


def _rsa_jwk(pem, kid="platform-key"):
    from jwt.algorithms import RSAAlgorithm
    import json

    public = serialization.load_pem_private_key(pem.encode(), password=None).public_key()
    return json.loads(RSAAlgorithm.to_jwk(public)) | {"kid": kid}


def _patch_jwks(monkeypatch, pem, extra_keys=None):
    """Sustituye la descarga del JWKS por la clave pública local.

    `extra_keys`, si se pasa, se antepone a la clave RSA válida — así se
    puede simular un JWKS que mezcla entradas inservibles (otro `kty`, JSON
    incompleto, etc.) junto a la clave real.
    """
    keys = [*(extra_keys or []), _rsa_jwk(pem)]

    async def fake(url, kid=None):
        return keys

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake)


class _FakeJwksResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _fake_http_client(monkeypatch, bodies):
    """Sustituye `httpx.AsyncClient` por una cola de respuestas JSON para el
    JWKS. Cada `.get()` consume el siguiente cuerpo de la cola; agotada la
    cola, repite el último. Devuelve la lista de URLs pedidas (una por
    llamada real a la red), para poder afirmar cuántas veces se golpeó."""
    import httpx

    calls: list[str] = []

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            calls.append(url)
            idx = min(len(calls) - 1, len(bodies) - 1)
            return _FakeJwksResponse(bodies[idx])

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    return calls


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
async def test_rechaza_nonce_esperado_ausente(monkeypatch, platform_key, platform):
    """Si no hay nonce esperado (p. ej. la cookie de estado vino vencida o no
    llegó), el lanzamiento debe fallar cerrado, no aceptarse sin comprobar
    nada — `expected_nonce=None` no es "no verificar", es "rechazar"."""
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce=None)


@pytest.mark.asyncio
async def test_rechaza_token_sin_claim_nonce(monkeypatch, platform_key, platform):
    """El claim `nonce` es obligatorio en el propio token, no solo comparado."""
    _patch_jwks(monkeypatch, platform_key)
    claims = _launch_claims()
    del claims["nonce"]
    token = _sign(claims, platform_key)
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
async def test_rechaza_alg_none(monkeypatch, platform):
    """El chequeo de `alg` en el header debe rechazar antes de tocar la red.

    Un token `alg: none` no trae `kid`, así que si este chequeo no existiera
    `_key_for` caería en el atajo de "una sola clave en el JWKS" y sería
    `jwt.decode(..., algorithms=["RS256"])` quien terminara rechazándolo por
    su cuenta — el test pasaría igual sin que este módulo hiciera nada. Para
    que el test pruebe la protección de *este* módulo (y no un efecto
    colateral de PyJWT), afirmamos el mensaje propio del chequeo y que
    `fetch_jwks` jamás se llamó — o sea, que el rechazo ocurre antes de
    cualquier I/O de red.
    """
    llamadas = []

    async def _fetch_jwks_no_deberia_llamarse(url, *a, **k):
        llamadas.append(url)
        return []

    monkeypatch.setattr("app.lti.validate.fetch_jwks", _fetch_jwks_no_deberia_llamarse)

    token = jwt.encode(_launch_claims(), key="", algorithm="none")
    with pytest.raises(LtiValidationError, match="alg no permitido"):
        await validate_launch(token, platform, expected_nonce="n-1")

    assert llamadas == []


@pytest.mark.asyncio
async def test_rechaza_iss_incorrecto(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(iss="https://otra-plataforma.example"), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_aud_incorrecto(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(aud="otro-client-id"), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_kid_desconocido(monkeypatch, platform_key, platform):
    """El token trae un `kid` que no está en el JWKS de la plataforma."""
    _patch_jwks(monkeypatch, platform_key)
    token = jwt.encode(
        _launch_claims(), platform_key, algorithm="RS256", headers={"kid": "kid-que-no-existe"}
    )
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_kid_ausente_con_varias_claves_en_jwks(monkeypatch, platform_key, platform):
    """Sin `kid` en el token, el atajo de "una sola clave" no aplica si el
    JWKS tiene más de una — no hay forma segura de adivinar cuál usar."""
    otra_pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    _patch_jwks(monkeypatch, platform_key, extra_keys=[_rsa_jwk(otra_pem, kid="otra-clave")])
    token = jwt.encode(_launch_claims(), platform_key, algorithm="RS256")  # sin kid
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_rechaza_message_type_no_soportado(monkeypatch, platform_key, platform):
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(**{CLAIM["MESSAGE_TYPE"]: "LtiOtraCosaRequest"}), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


@pytest.mark.asyncio
async def test_jwks_con_clave_no_rsa_junto_a_la_valida(monkeypatch, platform_key, platform):
    """El JWKS puede mezclar tipos de clave (p. ej. durante una rotación).
    Una entrada EC (u otra inservible) no debe tumbar la resolución de la
    clave RSA correcta — la búsqueda debe saltarla y seguir."""
    entrada_ec = {
        "kty": "EC",
        "kid": "platform-key",
        "crv": "P-256",
        "x": "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4",
        "y": "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM",
    }
    _patch_jwks(monkeypatch, platform_key, extra_keys=[entrada_ec])
    token = _sign(_launch_claims(), platform_key)
    claims = await validate_launch(token, platform, expected_nonce="n-1")
    assert claims["sub"] == "moodle-user-42"


@pytest.mark.asyncio
async def test_jwks_con_entrada_malformada_no_crashea(monkeypatch, platform_key, platform):
    """Una entrada del JWKS que ni siquiera es un dict (body malformado de la
    plataforma) no debe tumbar la búsqueda con un AttributeError — debe
    saltarse y seguir mirando el resto."""
    _patch_jwks(monkeypatch, platform_key, extra_keys=["esto-no-es-un-jwk", 123, None])
    token = _sign(_launch_claims(), platform_key)
    claims = await validate_launch(token, platform, expected_nonce="n-1")
    assert claims["sub"] == "moodle-user-42"


@pytest.mark.asyncio
async def test_jwks_con_clave_rsa_malformada_junto_a_la_valida(monkeypatch, platform_key, platform):
    """Una entrada RSA malformada (n/e no decodificables en base64url) que
    comparte kid con la clave válida y aparece ANTES de ella en el JWKS no
    debe tumbar la búsqueda con un binascii.Error de PyJWT escapando del
    módulo — debe saltarse esa entrada y seguir hasta la utilizable.

    El orden importa: si el catch solo mira `InvalidKeyError` (que PyJWT no
    levanta para esta forma en particular), el `binascii.Error` se propaga y
    ni siquiera se llega a mirar la clave válida que sigue en la lista.
    """
    entrada_rsa_malformada = {"kty": "RSA", "kid": "platform-key", "n": "x", "e": "AQAB"}
    _patch_jwks(monkeypatch, platform_key, extra_keys=[entrada_rsa_malformada])
    token = _sign(_launch_claims(), platform_key)
    claims = await validate_launch(token, platform, expected_nonce="n-1")
    assert claims["sub"] == "moodle-user-42"


@pytest.mark.asyncio
async def test_rechaza_nonce_esperado_vacio(monkeypatch, platform_key, platform):
    """`expected_nonce=""` (p. ej. una cookie de estado que decodificó a
    vacío) no debe aceptarse solo porque el claim `nonce` del token también
    sea `""` — comparar dos cadenas vacías "iguales" no es verificar nada, y
    deja el lanzamiento sin protección anti-replay real."""
    _patch_jwks(monkeypatch, platform_key)
    token = _sign(_launch_claims(nonce=""), platform_key)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="")


@pytest.mark.asyncio
async def test_rechaza_si_la_unica_clave_con_ese_kid_es_inservible(monkeypatch, platform):
    """Si el kid del token solo matchea una entrada y esa entrada no sirve
    (otro `kty`, JSON incompleto), el rechazo debe ser un LtiValidationError
    limpio — no un InvalidKeyError de PyJWT escapando del módulo."""

    async def fake(url, kid=None):
        return [{"kty": "EC", "kid": "platform-key", "crv": "P-256"}]

    monkeypatch.setattr("app.lti.validate.fetch_jwks", fake)

    otra_pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    token = _sign(_launch_claims(), otra_pem)
    with pytest.raises(LtiValidationError):
        await validate_launch(token, platform, expected_nonce="n-1")


# ---------------------------------------------------------------------------
# fetch_jwks: caché de una hora, sin caché negativa, refetch ante kid nuevo.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_jwks_cachea_dentro_del_ttl(monkeypatch, platform_key):
    from app.lti.validate import fetch_jwks

    jwk = _rsa_jwk(platform_key)
    calls = _fake_http_client(monkeypatch, [{"keys": [jwk]}])

    primero = await fetch_jwks(JWKS_URL)
    segundo = await fetch_jwks(JWKS_URL)

    assert primero == [jwk]
    assert segundo == [jwk]
    # la segunda vino de la caché — no debe haber una segunda llamada de red
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_fetch_jwks_no_cachea_resultado_vacio(monkeypatch, platform_key):
    """Un JWKS que responde sin `keys` (o vacío) no debe quedar cacheado una
    hora — eso dejaría todos los lanzamientos rechazados hasta que expire."""
    from app.lti.validate import fetch_jwks

    jwk = _rsa_jwk(platform_key)
    calls = _fake_http_client(monkeypatch, [{"keys": []}, {"keys": [jwk]}])

    vacio = await fetch_jwks(JWKS_URL)
    assert vacio == []

    luego = await fetch_jwks(JWKS_URL)
    assert luego == [jwk]
    # si el vacío se hubiera cacheado, esta segunda llamada no habría tocado
    # la red y `luego` seguiría siendo []
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_fetch_jwks_kid_desconocido_reintenta_una_vez(monkeypatch, platform_key):
    """Tras una rotación de claves en la plataforma, un `kid` que no está en
    la caché vigente debe disparar un único refetch (bypaseando la caché),
    no quedarse pegado al JWKS viejo hasta que expire la hora — y tampoco
    debe loopear si el kid sigue sin aparecer."""
    from app.lti.validate import fetch_jwks

    vieja = {"kty": "RSA", "kid": "vieja", "n": "x", "e": "AQAB"}
    nueva = _rsa_jwk(platform_key, kid="nueva")
    calls = _fake_http_client(monkeypatch, [{"keys": [vieja]}, {"keys": [nueva]}])

    primero = await fetch_jwks(JWKS_URL)
    assert primero == [vieja]
    assert len(calls) == 1

    # "nueva" no está en la caché vigente -> un refetch, sin caché, la trae
    segundo = await fetch_jwks(JWKS_URL, "nueva")
    assert segundo == [nueva]
    assert len(calls) == 2

    # ahora "nueva" SÍ está en caché -> no debe volver a golpear la red
    tercero = await fetch_jwks(JWKS_URL, "nueva")
    assert tercero == [nueva]
    assert len(calls) == 2

    # un kid que sigue sin existir tras el refetch cuesta UNA llamada más,
    # nunca un loop
    await fetch_jwks(JWKS_URL, "fantasma")
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_fetch_jwks_devuelve_copia(monkeypatch, platform_key):
    """El caller no debe poder corromper la caché mutando la lista devuelta."""
    from app.lti.validate import fetch_jwks

    jwk = _rsa_jwk(platform_key)
    _fake_http_client(monkeypatch, [{"keys": [jwk]}])

    primero = await fetch_jwks(JWKS_URL)
    primero.append({"kty": "RSA", "kid": "inyectada"})

    segundo = await fetch_jwks(JWKS_URL)
    assert segundo == [jwk]


@pytest.mark.asyncio
async def test_fetch_jwks_body_malformado_no_crashea(monkeypatch):
    """`keys` que no es una lista (JWKS de la plataforma roto) no debe tumbar
    la lectura con un AttributeError — debe tratarse como "sin claves"."""
    from app.lti.validate import fetch_jwks

    _fake_http_client(monkeypatch, [{"keys": "no-es-una-lista"}])
    keys = await fetch_jwks(JWKS_URL)
    assert keys == []
