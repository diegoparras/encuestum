"""Validación del `id_token` que manda la plataforma en cada lanzamiento.

Sigue el mismo enfoque que `app/lockatus_client.py`: verificación RS256 offline
contra el JWKS de la contraparte, con caché de una hora.
"""

from __future__ import annotations

import copy
import logging
import time

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from jwt.algorithms import RSAAlgorithm

from app.models import LtiPlatform

LOGGER = logging.getLogger(__name__)

_BASE = "https://purl.imsglobal.org/spec/lti/claim/"
_DL = "https://purl.imsglobal.org/spec/lti-dl/claim/"

CLAIM = {
    "MESSAGE_TYPE": _BASE + "message_type",
    "VERSION": _BASE + "version",
    "DEPLOYMENT_ID": _BASE + "deployment_id",
    "TARGET_LINK_URI": _BASE + "target_link_uri",
    "RESOURCE_LINK": _BASE + "resource_link",
    "CONTEXT": _BASE + "context",
    "ROLES": _BASE + "roles",
    "LAUNCH_PRESENTATION": _BASE + "launch_presentation",
    "CUSTOM": _BASE + "custom",
    "AGS": "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
    "DEEP_LINKING_SETTINGS": _DL + "deep_linking_settings",
    "DL_CONTENT_ITEMS": _DL + "content_items",
    "DL_DATA": _DL + "data",
}

MESSAGE_RESOURCE_LINK = "LtiResourceLinkRequest"
MESSAGE_DEEP_LINKING = "LtiDeepLinkingRequest"

_JWKS_TTL_S = 3600
_jwks_cache: dict[str, tuple[float, list[dict]]] = {}


class LtiValidationError(Exception):
    """El lanzamiento no es de fiar. Nunca exponer el detalle al navegador."""


async def fetch_jwks(url: str, kid: str | None = None) -> list[dict]:
    """Claves públicas de la plataforma, cacheadas una hora.

    Si se pide un `kid` concreto y no aparece en la caché vigente, se
    refresca una vez sin caché antes de rendirse: así una rotación de claves
    en la plataforma no deja los lanzamientos rotos hasta que expire la hora.
    Solo un refetch — nunca un loop, o un `kid` inventado se convierte en una
    forma de machacar a la plataforma a pedidos.
    """
    hit = _jwks_cache.get(url)
    if hit and time.time() - hit[0] < _JWKS_TTL_S:
        cached = hit[1]
        if kid is None or any(k.get("kid") == kid for k in cached if isinstance(k, dict)):
            return copy.deepcopy(cached)

    keys = await _fetch_jwks_uncached(url)
    if keys:
        # Nunca cachear un resultado vacío: un JWKS temporalmente roto o sin
        # `keys` no debe dejar todos los lanzamientos rechazados una hora.
        _jwks_cache[url] = (time.time(), keys)
    return copy.deepcopy(keys)


async def _fetch_jwks_uncached(url: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
    resp.raise_for_status()
    body = resp.json()
    keys = body.get("keys", []) if isinstance(body, dict) else []
    if not isinstance(keys, list):
        return []
    return keys


def _key_for(keys: list[dict], kid: str | None) -> RSAPublicKey | None:
    """La clave cuyo kid coincide; si el token no trae kid y hay una sola, esa.

    Un JWKS legítimamente mezcla tipos de clave (rotaciones, distintos usos
    para el mismo `kid`), y una entrada puede venir malformada de maneras muy
    distintas: PyJWT solo levanta `InvalidKeyError` para algunas (otro `kty`,
    RSA sin `n`/`e`); para RSA con `n`/`e` presentes pero no decodificables
    puede levantar `binascii.Error`, `TypeError` o `ValueError` sin envolver
    nada. Da igual el motivo — una entrada que no se puede convertir en clave
    es inservible, y ninguna debe abortar la búsqueda: se salta y se sigue
    mirando el resto.
    """
    usable = [k for k in keys if isinstance(k, dict)]
    if kid:
        candidates = [k for k in usable if k.get("kid") == kid]
    elif len(usable) == 1:
        candidates = usable
    else:
        candidates = []

    for k in candidates:
        try:
            return RSAAlgorithm.from_jwk(k)
        except Exception:  # noqa: BLE001 — cualquier entrada rota se salta, no solo InvalidKeyError
            LOGGER.debug("entrada de JWKS inservible, se salta (kid=%r)", k.get("kid"))
            continue
    return None


async def validate_launch(
    token: str, platform: LtiPlatform, expected_nonce: str | None
) -> dict:
    """Verifica firma y claims obligatorios. Devuelve los claims o levanta."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        LOGGER.warning("lanzamiento LTI rechazado: header ilegible (%s)", exc)
        raise LtiValidationError(f"header ilegible: {exc}") from exc

    if header.get("alg") != "RS256":
        LOGGER.warning("lanzamiento LTI rechazado: alg no permitido (%r)", header.get("alg"))
        raise LtiValidationError(f"alg no permitido: {header.get('alg')!r}")

    kid = header.get("kid")
    try:
        keys = await fetch_jwks(platform.jwks_url, kid)
    except Exception as exc:  # noqa: BLE001 — la red puede fallar de mil formas
        LOGGER.warning("lanzamiento LTI rechazado: no se pudo leer el JWKS (%s)", exc)
        raise LtiValidationError(f"no se pudo leer el JWKS: {exc}") from exc

    key = _key_for(keys, kid)
    if key is None:
        LOGGER.warning("lanzamiento LTI rechazado: ninguna clave del JWKS coincide con el kid")
        raise LtiValidationError("ninguna clave del JWKS coincide con el kid del token")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=platform.client_id,
            issuer=platform.issuer,
            options={"require": ["iss", "aud", "sub", "exp", "iat", "nonce"]},
        )
    except jwt.PyJWTError as exc:
        LOGGER.warning("lanzamiento LTI rechazado: token inválido (%s)", exc)
        raise LtiValidationError(f"token inválido: {exc}") from exc

    # Sin nonce esperado no hay nada que comparar — y "nada que comparar" no
    # es "aceptar sin verificar". El llamador (Task 4) lo saca de una cookie de
    # estado firmada; si esa cookie falta o venció, debe fallar cerrado, no
    # convertirse silenciosamente en un lanzamiento sin protección anti-replay.
    # `not expected_nonce` cubre toda la clase falsy (None y "" incluidos): una
    # cookie que decodificó a cadena vacía no debe poder "coincidir" con un
    # token cuyo claim `nonce` también sea "".
    if not expected_nonce or claims.get("nonce") != expected_nonce:
        LOGGER.warning("lanzamiento LTI rechazado: nonce no coincide")
        raise LtiValidationError("nonce no coincide")

    if claims.get(CLAIM["VERSION"]) != "1.3.0":
        LOGGER.warning(
            "lanzamiento LTI rechazado: versión no soportada (%r)", claims.get(CLAIM["VERSION"])
        )
        raise LtiValidationError(f"versión LTI no soportada: {claims.get(CLAIM['VERSION'])!r}")

    deployment_id = claims.get(CLAIM["DEPLOYMENT_ID"])
    if deployment_id not in (platform.deployment_ids or []):
        LOGGER.warning("lanzamiento LTI rechazado: deployment_id desconocido (%r)", deployment_id)
        raise LtiValidationError(f"deployment_id desconocido: {deployment_id!r}")

    message_type = claims.get(CLAIM["MESSAGE_TYPE"])
    if message_type not in (MESSAGE_RESOURCE_LINK, MESSAGE_DEEP_LINKING):
        LOGGER.warning("lanzamiento LTI rechazado: message_type no soportado (%r)", message_type)
        raise LtiValidationError(f"message_type no soportado: {message_type!r}")

    return claims
