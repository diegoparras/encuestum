"""Carpetas de encuestas: crear, renombrar, recolorear, mover y borrar.

Dos invariantes que se cuidan acá y no en la base:

* **Sin ciclos**: mover una carpeta adentro de su propia descendencia dejaría un
  árbol imposible de recorrer (y colgaría cualquier render recursivo). Se
  rechaza con 400.
* **Borrar no destruye trabajo**: al borrar una carpeta, sus encuestas y sus
  subcarpetas suben un nivel. Nadie pierde una encuesta por ordenar.
"""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import Survey, SurveyFolder

router = APIRouter(prefix="/folders", tags=["folders"])

_COLOR = r"^#[0-9a-fA-F]{6}$"


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: Optional[uuid.UUID] = None
    color: Optional[str] = Field(default=None, pattern=_COLOR)


class FolderPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    color: Optional[str] = Field(default=None, pattern=_COLOR)
    # `parent_id` se envía explícito para poder mover a la raíz (None).
    parent_id: Optional[uuid.UUID] = None
    move_to_root: bool = False


class FolderOut(BaseModel):
    id: uuid.UUID
    parent_id: Optional[uuid.UUID]
    name: str
    color: Optional[str]
    position: int
    survey_count: int = 0


async def _folder_or_404(fid: uuid.UUID, org_id: uuid.UUID, session: AsyncSession) -> SurveyFolder:
    f = await session.get(SurveyFolder, fid)
    if not f or f.org_id != org_id:
        raise HTTPException(status_code=404, detail="Carpeta no encontrada")
    return f


async def _descendientes(fid: uuid.UUID, org_id: uuid.UUID, session: AsyncSession) -> set:
    """Ids de todo el subárbol que cuelga de `fid`, sin incluirla."""
    todas = (
        await session.scalars(select(SurveyFolder).where(SurveyFolder.org_id == org_id))
    ).all()
    hijas: dict = {}
    for f in todas:
        hijas.setdefault(f.parent_id, []).append(f.id)
    out, pendientes = set(), list(hijas.get(fid, []))
    while pendientes:
        actual = pendientes.pop()
        if actual in out:
            continue
        out.add(actual)
        pendientes.extend(hijas.get(actual, []))
    return out


@router.get("", response_model=List[FolderOut])
async def list_folders(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    from sqlalchemy import func

    carpetas = (
        await session.scalars(
            select(SurveyFolder)
            .where(SurveyFolder.org_id == ctx.org.id)
            .order_by(SurveyFolder.position, SurveyFolder.name)
        )
    ).all()
    # Cuántas encuestas hay en cada carpeta (sin contar las de la papelera).
    filas = (
        await session.execute(
            select(Survey.folder_id, func.count(Survey.id))
            .where(Survey.org_id == ctx.org.id, Survey.deleted_at.is_(None))
            .group_by(Survey.folder_id)
        )
    ).all()
    conteo = {r[0]: r[1] for r in filas}
    return [
        FolderOut(
            id=f.id, parent_id=f.parent_id, name=f.name, color=f.color,
            position=f.position, survey_count=conteo.get(f.id, 0),
        )
        for f in carpetas
    ]


@router.post("", response_model=FolderOut, status_code=201)
async def create_folder(
    payload: FolderIn,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    if payload.parent_id is not None:
        await _folder_or_404(payload.parent_id, ctx.org.id, session)
    f = SurveyFolder(
        org_id=ctx.org.id,
        parent_id=payload.parent_id,
        name=payload.name.strip(),
        color=payload.color,
    )
    session.add(f)
    await session.commit()
    await session.refresh(f)
    return FolderOut(
        id=f.id, parent_id=f.parent_id, name=f.name, color=f.color, position=f.position
    )


@router.patch("/{fid}", response_model=FolderOut)
async def update_folder(
    fid: uuid.UUID,
    payload: FolderPatch,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    f = await _folder_or_404(fid, ctx.org.id, session)
    if payload.name is not None:
        f.name = payload.name.strip()
    if payload.color is not None:
        f.color = payload.color

    if payload.move_to_root:
        f.parent_id = None
    elif payload.parent_id is not None:
        if payload.parent_id == fid:
            raise HTTPException(status_code=400, detail="Una carpeta no puede contenerse a sí misma")
        await _folder_or_404(payload.parent_id, ctx.org.id, session)
        # Meterla dentro de su propia descendencia dejaría un ciclo.
        if payload.parent_id in await _descendientes(fid, ctx.org.id, session):
            raise HTTPException(
                status_code=400,
                detail="No se puede mover una carpeta dentro de una de sus subcarpetas",
            )
        f.parent_id = payload.parent_id

    session.add(f)
    await session.commit()
    await session.refresh(f)
    return FolderOut(
        id=f.id, parent_id=f.parent_id, name=f.name, color=f.color, position=f.position
    )


@router.delete("/{fid}", status_code=204)
async def delete_folder(
    fid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Borra la carpeta. Sus encuestas y subcarpetas suben un nivel: ordenar no
    puede costar trabajo perdido."""
    f = await _folder_or_404(fid, ctx.org.id, session)
    padre = f.parent_id

    hijas = (
        await session.scalars(
            select(SurveyFolder).where(
                SurveyFolder.org_id == ctx.org.id, SurveyFolder.parent_id == fid
            )
        )
    ).all()
    for h in hijas:
        h.parent_id = padre
        session.add(h)

    dentro = (
        await session.scalars(
            select(Survey).where(Survey.org_id == ctx.org.id, Survey.folder_id == fid)
        )
    ).all()
    for s in dentro:
        s.folder_id = padre
        session.add(s)

    await session.delete(f)
    await session.commit()


class MoveSurveysRequest(BaseModel):
    survey_ids: List[uuid.UUID]
    folder_id: Optional[uuid.UUID] = None


@router.post("/move-surveys")
async def move_surveys(
    payload: MoveSurveysRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """Mueve encuestas a una carpeta (o a la raíz con folder_id nulo)."""
    if payload.folder_id is not None:
        await _folder_or_404(payload.folder_id, ctx.org.id, session)
    if not payload.survey_ids:
        return {"moved": 0}
    encuestas = (
        await session.scalars(
            select(Survey).where(
                Survey.org_id == ctx.org.id, Survey.id.in_(payload.survey_ids)
            )
        )
    ).all()
    for s in encuestas:
        s.folder_id = payload.folder_id
        session.add(s)
    await session.commit()
    return {"moved": len(encuestas)}
