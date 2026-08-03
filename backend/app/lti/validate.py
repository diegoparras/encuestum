"""Validación del `id_token` que manda la plataforma en cada lanzamiento.

Sigue el mismo enfoque que `app/lockatus_client.py`: verificación RS256 offline
contra el JWKS de la contraparte, con caché de una hora.
"""

from __future__ import annotations

import logging
import time

import httpx
import jwt
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


async def fetch_jwks(url: str) -> list[dict]:
    """Claves públicas de la plataforma, cacheadas una hora."""
    hit = _jwks_cache.get(url)
    if hit and time.time() - hit[0] < _JWKS_TTL_S:
        return hit[1]
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url)
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _jwks_cache[url] = (time.time(), keys)
    return keys


def _key_for(keys: list[dict], kid: str | None):
    """La clave cuyo kid coincide; si el token no trae kid y hay una sola, esa."""
    if kid:
        for k in keys:
            if k.get("kid") == kid:
                return RSAAlgorithm.from_jwk(k)
        return None
    if len(keys) == 1:
        return RSAAlgorithm.from_jwk(keys[0])
    return None


async def validate_launch(
    token: str, platform: LtiPlatform, expected_nonce: str | None
) -> dict:
    """Verifica firma y claims obligatorios. Devuelve los claims o levanta."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise LtiValidationError(f"header ilegible: {exc}") from exc

    if header.get("alg") != "RS256":
        raise LtiValidationError(f"alg no permitido: {header.get('alg')!r}")

    try:
        keys = await fetch_jwks(platform.jwks_url)
    except Exception as exc:  # noqa: BLE001 — la red puede fallar de mil formas
        raise LtiValidationError(f"no se pudo leer el JWKS: {exc}") from exc

    key = _key_for(keys, header.get("kid"))
    if key is None:
        raise LtiValidationError("ninguna clave del JWKS coincide con el kid del token")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=platform.client_id,
            issuer=platform.issuer,
            options={"require": ["iss", "aud", "sub", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        raise LtiValidationError(f"token inválido: {exc}") from exc

    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise LtiValidationError("nonce no coincide")

    if claims.get(CLAIM["VERSION"]) != "1.3.0":
        raise LtiValidationError(f"versión LTI no soportada: {claims.get(CLAIM['VERSION'])!r}")

    deployment_id = claims.get(CLAIM["DEPLOYMENT_ID"])
    if deployment_id not in (platform.deployment_ids or []):
        raise LtiValidationError(f"deployment_id desconocido: {deployment_id!r}")

    message_type = claims.get(CLAIM["MESSAGE_TYPE"])
    if message_type not in (MESSAGE_RESOURCE_LINK, MESSAGE_DEEP_LINKING):
        raise LtiValidationError(f"message_type no soportado: {message_type!r}")

    return claims
