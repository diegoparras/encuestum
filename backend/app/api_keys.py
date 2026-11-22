"""Claves de la API pública (`/api/v1/ext`).

Formato: `enc_<prefijo>_<secreto>`. Se guarda el SHA-256 de la clave entera y
el prefijo (para reconocerla en el panel); la clave completa se muestra una
sola vez. Se manda en `Authorization: Bearer <clave>` o en `X-Api-Key`."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.models import ApiKey, Organization

SCOPES = ("read", "write")
_TOUCH_EVERY = timedelta(minutes=5)


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def generate() -> tuple[str, str, str]:
    """(clave, prefijo, hash)."""
    prefijo = secrets.token_hex(4)
    clave = f"enc_{prefijo}_{secrets.token_urlsafe(32)}"
    return clave, prefijo, _hash(clave)


@dataclass
class ApiContext:
    org: Organization
    key: ApiKey

    def require_write(self) -> None:
        if self.key.scope != "write":
            raise HTTPException(status_code=403, detail="Esta clave es de sólo lectura.")


def _from_request(request: Request) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-api-key") or "").strip()


async def api_context(request: Request, session: AsyncSession = Depends(get_session)) -> ApiContext:
    from app.ratelimit import rate_limit

    clave = _from_request(request)
    if not clave.startswith("enc_"):
        raise HTTPException(status_code=401, detail="Falta la clave de API (Authorization: Bearer enc_…).",
                            headers={"WWW-Authenticate": "Bearer"})
    h = _hash(clave)
    k = (await session.scalars(select(ApiKey).where(ApiKey.key_hash == h))).first()
    if k is None or k.revoked_at is not None or not hmac.compare_digest(k.key_hash, h):
        raise HTTPException(status_code=401, detail="Clave de API inválida o revocada.",
                            headers={"WWW-Authenticate": "Bearer"})
    # Límite por clave (no por IP: una integración suele salir de una sola).
    await rate_limit(request, f"apikey:{k.id}", limit=120, window_s=60)
    org = await session.get(Organization, k.org_id)
    if org is None:
        raise HTTPException(status_code=401, detail="Clave de API inválida.")
    ahora = datetime.now(timezone.utc)
    ultimo = k.last_used_at
    if ultimo is not None and ultimo.tzinfo is None:
        ultimo = ultimo.replace(tzinfo=timezone.utc)
    if ultimo is None or ahora - ultimo > _TOUCH_EVERY:
        k.last_used_at = ahora
        session.add(k)
        await session.commit()
    return ApiContext(org=org, key=k)


def view(k: ApiKey) -> dict:
    return {
        "id": str(k.id), "name": k.name, "prefix": f"enc_{k.prefix}_…", "scope": k.scope,
        "created_at": k.created_at.isoformat() if k.created_at else None,
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
        "revoked_at": k.revoked_at.isoformat() if k.revoked_at else None,
    }
