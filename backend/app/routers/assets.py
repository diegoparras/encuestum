"""Media library: upload/list/delete images and audio, scoped to the org.

Files live under ENCUESTUM_ASSET_DIR/{org_id}/{uuid}.{ext} and are served
publicly (respondents need them) via the /assets static mount.
"""

import os
import uuid
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Asset

router = APIRouter(prefix="/assets", tags=["assets"])

# SVG is intentionally excluded: served same-origin it's a stored-XSS vector
# (SVGs can carry scripts that run on direct navigation).
_IMAGE_TYPES = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/avif": ".avif",
}
_AUDIO_TYPES = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/ogg": ".ogg",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".weba",
    "audio/mp4": ".m4a", "audio/aac": ".aac",
}
_VIDEO_TYPES = {
    "video/mp4": ".mp4", "video/webm": ".webm", "video/ogg": ".ogv",
    "video/quicktime": ".mov",
}


class AssetOut(BaseModel):
    id: uuid.UUID
    kind: str
    url: str
    content_type: str
    size: int
    original_name: str | None
    created_at: str


def _asset_url(org_id, filename: str) -> str:
    # Relative URL — resolved against the API base by the frontend, and served
    # by nginx (/assets → backend) in the all-in-one image.
    return f"/assets/{org_id}/{filename}"


def _to_out(a: Asset) -> AssetOut:
    return AssetOut(
        id=a.id, kind=a.kind, url=_asset_url(a.org_id, a.filename),
        content_type=a.content_type, size=a.size, original_name=a.original_name,
        created_at=a.created_at.isoformat(),
    )


@router.post("", response_model=AssetOut, status_code=201)
async def upload_asset(
    file: UploadFile = File(...),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    settings = get_settings()
    ct = (file.content_type or "").lower()
    if ct in _IMAGE_TYPES:
        kind, ext, max_mb = "image", _IMAGE_TYPES[ct], settings.asset_max_image_mb
    elif ct in _AUDIO_TYPES:
        kind, ext, max_mb = "audio", _AUDIO_TYPES[ct], settings.asset_max_audio_mb
    elif ct in _VIDEO_TYPES:
        kind, ext, max_mb = "video", _VIDEO_TYPES[ct], settings.asset_max_video_mb
    else:
        raise HTTPException(status_code=415, detail=f"Tipo de archivo no soportado: {ct or 'desconocido'}")

    data = await file.read()
    if len(data) > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"El archivo supera el máximo de {max_mb:g} MB")
    if not data:
        raise HTTPException(status_code=400, detail="Archivo vacío")

    org_dir = os.path.join(settings.asset_dir, str(ctx.org.id))
    os.makedirs(org_dir, exist_ok=True)
    stored = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(org_dir, stored), "wb") as fh:
        fh.write(data)

    asset = Asset(
        org_id=ctx.org.id, kind=kind, filename=stored,
        original_name=(file.filename or None), content_type=ct, size=len(data),
        created_by=ctx.user.id,
    )
    session.add(asset)
    await session.commit()
    await session.refresh(asset)
    return _to_out(asset)


@router.get("", response_model=List[AssetOut])
async def list_assets(
    kind: str | None = None,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Asset).where(Asset.org_id == ctx.org.id).order_by(Asset.created_at.desc())
    if kind in ("image", "audio", "video"):
        stmt = stmt.where(Asset.kind == kind)
    rows = (await session.scalars(stmt)).all()
    return [_to_out(a) for a in rows]


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(
    asset_id: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    a = await session.get(Asset, asset_id)
    if not a or a.org_id != ctx.org.id:
        raise HTTPException(status_code=404, detail="Asset no encontrado")
    path = os.path.join(get_settings().asset_dir, str(a.org_id), a.filename)
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
    await session.delete(a)
    await session.commit()
