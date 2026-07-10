"""Auth/context dependencies: current user, active organization, role guards."""

from dataclasses import dataclass
import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db import get_session
from app.models import Membership, Organization, User
from app.security import read_session_token


async def current_user(
    request: Request, session: AsyncSession = Depends(get_session)
) -> User:
    s = get_settings()
    token = request.cookies.get(s.session_cookie)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = read_session_token(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = await session.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Account not found or disabled")
    return user


@dataclass
class OrgContext:
    user: User
    org: Organization
    membership: Membership

    @property
    def role(self) -> str:
        return self.membership.role


async def current_context(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
) -> OrgContext:
    """Resolve the active organization from the `enc_org` cookie, falling back to
    the user's first membership. Always validates membership server-side."""
    s = get_settings()
    memberships = (
        await session.scalars(
            select(Membership)
            .where(Membership.user_id == user.id)
            .order_by(Membership.created_at.asc())
        )
    ).all()
    if not memberships:
        raise HTTPException(status_code=403, detail="User has no organization")

    chosen = memberships[0]
    raw = request.cookies.get(s.org_cookie)
    if raw:
        try:
            wanted = uuid.UUID(raw)
            for m in memberships:
                if m.org_id == wanted:
                    chosen = m
                    break
        except ValueError:
            pass

    org = await session.get(Organization, chosen.org_id)
    if not org:
        raise HTTPException(status_code=403, detail="Organization not found")
    return OrgContext(user=user, org=org, membership=chosen)


def is_superadmin(user: User) -> bool:
    """Non-raising super-admin check (for conditional permissions).

    The `is_superadmin` DB column always grants it. The env-configured email is a
    convenience that ONLY applies to a **verified** account — otherwise anyone who
    self-registers that email (before the real owner) would seize the platform.
    """
    if user.is_superadmin:
        return True
    s = get_settings()
    return bool(
        s.superadmin_email
        and user.email_verified
        and user.email.lower() == s.superadmin_email
    )


async def require_superadmin(user: User = Depends(current_user)) -> User:
    if is_superadmin(user):
        return user
    raise HTTPException(status_code=403, detail="Requiere super-admin de plataforma")
