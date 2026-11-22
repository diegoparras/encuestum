"""Privacidad de la organización: retención por defecto y derechos de cada
persona (ver qué hay de un email, exportarlo, borrarlo o anonimizarlo).

Sólo administradores. Todo queda en la auditoría."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import privacy
from app.audit import record_event
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import ROLE_ADMIN, ROLE_RANK

router = APIRouter(prefix="/privacy", tags=["privacy"])


def _require_admin(ctx: OrgContext) -> None:
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Requiere rol admin")


class RetentionIn(BaseModel):
    retention_days: Optional[int] = Field(default=None, ge=0)
    retention_action: Optional[str] = None


@router.get("/settings")
async def get_privacy_settings(ctx: OrgContext = Depends(current_context)):
    return {"retention_days": ctx.org.retention_days, "retention_action": ctx.org.retention_action}


@router.put("/settings")
async def set_privacy_settings(
    payload: RetentionIn, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)
):
    _require_admin(ctx)
    try:
        d, a = privacy.clean_retention(payload.retention_days, payload.retention_action)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    antes = {"retention_days": ctx.org.retention_days, "retention_action": ctx.org.retention_action}
    ctx.org.retention_days, ctx.org.retention_action = d, a
    session.add(ctx.org)
    record_event(session, action="privacy.retention_changed", org_id=ctx.org.id, actor=ctx.user,
                 detail={"before": antes, "after": {"retention_days": d, "retention_action": a}})
    await session.commit()
    return {"retention_days": d, "retention_action": a}


@router.get("/person")
async def find_person(
    email: EmailStr = Query(...), ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)
):
    """Qué tiene la organización de esta persona, por encuesta."""
    _require_admin(ctx)
    found = await privacy.find_person(session, ctx.org.id, str(email))
    return privacy.summarize_found(found)


@router.get("/person/export")
async def export_person(
    email: EmailStr = Query(...), ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)
):
    """Todo lo de la persona en un JSON (derecho de acceso y portabilidad)."""
    _require_admin(ctx)
    found = await privacy.find_person(session, ctx.org.id, str(email))
    data = privacy.person_export(found)
    record_event(session, action="person.exported", org_id=ctx.org.id, actor=ctx.user,
                 detail={"email_hash": privacy._email_hash(found["email"]), "responses": len(found["responses"])})
    await session.commit()
    nombre = found["email"].replace("@", "_at_")
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="datos-{nombre}.json"'},
    )


class EraseIn(BaseModel):
    email: EmailStr
    # delete: borra respuestas; anonymize: les quita la identidad (siguen en
    # las estadísticas).
    mode: str = Field(default="delete", pattern="^(delete|anonymize)$")
    # Se escribe el email de nuevo: es irreversible.
    confirm: str


@router.post("/person/erase")
async def erase_person(
    payload: EraseIn, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)
):
    _require_admin(ctx)
    email = str(payload.email).strip().lower()
    if payload.confirm.strip().lower() != email:
        raise HTTPException(status_code=422, detail="Para confirmar, escribí el email de nuevo.")
    found = await privacy.find_person(session, ctx.org.id, email)
    return await privacy.person_erase(session, found, mode=payload.mode, actor=ctx.user, org_id=ctx.org.id)
