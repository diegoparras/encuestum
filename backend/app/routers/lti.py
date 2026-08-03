"""Endpoints LTI 1.3. Todo el router vive detrás de LTI_ENABLED."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.lti.keys import get_tool_key, public_jwk

LOGGER = logging.getLogger(__name__)
router = APIRouter(prefix="/lti", tags=["lti"])


def require_lti() -> None:
    """Con LTI apagado, la superficie entera no existe: 404, no 403, para no
    revelar que el endpoint está ahí."""
    if not get_settings().lti_enabled:
        raise HTTPException(status_code=404, detail="Not Found")


@router.get("/jwks.json", dependencies=[Depends(require_lti)])
async def jwks(session: AsyncSession = Depends(get_session)) -> dict:
    """Claves públicas del tool, para que la plataforma verifique lo que firmamos."""
    key = await get_tool_key(session)
    return {"keys": [public_jwk(key)]}
