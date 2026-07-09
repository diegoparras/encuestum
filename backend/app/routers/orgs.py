"""Organizations: create, switch active org, manage members."""

import uuid
from typing import List

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.accounts import build_me, get_user_by_email, set_org_cookie
from app.config import get_settings
from app.db import get_session
from app.deps import current_user
from app.email import build_url, send_invite_email
from app.models import (
    Invitation,
    Membership,
    Organization,
    User,
    ROLE_ADMIN,
    ROLE_OWNER,
    ROLE_RANK,
    VALID_ROLES,
)
from app.schemas_auth import (
    AddMemberRequest,
    CreateOrgRequest,
    InvitationOut,
    InviteRequest,
    MeOut,
    MemberOut,
    OrgOut,
    TokenRequest,
    UpdateMemberRoleRequest,
)
from app.security import create_purpose_token, read_purpose_token

router = APIRouter(prefix="/orgs", tags=["organizations"])


async def _membership(session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID) -> Membership:
    m = (
        await session.scalars(
            select(Membership).where(
                Membership.user_id == user_id, Membership.org_id == org_id
            )
        )
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="No sos miembro de esa organización")
    return m


def _require_rank(membership: Membership, min_role: str) -> None:
    if ROLE_RANK.get(membership.role, 0) < ROLE_RANK[min_role]:
        raise HTTPException(status_code=403, detail=f"Requiere rol '{min_role}' o superior")


async def _count_owners(session: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (
        await session.scalars(
            select(Membership).where(
                Membership.org_id == org_id, Membership.role == ROLE_OWNER
            )
        )
    ).all()
    return len(rows)


@router.post("", response_model=OrgOut, status_code=201)
async def create_org(
    payload: CreateOrgRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    org = Organization(name=payload.name.strip())
    session.add(org)
    await session.flush()
    session.add(Membership(user_id=user.id, org_id=org.id, role=ROLE_OWNER))
    await session.commit()
    await session.refresh(org)
    set_org_cookie(response, org.id)
    return OrgOut(id=org.id, name=org.name, slug=org.slug, role=ROLE_OWNER, created_at=org.created_at)


@router.post("/switch", response_model=MeOut)
async def switch_org(
    response: Response,
    org_id: uuid.UUID = Body(..., embed=True),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _membership(session, user.id, org_id)  # 404 if not a member
    set_org_cookie(response, org_id)
    return await build_me(session, user, org_id)


@router.get("/{org_id}/members", response_model=List[MemberOut])
async def list_members(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _membership(session, user.id, org_id)  # any member can view
    rows = (
        await session.execute(
            select(Membership, User)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id)
            .order_by(Membership.created_at.asc())
        )
    ).all()
    return [
        MemberOut(user_id=u.id, email=u.email, name=u.name, role=m.role, joined_at=m.created_at)
        for (m, u) in rows
    ]


@router.post("/{org_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    org_id: uuid.UUID,
    payload: AddMemberRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    _require_rank(caller, ROLE_ADMIN)
    role = payload.role.strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Rol inválido")
    # Only an owner can grant the owner role.
    if role == ROLE_OWNER and caller.role != ROLE_OWNER:
        raise HTTPException(status_code=403, detail="Solo un owner puede designar otro owner")

    target = await get_user_by_email(session, payload.email)
    if not target:
        raise HTTPException(
            status_code=404,
            detail="No hay ninguna cuenta con ese email. La persona debe registrarse primero.",
        )
    existing = (
        await session.scalars(
            select(Membership).where(
                Membership.user_id == target.id, Membership.org_id == org_id
            )
        )
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Ya es miembro de la organización")

    m = Membership(user_id=target.id, org_id=org_id, role=role)
    session.add(m)
    await session.commit()
    await session.refresh(m)
    return MemberOut(user_id=target.id, email=target.email, name=target.name, role=m.role, joined_at=m.created_at)


@router.patch("/{org_id}/members/{member_user_id}", response_model=MemberOut)
async def update_member_role(
    org_id: uuid.UUID,
    member_user_id: uuid.UUID,
    payload: UpdateMemberRoleRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    _require_rank(caller, ROLE_ADMIN)
    role = payload.role.strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Rol inválido")
    if role == ROLE_OWNER and caller.role != ROLE_OWNER:
        raise HTTPException(status_code=403, detail="Solo un owner puede designar otro owner")

    target = await _membership(session, member_user_id, org_id)
    # Don't allow removing the last owner via demotion.
    if target.role == ROLE_OWNER and role != ROLE_OWNER and await _count_owners(session, org_id) <= 1:
        raise HTTPException(status_code=400, detail="No podés dejar la organización sin owner")

    target.role = role
    session.add(target)
    await session.commit()
    await session.refresh(target)
    u = await session.get(User, member_user_id)
    return MemberOut(user_id=u.id, email=u.email, name=u.name, role=target.role, joined_at=target.created_at)


@router.delete("/{org_id}/members/{member_user_id}", status_code=204)
async def remove_member(
    org_id: uuid.UUID,
    member_user_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    # Admins can remove others; anyone can remove themselves (leave).
    if member_user_id != user.id:
        _require_rank(caller, ROLE_ADMIN)
    target = await _membership(session, member_user_id, org_id)
    if target.role == ROLE_OWNER and await _count_owners(session, org_id) <= 1:
        raise HTTPException(status_code=400, detail="No podés quitar al único owner")
    await session.delete(target)
    await session.commit()


# ── Invitations by email ─────────────────────────────────────────────────────
def _invite_out(inv: Invitation, with_url: bool = True) -> InvitationOut:
    accept_url = None
    if with_url:
        token = create_purpose_token(
            "invite", {"inv": str(inv.id)}, get_settings().invite_ttl_hours
        )
        accept_url = build_url("/accept-invite", token=token)
    return InvitationOut(
        id=inv.id, org_id=inv.org_id, email=inv.email, role=inv.role,
        created_at=inv.created_at, accept_url=accept_url,
    )


@router.get("/{org_id}/invitations", response_model=List[InvitationOut])
async def list_invitations(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    _require_rank(caller, ROLE_ADMIN)
    rows = (
        await session.scalars(
            select(Invitation)
            .where(Invitation.org_id == org_id, Invitation.accepted_at.is_(None))
            .order_by(Invitation.created_at.desc())
        )
    ).all()
    return [_invite_out(inv) for inv in rows]


@router.post("/{org_id}/invitations", response_model=InvitationOut, status_code=201)
async def create_invitation(
    org_id: uuid.UUID,
    payload: InviteRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    _require_rank(caller, ROLE_ADMIN)
    role = payload.role.strip().lower()
    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Rol inválido")
    if role == ROLE_OWNER and caller.role != ROLE_OWNER:
        raise HTTPException(status_code=403, detail="Solo un owner puede designar otro owner")

    email = payload.email.strip().lower()
    existing_user = await get_user_by_email(session, email)
    if existing_user:
        already = (
            await session.scalars(
                select(Membership).where(
                    Membership.user_id == existing_user.id, Membership.org_id == org_id
                )
            )
        ).first()
        if already:
            raise HTTPException(status_code=409, detail="Ya es miembro de la organización")

    pending = (
        await session.scalars(
            select(Invitation).where(
                Invitation.org_id == org_id,
                Invitation.email == email,
                Invitation.accepted_at.is_(None),
            )
        )
    ).first()
    inv = pending or Invitation(org_id=org_id, email=email, role=role, invited_by=user.id)
    inv.role = role
    session.add(inv)
    await session.commit()
    await session.refresh(inv)

    out = _invite_out(inv)
    org = await session.get(Organization, org_id)
    try:
        await send_invite_email(email, org.name if org else "una organización", out.accept_url)
    except Exception:  # noqa: BLE001 — el link igual queda en la respuesta
        pass
    return out


@router.delete("/{org_id}/invitations/{invite_id}", status_code=204)
async def revoke_invitation(
    org_id: uuid.UUID,
    invite_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    caller = await _membership(session, user.id, org_id)
    _require_rank(caller, ROLE_ADMIN)
    inv = await session.get(Invitation, invite_id)
    if not inv or inv.org_id != org_id:
        raise HTTPException(status_code=404, detail="Invitación no encontrada")
    await session.delete(inv)
    await session.commit()


@router.post("/accept-invite", response_model=MeOut)
async def accept_invite(
    payload: TokenRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    data = read_purpose_token("invite", payload.token)
    if not data:
        raise HTTPException(status_code=400, detail="La invitación es inválida o venció")
    inv = await session.get(Invitation, uuid.UUID(data["inv"]))
    if not inv or inv.accepted_at is not None:
        raise HTTPException(status_code=400, detail="La invitación ya no está disponible")
    if inv.email.strip().lower() != user.email.strip().lower():
        raise HTTPException(
            status_code=403,
            detail=f"Esta invitación es para {inv.email}. Ingresá con esa cuenta.",
        )

    existing = (
        await session.scalars(
            select(Membership).where(
                Membership.user_id == user.id, Membership.org_id == inv.org_id
            )
        )
    ).first()
    from app.models import _utcnow

    if not existing:
        session.add(Membership(user_id=user.id, org_id=inv.org_id, role=inv.role))
    inv.accepted_at = _utcnow()
    session.add(inv)
    await session.commit()

    set_org_cookie(response, inv.org_id)
    return await build_me(session, user, inv.org_id)
