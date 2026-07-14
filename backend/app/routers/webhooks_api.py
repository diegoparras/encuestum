"""Manage webhooks for an organization (admin+). Each new response is POSTed to
the active webhooks (see app/webhooks.py)."""

import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import current_user
from app.models import Membership, Survey, Webhook, ROLE_ADMIN, ROLE_RANK, User
from app.webhooks import post_webhook

router = APIRouter(prefix="/orgs/{org_id}/webhooks", tags=["webhooks"])


class WebhookCreate(BaseModel):
    url: str
    survey_id: Optional[uuid.UUID] = None

    @field_validator("url")
    @classmethod
    def _http(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("La URL debe empezar con http:// o https://")
        return v


class WebhookOut(BaseModel):
    id: uuid.UUID
    url: str
    survey_id: Optional[uuid.UUID]
    active: bool
    secret: str
    created_at: datetime


async def _require_admin(session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID) -> Membership:
    m = (
        await session.scalars(
            select(Membership).where(Membership.user_id == user_id, Membership.org_id == org_id)
        )
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="No sos miembro de esa organización")
    if ROLE_RANK.get(m.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Requiere rol admin o superior")
    return m


def _out(w: Webhook) -> WebhookOut:
    return WebhookOut(
        id=w.id, url=w.url, survey_id=w.survey_id, active=w.active,
        secret=w.secret, created_at=w.created_at,
    )


@router.get("", response_model=List[WebhookOut])
async def list_webhooks(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _require_admin(session, user.id, org_id)
    rows = (
        await session.scalars(
            select(Webhook).where(Webhook.org_id == org_id).order_by(Webhook.created_at.desc())
        )
    ).all()
    return [_out(w) for w in rows]


@router.post("", response_model=WebhookOut, status_code=201)
async def create_webhook(
    org_id: uuid.UUID,
    payload: WebhookCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _require_admin(session, user.id, org_id)
    # SSRF guard: rechazar URLs hacia direcciones internas / metadata.
    from app.net_guard import assert_public_url, UnsafeUrlError
    try:
        assert_public_url(payload.url)
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if payload.survey_id:
        s = await session.get(Survey, payload.survey_id)
        if not s or s.org_id != org_id or s.deleted_at is not None:
            raise HTTPException(status_code=404, detail="Encuesta no encontrada")
    w = Webhook(org_id=org_id, url=payload.url, survey_id=payload.survey_id, created_by=user.id)
    session.add(w)
    await session.commit()
    await session.refresh(w)
    return _out(w)


@router.delete("/{webhook_id}", status_code=204)
async def delete_webhook(
    org_id: uuid.UUID,
    webhook_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _require_admin(session, user.id, org_id)
    w = await session.get(Webhook, webhook_id)
    if not w or w.org_id != org_id:
        raise HTTPException(status_code=404, detail="Webhook no encontrado")
    await session.delete(w)
    await session.commit()


@router.post("/{webhook_id}/test")
async def test_webhook(
    org_id: uuid.UUID,
    webhook_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _require_admin(session, user.id, org_id)
    w = await session.get(Webhook, webhook_id)
    if not w or w.org_id != org_id:
        raise HTTPException(status_code=404, detail="Webhook no encontrado")
    sample = {
        "event": "ping",
        "survey": {"id": "demo", "slug": "demo", "title": "Encuesta de prueba"},
        "response": {"id": "demo", "answers": {"pregunta": "respuesta de ejemplo"}},
    }
    ok = await post_webhook(w.url, w.secret, sample, event="ping")
    return {"ok": ok}
