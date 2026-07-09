"""Account/organization helpers shared by the auth and org routers."""

import uuid
from typing import Optional

from fastapi import HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.models import (
    Membership,
    Organization,
    User,
    ROLE_OWNER,
)
from app.schemas_auth import MeOut, OrgOut, UserOut
from app.security import create_session_token, hash_password


async def get_user_by_email(session: AsyncSession, email: str) -> Optional[User]:
    email = email.strip().lower()
    return (
        await session.scalars(select(User).where(User.email == email))
    ).first()


async def create_account(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    name: Optional[str],
    org_name: Optional[str],
) -> tuple[User, Organization]:
    email = email.strip().lower()
    if await get_user_by_email(session, email):
        raise HTTPException(status_code=409, detail="Ese email ya está registrado")

    user = User(email=email, name=(name or None), password_hash=hash_password(password))
    session.add(user)
    await session.flush()

    label = (org_name or "").strip() or (
        f"Espacio de {name.strip()}" if name and name.strip() else "Mi espacio"
    )
    org = Organization(name=label)
    session.add(org)
    await session.flush()

    session.add(Membership(user_id=user.id, org_id=org.id, role=ROLE_OWNER))
    await session.commit()
    await session.refresh(user)
    await session.refresh(org)
    return user, org


async def build_me(session: AsyncSession, user: User, active_org_id: uuid.UUID) -> MeOut:
    rows = (
        await session.execute(
            select(Membership, Organization)
            .join(Organization, Organization.id == Membership.org_id)
            .where(Membership.user_id == user.id)
            .order_by(Membership.created_at.asc())
        )
    ).all()
    orgs = [
        OrgOut(
            id=org.id, name=org.name, slug=org.slug, role=m.role, created_at=org.created_at
        )
        for (m, org) in rows
    ]
    return MeOut(
        user=UserOut(id=user.id, email=user.email, name=user.name, created_at=user.created_at),
        orgs=orgs,
        active_org_id=active_org_id,
    )


def set_session_cookies(response: Response, user_id: uuid.UUID, org_id: uuid.UUID) -> None:
    s = get_settings()
    token = create_session_token(user_id)
    max_age = s.session_ttl_days * 24 * 3600
    response.set_cookie(
        s.session_cookie, token, max_age=max_age, httponly=True,
        secure=s.cookie_secure, samesite=s.cookie_samesite, path="/",
    )
    set_org_cookie(response, org_id)


def set_org_cookie(response: Response, org_id: uuid.UUID) -> None:
    s = get_settings()
    max_age = s.session_ttl_days * 24 * 3600
    # Not httponly: the frontend reads it to know the active org. It carries no
    # secret — server always re-validates membership.
    response.set_cookie(
        s.org_cookie, str(org_id), max_age=max_age, httponly=False,
        secure=s.cookie_secure, samesite=s.cookie_samesite, path="/",
    )


def clear_session_cookies(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(s.session_cookie, path="/")
    response.delete_cookie(s.org_cookie, path="/")
