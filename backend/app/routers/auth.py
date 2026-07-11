"""Authentication: register, login, logout, whoami, password reset, email verify."""

import logging
import secrets
import time
import urllib.parse
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.accounts import (
    build_me,
    clear_session_cookies,
    create_account,
    find_or_create_federated_user,
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

# ── Federación con Lockatus (SSO OIDC de la Suite) ───────────────────────────
# Solo se instancia en AUTH_MODE=federado. Cookie de transacción (verifier/state/
# nonce) firmada con el session_secret.
_OIDC_COOKIE = "enc_oidc"
_lk = None
if get_settings().is_federated:
    from app.lockatus_client import Lockatus

    _s = get_settings()
    _lk = Lockatus(_s.lockatus_issuer, _s.lockatus_client_id, _s.lockatus_redirect_uri, _s.session_secret)


def _frontend_url(path: str) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}{path}"


@router.get("/config")
async def auth_config():
    """El frontend consulta esto para saber si mostrar el login local o el botón SSO."""
    s = get_settings()
    return {"auth_mode": s.auth_mode, "sso": s.is_federated, "allow_registration": s.allow_registration}


@router.get("/sso/login")
async def sso_login(response: Response):
    s = get_settings()
    if not s.is_federated or _lk is None:
        raise HTTPException(status_code=404, detail="SSO no habilitado")
    verifier, challenge = _lk.pkce()
    state = secrets.token_urlsafe(16)
    nonce = secrets.token_urlsafe(16)
    txn = _lk.sign({"v": verifier, "s": state, "n": nonce, "exp": int((time.time() + 600) * 1000)})
    resp = RedirectResponse(_lk.authorize_url(state, nonce, challenge), status_code=302)
    resp.set_cookie(
        _OIDC_COOKIE, txn, max_age=600, httponly=True,
        secure=s.cookie_secure, samesite=s.cookie_samesite, path="/",
    )
    return resp


@router.get("/sso/callback")
async def sso_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    s = get_settings()
    if not s.is_federated or _lk is None:
        raise HTTPException(status_code=404, detail="SSO no habilitado")
    if error:
        return RedirectResponse(_frontend_url(f"/login?sso_error={urllib.parse.quote(error)}"), status_code=302)
    txn = _lk.unsign(request.cookies.get(_OIDC_COOKIE))
    if not code or not txn or txn.get("s") != state:
        return RedirectResponse(_frontend_url("/login?sso_error=state"), status_code=302)
    try:
        tok = await _lk.exchange(code, txn["v"])
        id_claims = await _lk.verify_jwt(tok["id_token"], audience=s.lockatus_client_id, nonce=txn["n"])
        access_claims = await _lk.verify_jwt(tok["access_token"], audience=s.lockatus_client_id)
        email = id_claims.get("email") or access_claims.get("email")
        name = id_claims.get("name") or id_claims.get("preferred_username") or email
        role = access_claims.get("role") or id_claims.get("role")
        if not email:
            raise ValueError("el token no incluye email (¿scope 'email'?)")
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("SSO callback falló: %s", exc)
        return RedirectResponse(_frontend_url("/login?sso_error=token"), status_code=302)

    is_admin = bool(role) and role == s.lockatus_admin_role
    user, org_id = await find_or_create_federated_user(session, email=email, name=name, is_admin=is_admin)
    resp = RedirectResponse(_frontend_url("/surveys"), status_code=302)
    set_session_cookies(resp, user.id, org_id)
    resp.delete_cookie(_OIDC_COOKIE, path="/")
    return resp


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
    if settings.is_federated:
        raise HTTPException(status_code=403, detail="El alta se maneja desde la Suite (Lockatus).")
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
