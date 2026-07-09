"""Authentication: register, login, logout, whoami."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.accounts import (
    build_me,
    clear_session_cookies,
    create_account,
    get_user_by_email,
    set_session_cookies,
)
from app.config import get_settings
from app.db import get_session
from app.deps import OrgContext, current_context
from app.ratelimit import rate_limit
from app.schemas_auth import LoginRequest, MeOut, RegisterRequest
from app.security import verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=MeOut, status_code=201)
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
):
    settings = get_settings()
    if not settings.allow_registration:
        raise HTTPException(status_code=403, detail="El registro está deshabilitado")
    rate_limit(request, "register", limit=10, window_s=3600)

    user, org = await create_account(
        session,
        email=payload.email,
        password=payload.password,
        name=payload.name,
        org_name=payload.org_name,
    )
    set_session_cookies(response, user.id, org.id)
    return await build_me(session, user, org.id)


@router.post("/login", response_model=MeOut)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
):
    rate_limit(request, "login", limit=10, window_s=300)
    user = await get_user_by_email(session, payload.email)
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email o contraseña incorrectos")

    from sqlmodel import select
    from app.models import Membership

    first = (
        await session.scalars(
            select(Membership)
            .where(Membership.user_id == user.id)
            .order_by(Membership.created_at.asc())
        )
    ).first()
    if not first:
        raise HTTPException(status_code=403, detail="La cuenta no tiene organización")
    set_session_cookies(response, user.id, first.org_id)
    return await build_me(session, user, first.org_id)


@router.post("/logout", status_code=204)
async def logout(response: Response):
    clear_session_cookies(response)


@router.get("/me", response_model=MeOut)
async def me(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    return await build_me(session, ctx.user, ctx.org.id)
