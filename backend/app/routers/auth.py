"""Authentication: register, login, logout, whoami, password reset, email verify."""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

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
from app.email import build_url, send_reset_email, send_verify_email
from app.models import Membership, User
from app.ratelimit import rate_limit
from app.schemas_auth import (
    ForgotPasswordRequest,
    LoginRequest,
    MeOut,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    SimpleMessage,
    TokenRequest,
)
from app.security import (
    create_purpose_token,
    hash_password,
    read_purpose_token,
    verify_password,
)

LOGGER = logging.getLogger("encuestum.auth")
router = APIRouter(prefix="/auth", tags=["auth"])

_OK_RESET = "Si el email existe, te enviamos un enlace para restablecer la contraseña."


async def _send_verification(user: User) -> None:
    settings = get_settings()
    token = create_purpose_token("verify", {"sub": str(user.id)}, settings.verify_ttl_hours)
    await send_verify_email(user.email, build_url("/verify", token=token))


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
    await rate_limit(request, "register", limit=10, window_s=3600)

    user, org = await create_account(
        session,
        email=payload.email,
        password=payload.password,
        name=payload.name,
        org_name=payload.org_name,
    )
    try:
        await _send_verification(user)
    except Exception as exc:  # noqa: BLE001 — no bloquear el alta por el email
        LOGGER.warning("no se pudo enviar la verificación a %s: %s", user.email, exc)
    set_session_cookies(response, user.id, org.id)
    return await build_me(session, user, org.id)


@router.post("/login", response_model=MeOut)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
):
    settings = get_settings()
    await rate_limit(request, "login", limit=10, window_s=300)
    user = await get_user_by_email(session, payload.email)
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email o contraseña incorrectos")
    if settings.require_email_verification and not user.email_verified:
        raise HTTPException(status_code=403, detail="Verificá tu email antes de ingresar")

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


# ── Password reset ───────────────────────────────────────────────────────────
@router.post("/forgot-password", response_model=SimpleMessage)
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    settings = get_settings()
    await rate_limit(request, "forgot", limit=5, window_s=900)
    user = await get_user_by_email(session, payload.email)
    # Always return the same message (no user enumeration).
    if user and user.is_active:
        token = create_purpose_token("reset", {"sub": str(user.id)}, settings.reset_ttl_hours)
        try:
            await send_reset_email(user.email, build_url("/reset", token=token))
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("no se pudo enviar el reset a %s: %s", user.email, exc)
    return SimpleMessage(detail=_OK_RESET)


@router.post("/reset-password", response_model=SimpleMessage)
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    await rate_limit(request, "reset", limit=10, window_s=900)
    data = read_purpose_token("reset", payload.token)
    if not data:
        raise HTTPException(status_code=400, detail="El enlace es inválido o venció")
    user = await session.get(User, uuid.UUID(data["sub"]))
    if not user or not user.is_active:
        raise HTTPException(status_code=400, detail="Cuenta no encontrada")
    user.password_hash = hash_password(payload.password)
    session.add(user)
    await session.commit()
    return SimpleMessage(detail="Contraseña actualizada. Ya podés ingresar.")


# ── Email verification ───────────────────────────────────────────────────────
@router.post("/verify-email", response_model=SimpleMessage)
async def verify_email(payload: TokenRequest, session: AsyncSession = Depends(get_session)):
    data = read_purpose_token("verify", payload.token)
    if not data:
        raise HTTPException(status_code=400, detail="El enlace es inválido o venció")
    user = await session.get(User, uuid.UUID(data["sub"]))
    if not user:
        raise HTTPException(status_code=400, detail="Cuenta no encontrada")
    if not user.email_verified:
        user.email_verified = True
        session.add(user)
        await session.commit()
    return SimpleMessage(detail="Email verificado. ¡Gracias!")


@router.post("/resend-verification", response_model=SimpleMessage)
async def resend_verification(
    payload: ResendVerificationRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    await rate_limit(request, "resend", limit=5, window_s=900)
    user = await get_user_by_email(session, payload.email)
    if user and user.is_active and not user.email_verified:
        try:
            await _send_verification(user)
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("no se pudo reenviar verificación a %s: %s", user.email, exc)
    return SimpleMessage(detail="Si corresponde, te reenviamos el email de verificación.")
