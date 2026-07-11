"""Same-origin file serving: streams stored objects (local disk or the private
S3/R2 bucket) under /assets/… so the bucket route never reaches the browser.

Access model:
- Design assets ({org_id}/{file}) are public — respondents need backgrounds,
  logos and music without a session.
- Respondent files (responses/{survey_id}/{file}) are private: only members of
  the survey's organization (or a platform super-admin) can fetch them. The
  uploader gets a short-lived signed token appended to the URL so their own
  preview works while they finish the survey.
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select
from starlette.responses import Response, StreamingResponse

from app.config import get_settings
from app.db import get_session
from app.deps import is_superadmin
from app.models import Membership, Survey, User
from app.security import read_purpose_token, read_session_token
from app.storage import FileNotFound, RangeNotSatisfiable, get_storage

LOGGER = logging.getLogger("encuestum")
router = APIRouter(tags=["files"])

# Vida del token de visualización que se le da al que SUBE el archivo (su propia
# preview mientras completa la encuesta). El panel no lo usa: entra por sesión.
VIEW_TOKEN_TTL_HOURS = 24

_CACHE_PUBLIC = "public, max-age=604800, immutable"   # design assets (uuid names)
_CACHE_PRIVATE = "private, max-age=3600"              # respondent files


def _validate_key(key: str) -> str:
    parts = key.split("/")
    if (
        not key
        or key.startswith("/")
        or "\\" in key
        or any(p in ("", ".", "..") for p in parts)
    ):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    return key


async def _gate_response_file(
    key: str, request: Request, session: AsyncSession
) -> None:
    """responses/{survey_id}/… → uploader token, org membership o super-admin."""
    token = request.query_params.get("t")
    if token:
        data = read_purpose_token("asset-view", token)
        if data and data.get("key") == key:
            return

    s = get_settings()
    raw = request.cookies.get(s.session_cookie)
    user_id = read_session_token(raw) if raw else None
    user = await session.get(User, user_id) if user_id else None
    if not user or not user.is_active:
        raise HTTPException(status_code=403, detail="Sin permiso para este archivo")
    if is_superadmin(user):
        return

    try:
        survey_id = uuid.UUID(key.split("/")[1])
    except (IndexError, ValueError):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    survey = await session.get(Survey, survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    member = await session.scalar(
        select(Membership).where(
            Membership.user_id == user.id, Membership.org_id == survey.org_id
        )
    )
    if not member:
        raise HTTPException(status_code=403, detail="Sin permiso para este archivo")


@router.get("/assets/{key:path}")
async def serve_asset(
    key: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> Response:
    key = _validate_key(key)
    is_response_file = key.startswith("responses/")
    if is_response_file:
        await _gate_response_file(key, request, session)

    try:
        obj = await run_in_threadpool(
            get_storage().open, key, request.headers.get("range")
        )
    except FileNotFound:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    except RangeNotSatisfiable as exc:
        return Response(
            status_code=416, headers={"Content-Range": f"bytes */{exc.size}"}
        )

    headers = {
        **obj.headers,
        "Accept-Ranges": "bytes",
        "Cache-Control": _CACHE_PRIVATE if is_response_file else _CACHE_PUBLIC,
    }
    return StreamingResponse(
        obj.stream, status_code=obj.status, media_type=obj.content_type,
        headers=headers,
    )
