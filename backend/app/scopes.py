"""Alcance de cada miembro dentro de la organización.

* **Rol lector** (`viewer`): ve encuestas, respuestas y resultados; no puede
  crear, editar, publicar, corregir ni borrar nada.
* **Alcance por carpetas** (`Membership.folder_scope`): un miembro o lector
  limitado a ciertas carpetas (y sus subcarpetas) sólo ve las encuestas que
  están ahí. Dueños y administradores ven todo siempre.

Se aplica en un solo lugar: una dependencia (`guard`) en los routers del panel
que trabajan sobre encuestas. Así ningún endpoint nuevo queda afuera por
olvido; la lista de encuestas y la de carpetas filtran con `allowed_folders`.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import ROLE_ADMIN, ROLE_RANK, ROLE_VIEWER, Survey, SurveyFolder

_READ_METHODS = {"GET", "HEAD", "OPTIONS"}


def is_admin(ctx: OrgContext) -> bool:
    return ROLE_RANK.get(ctx.role, 0) >= ROLE_RANK[ROLE_ADMIN]


async def allowed_folders(session: AsyncSession, ctx: OrgContext) -> Optional[set[uuid.UUID]]:
    """Las carpetas visibles para esta persona, o None si ve toda la organización."""
    scope = ctx.membership.folder_scope
    if is_admin(ctx) or scope is None:
        return None
    raices = set()
    for x in scope:
        try:
            raices.add(uuid.UUID(str(x)))
        except ValueError:
            continue
    carpetas = (await session.scalars(select(SurveyFolder).where(SurveyFolder.org_id == ctx.org.id))).all()
    hijos: dict = {}
    for f in carpetas:
        hijos.setdefault(f.parent_id, []).append(f.id)
    visibles, pila = set(), [r for r in raices if any(f.id == r for f in carpetas)]
    while pila:
        f = pila.pop()
        if f in visibles:
            continue
        visibles.add(f)
        pila.extend(hijos.get(f, []))
    return visibles


def can_see(survey: Survey, allowed: Optional[set[uuid.UUID]]) -> bool:
    return allowed is None or (survey.folder_id is not None and survey.folder_id in allowed)


async def guard(request: Request, ctx: OrgContext = Depends(current_context),
                session: AsyncSession = Depends(get_session)) -> None:
    """Dependencia de router: lector = sólo lectura; alcance por carpetas en
    toda ruta con `{sid}`."""
    # Un lector puede comentar (es justamente quien revisa), nada más.
    comenta = "/comments" in request.url.path
    if ctx.role == ROLE_VIEWER and request.method not in _READ_METHODS and not comenta:
        raise HTTPException(status_code=403, detail="Tu rol es de lectura: no podés hacer cambios.")
    sid = request.path_params.get("sid")
    if sid is None:
        return
    allowed = await allowed_folders(session, ctx)
    if allowed is None:
        return
    try:
        s = await session.get(Survey, uuid.UUID(str(sid)))
    except ValueError:
        return
    if s is not None and s.org_id == ctx.org.id and not can_see(s, allowed):
        # 404 y no 403: no se confirma que la encuesta exista.
        raise HTTPException(status_code=404, detail="Encuesta no encontrada")


def clean_scope(raw, folder_ids: set[uuid.UUID]) -> Optional[list[str]]:
    """None = toda la organización; una lista = esas carpetas (deben existir)."""
    if raw is None:
        return None
    out = []
    for x in raw:
        try:
            u = uuid.UUID(str(x))
        except ValueError:
            raise ValueError(f"Carpeta inválida: {x}")
        if u not in folder_ids:
            raise ValueError("Alguna de las carpetas no existe en la organización.")
        if str(u) not in out:
            out.append(str(u))
    return out
