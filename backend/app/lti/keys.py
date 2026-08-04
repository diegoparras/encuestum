"""Par de claves RSA del tool.

El tool firma dos cosas: la respuesta de deep linking y el `client_assertion` con
el que pide el token de AGS. La clave puede venir por entorno (`LTI_PRIVATE_KEY`)
o generarse al primer uso y guardarse en la base, para que sobreviva reinicios.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.models import LtiKey


@dataclass(frozen=True)
class ToolKey:
    kid: str
    private_pem: str
    public_pem: str


def _public_pem(private_key) -> str:
    """PEM `SubjectPublicKeyInfo` de la clave pública derivada de `private_key`."""
    return (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )


def _generate() -> tuple[str, str]:
    """Devuelve (private_pem, public_pem) de un par RSA 2048 nuevo."""
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return private_pem, _public_pem(private)


async def get_tool_key(session: AsyncSession) -> ToolKey:
    """La clave del tool. Si `LTI_PRIVATE_KEY` está definida, manda esa; si no,
    se lee de la base y se crea la primera vez."""
    s = get_settings()
    if s.lti_private_key:
        private = serialization.load_pem_private_key(
            s.lti_private_key.encode(), password=None
        )
        return ToolKey(
            kid=s.lti_key_id, private_pem=s.lti_private_key, public_pem=_public_pem(private)
        )

    row = (await session.scalars(select(LtiKey).where(LtiKey.kid == s.lti_key_id))).first()
    if row is None:
        private_pem, public_pem = _generate()
        row = LtiKey(kid=s.lti_key_id, private_pem=private_pem, public_pem=public_pem)
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            # Dos requests llegaron antes de que existiera la fila: ambas vieron
            # `row is None`, generaron su propia clave y quisieron insertarla.
            # La que llega acá perdió la carrera -- la otra ya insertó y su
            # commit chocó contra el unique constraint de `kid`. Deshacemos
            # nuestro intento y releemos la fila que efectivamente quedó
            # persistida, para que ambos llamantes terminen usando la misma
            # clave. Si ni así aparece, no es la carrera benigna que esperamos
            # -- dejamos que el error se propague en vez de devolver una clave
            # nueva sin persistir: dos claves distintas en circulación
            # romperían la verificación de firmas de un modo mucho más difícil
            # de diagnosticar que un 500 puntual.
            await session.rollback()
            row = (await session.scalars(select(LtiKey).where(LtiKey.kid == s.lti_key_id))).first()
            if row is None:
                raise
    return ToolKey(kid=row.kid, private_pem=row.private_pem, public_pem=row.public_pem)


def _b64u(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def public_jwk(key: ToolKey) -> dict:
    """El JWK público, en la forma que espera la plataforma."""
    public = serialization.load_pem_public_key(key.public_pem.encode())
    numbers = public.public_numbers()
    return {
        "kty": "RSA",
        "alg": "RS256",
        "use": "sig",
        "kid": key.kid,
        "n": _b64u(numbers.n),
        "e": _b64u(numbers.e),
    }


def sign(payload: dict, key: ToolKey) -> str:
    """Firma un JWT RS256 poniendo el `kid` en el header, que es como la
    plataforma sabe con cuál de nuestras claves verificar."""
    return jwt.encode(payload, key.private_pem, algorithm="RS256", headers={"kid": key.kid})
