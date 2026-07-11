"""Presigned uploads for respondent files (e.g. video answers) + the local
backend's token-signed PUT receiver. With s3/R2 the browser PUTs straight to the
bucket, so respondent videos never pass through the app server."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db import get_session
from app.models import Survey
from app.ratelimit import rate_limit
from app.routers.files import VIEW_TOKEN_TTL_MINUTES
from app.security import create_purpose_token, read_purpose_token
from app.storage import get_storage

router = APIRouter(tags=["uploads"])


def _viewable_url(public_url: str, key: str) -> str:
    """responses/* served same-origin is access-gated (routers/files.py); append
    a short-lived signed token so the UPLOADER's own preview works without a
    session. Panel viewers authenticate with their session cookie instead."""
    if not public_url.startswith("/assets/responses/"):
        return public_url  # CDN/public-bucket mode or non-gated prefix
    token = create_purpose_token("asset-view", {"key": key}, ttl_minutes=VIEW_TOKEN_TTL_MINUTES)
    return f"{public_url}?t={token}"

# What respondents may upload (video answers, plus image/audio just in case).
_RESP_TYPES = {
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/ogg": ".ogv",
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/webm": ".weba", "audio/mp4": ".m4a",
}


class UploadUrlRequest(BaseModel):
    content_type: str
    size: int | None = None


class UploadUrlOut(BaseModel):
    method: str
    upload_url: str
    headers: dict
    public_url: str
    max_mb: float


@router.post("/survey/public/{slug}/upload-url", response_model=UploadUrlOut)
async def response_upload_url(
    slug: str,
    payload: UploadUrlRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Public: hand a respondent a presigned URL to upload a file (e.g. a video
    answer) straight to storage. Rate-limited and size/type-capped."""
    await rate_limit(request, "resp-upload", limit=40, window_s=300)
    s = get_settings()
    survey = await session.scalar(select(Survey).where(Survey.slug == slug))
    if not survey or survey.status != "published":
        raise HTTPException(status_code=404, detail="Encuesta no disponible")

    ct = (payload.content_type or "").lower().split(";")[0].strip()
    ext = _RESP_TYPES.get(ct)
    if not ext:
        raise HTTPException(status_code=415, detail=f"Tipo de archivo no soportado: {ct or 'desconocido'}")
    max_mb = s.asset_max_video_mb if ct.startswith("video") else (
        s.asset_max_audio_mb if ct.startswith("audio") else s.asset_max_image_mb
    )
    if payload.size and payload.size > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"El archivo supera el máximo de {max_mb:g} MB")

    key = f"responses/{survey.id}/{uuid.uuid4().hex}{ext}"
    target = await run_in_threadpool(get_storage().presign_upload, key, ct)
    return UploadUrlOut(
        method=target.method, upload_url=target.url, headers=target.headers,
        public_url=_viewable_url(target.public_url, key), max_mb=max_mb,
    )


@router.put("/uploads/local")
async def local_put(request: Request, token: str):
    """Receiver for the LOCAL backend's presigned PUT. Only accepts a key that we
    signed ourselves, so it can't be used to write arbitrary paths."""
    data = read_purpose_token("upload", token)
    if not data or "key" not in data:
        raise HTTPException(status_code=400, detail="Token inválido o vencido")
    body = await request.body()
    s = get_settings()
    if len(body) > (s.asset_max_video_mb + 5) * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Archivo demasiado grande")
    ct = data.get("ct", "application/octet-stream")
    await run_in_threadpool(get_storage().save_bytes, data["key"], body, ct)
    url = get_storage().public_url(data["key"])
    return {"ok": True, "public_url": _viewable_url(url, data["key"])}
