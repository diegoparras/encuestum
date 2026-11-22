"""SSO por organización (ver app/org_sso.py): login con el proveedor de la
organización y su configuración (sólo administradores)."""

from __future__ import annotations

import logging
import secrets
import urllib.parse
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import org_sso
from app.accounts import get_user_by_email, set_session_cookies
from app.audit import record_event
from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.models import ROLE_ADMIN, ROLE_MEMBER, ROLE_RANK, ROLE_VIEWER, Membership, Organization, OrgSso, User
from app.ratelimit import rate_limit
from app.security import hash_password

LOGGER = logging.getLogger("encuestum.org_sso")
auth_router = APIRouter(prefix="/auth/org-sso", tags=["auth"])
admin_router = APIRouter(prefix="/sso", tags=["sso"])


def _front(path: str) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}{path}"


def _safe_next(raw: Optional[str]) -> str:
    v = (raw or "").strip()
    return v if v.startswith("/") and not v.startswith("//") and not v.startswith("/\\") else "/surveys"


async def config_for_email(session: AsyncSession, email: str) -> Optional[OrgSso]:
    dominio = org_sso.email_domain(email)
    if not dominio:
        return None
    for cfg in (await session.scalars(select(OrgSso).where(OrgSso.enabled == True))).all():  # noqa: E712
        if dominio in (cfg.domains or []):
            return cfg
    return None


@auth_router.get("/lookup")
async def lookup(email: str, request: Request, session: AsyncSession = Depends(get_session)):
    """¿Este email entra por el SSO de su organización? Lo consulta el login."""
    await rate_limit(request, "sso-lookup", limit=30, window_s=60)
    cfg = await config_for_email(session, email)
    if cfg is None:
        return {"sso": False}
    org = await session.get(Organization, cfg.org_id)
    return {"sso": True, "enforce": cfg.enforce, "organization": org.name if org else None,
            "start_url": f"/api/v1/auth/org-sso/start?email={urllib.parse.quote(email.strip())}"}


@auth_router.get("/start")
async def start(request: Request, email: Optional[str] = None, org: Optional[str] = None,
                next: Optional[str] = None, session: AsyncSession = Depends(get_session)):
    await rate_limit(request, "sso-start", limit=30, window_s=60)
    cfg = None
    if email:
        cfg = await config_for_email(session, email)
    elif org:
        o = (await session.scalars(select(Organization).where(Organization.slug == org))).first()
        if o:
            cfg = (await session.scalars(select(OrgSso).where(OrgSso.org_id == o.id, OrgSso.enabled == True))).first()  # noqa: E712
    if cfg is None:
        return RedirectResponse(_front("/login?sso_error=not_configured"), status_code=302)
    try:
        url, txn = await org_sso.authorize_url(cfg, next_path=_safe_next(next), login_hint=email)
    except org_sso.SsoError as exc:
        LOGGER.warning("SSO de la org %s: %s", cfg.org_id, exc)
        return RedirectResponse(_front(f"/login?sso_error={exc.code}"), status_code=302)
    s = get_settings()
    resp = RedirectResponse(url, status_code=302)
    # SameSite=Lax: la vuelta del proveedor es una navegación de nivel superior.
    resp.set_cookie(org_sso.TXN_COOKIE, txn, max_age=600, httponly=True, secure=s.cookie_secure,
                    samesite="lax", path="/")
    return resp


@auth_router.get("/callback")
async def callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                   error: Optional[str] = None, session: AsyncSession = Depends(get_session)):
    def volver(err: str):
        r = RedirectResponse(_front(f"/login?sso_error={urllib.parse.quote(err)}"), status_code=302)
        r.delete_cookie(org_sso.TXN_COOKIE, path="/")
        return r

    if error:
        return volver(error[:40])
    txn = org_sso.read_txn(request.cookies.get(org_sso.TXN_COOKIE))
    if not code or not txn or txn.get("s") != state:
        return volver("state")
    cfg = (await session.scalars(select(OrgSso).where(OrgSso.org_id == uuid.UUID(txn["o"])))).first()
    if cfg is None or not cfg.enabled:
        return volver("not_configured")
    try:
        claims = await org_sso.finish(cfg, code=code, txn=txn)
    except org_sso.SsoError as exc:
        LOGGER.warning("SSO de la org %s: %s", cfg.org_id, exc)
        return volver(exc.code)

    email = claims["email"].strip().lower()
    user = await get_user_by_email(session, email)
    if user is None:
        user = User(email=email, name=claims.get("name") or claims.get("given_name") or None,
                    password_hash=hash_password(secrets.token_urlsafe(32)), email_verified=True)
        session.add(user)
        await session.flush()
    elif not user.is_active:
        return volver("disabled")
    m = (await session.scalars(select(Membership).where(
        Membership.user_id == user.id, Membership.org_id == cfg.org_id))).first()
    if m is None:
        if not cfg.auto_provision:
            await session.rollback()
            return volver("no_access")
        rol = cfg.default_role if cfg.default_role in (ROLE_MEMBER, ROLE_VIEWER) else ROLE_MEMBER
        session.add(Membership(user_id=user.id, org_id=cfg.org_id, role=rol))
        record_event(session, action="member.provisioned", org_id=cfg.org_id, actor=user,
                     detail={"via": "sso", "role": rol})
    record_event(session, action="auth.sso_login", org_id=cfg.org_id, actor=user, detail={"issuer": cfg.issuer})
    await session.commit()
    resp = RedirectResponse(_front(_safe_next(txn.get("r"))), status_code=302)
    set_session_cookies(resp, user.id, cfg.org_id)
    resp.delete_cookie(org_sso.TXN_COOKIE, path="/")
    return resp


# ── Configuración (admin) ───────────────────────────────────────────────────


def _require_admin(ctx: OrgContext) -> None:
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[ROLE_ADMIN]:
        raise HTTPException(status_code=403, detail="Requiere rol admin")


class SsoIn(BaseModel):
    issuer: str = Field(min_length=8, max_length=500)
    client_id: str = Field(min_length=1, max_length=500)
    # Vacío/omitido: se conserva el guardado.
    client_secret: Optional[str] = Field(default=None, max_length=2000)
    domains: List[str] = Field(default_factory=list, max_length=20)
    enabled: bool = True
    auto_provision: bool = True
    default_role: str = Field(default=ROLE_MEMBER, pattern="^(member|viewer)$")
    enforce: bool = False


@admin_router.get("")
async def get_sso(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    _require_admin(ctx)
    cfg = (await session.scalars(select(OrgSso).where(OrgSso.org_id == ctx.org.id))).first()
    return {"configured": cfg is not None, "redirect_uri": org_sso.redirect_uri(),
            **(org_sso.view(cfg) if cfg else {})}


@admin_router.put("")
async def put_sso(payload: SsoIn, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    _require_admin(ctx)
    try:
        dominios = org_sso.clean_domains(payload.domains)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not dominios:
        raise HTTPException(status_code=422, detail="Indicá al menos un dominio de email (ej. escuela.edu).")
    issuer = payload.issuer.strip().rstrip("/")
    if not issuer.startswith("https://") and not get_settings().allow_private_outbound:
        raise HTTPException(status_code=422, detail="El emisor (issuer) tiene que ser https://")
    # Un dominio pertenece a una sola organización.
    for otro in (await session.scalars(select(OrgSso).where(OrgSso.org_id != ctx.org.id))).all():
        choque = set(dominios) & set(otro.domains or [])
        if choque:
            raise HTTPException(status_code=409, detail=f"El dominio {sorted(choque)[0]} ya lo usa otra organización.")
    try:
        await org_sso.discover(issuer)
    except org_sso.SsoError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    cfg = (await session.scalars(select(OrgSso).where(OrgSso.org_id == ctx.org.id))).first()
    if cfg is None:
        cfg = OrgSso(org_id=ctx.org.id, issuer=issuer, client_id=payload.client_id.strip())
    cfg.issuer, cfg.client_id = issuer, payload.client_id.strip()
    if payload.client_secret:
        cfg.client_secret = payload.client_secret.strip()
    cfg.domains, cfg.enabled, cfg.auto_provision = dominios, payload.enabled, payload.auto_provision
    cfg.default_role, cfg.enforce = payload.default_role, payload.enforce
    session.add(cfg)
    record_event(session, action="sso.configured", org_id=ctx.org.id, actor=ctx.user,
                 detail={"issuer": issuer, "domains": dominios, "enforce": payload.enforce})
    await session.commit()
    await session.refresh(cfg)
    return {"configured": True, **org_sso.view(cfg)}


@admin_router.delete("", status_code=204)
async def delete_sso(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    _require_admin(ctx)
    cfg = (await session.scalars(select(OrgSso).where(OrgSso.org_id == ctx.org.id))).first()
    if cfg:
        await session.delete(cfg)
        record_event(session, action="sso.removed", org_id=ctx.org.id, actor=ctx.user)
        await session.commit()
