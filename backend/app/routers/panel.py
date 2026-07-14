"""Admin panels: per-organization overview/export and platform super-admin."""

import asyncio
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.db import get_session
from app.deps import current_user, require_superadmin
from app.exporting import XLSX_MEDIA, export_rows, sheets_to_xlsx
from app.models import Membership, Organization, Survey, SurveyResponse, User

router = APIRouter(tags=["panel"])


async def _member(session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID) -> Membership:
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


async def _response_counts(session: AsyncSession, survey_ids: list) -> dict:
    if not survey_ids:
        return {}
    rows = (
        await session.execute(
            select(SurveyResponse.survey_id, func.count(SurveyResponse.id))
            .where(SurveyResponse.survey_id.in_(survey_ids))
            .group_by(SurveyResponse.survey_id)
        )
    ).all()
    return {r[0]: r[1] for r in rows}


# ── Per-organization ─────────────────────────────────────────────────────────
@router.get("/orgs/{org_id}/overview")
async def org_overview(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _member(session, user.id, org_id)
    surveys = (await session.scalars(select(Survey).where(Survey.org_id == org_id, Survey.deleted_at.is_(None)))).all()
    counts = await _response_counts(session, [s.id for s in surveys])
    members = await session.scalar(
        select(func.count(Membership.id)).where(Membership.org_id == org_id)
    )
    by_status = {"draft": 0, "published": 0, "closed": 0}
    for s in surveys:
        by_status[s.status] = by_status.get(s.status, 0) + 1
    recent = sorted(surveys, key=lambda s: s.updated_at, reverse=True)[:8]
    return {
        "surveys": len(surveys),
        "responses": sum(counts.values()),
        "members": members,
        "by_status": by_status,
        "recent": [
            {
                "id": str(s.id), "title": s.title, "slug": s.slug, "status": s.status,
                "responses": counts.get(s.id, 0), "updated_at": s.updated_at.isoformat(),
            }
            for s in recent
        ],
    }


@router.get("/orgs/{org_id}/export")
async def org_export(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
):
    await _member(session, user.id, org_id)
    surveys = (
        await session.scalars(
            select(Survey)
            .where(Survey.org_id == org_id, Survey.deleted_at.is_(None))
            .order_by(Survey.created_at.asc())
        )
    ).all()
    sheets = []
    for s in surveys:
        responses = (
            await session.scalars(
                select(SurveyResponse)
                .where(SurveyResponse.survey_id == s.id)
                .order_by(SurveyResponse.submitted_at.asc())
            )
        ).all()
        sheets.append((s.title or s.slug or "Encuesta", export_rows(s, responses)))
    data = await asyncio.to_thread(sheets_to_xlsx, sheets)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return StreamingResponse(
        iter([data]), media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="organizacion-{stamp}.xlsx"'},
    )


# ── Platform super-admin ─────────────────────────────────────────────────────
@router.get("/admin/overview")
async def admin_overview(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_superadmin),
):
    orgs = (await session.scalars(select(Organization).order_by(Organization.created_at.desc()))).all()
    users_total = await session.scalar(select(func.count(User.id)))
    surveys_total = await session.scalar(select(func.count(Survey.id)))
    responses_total = await session.scalar(select(func.count(SurveyResponse.id)))

    # Per-org aggregates in one query each (avoids the N+1 loop).
    survey_counts = dict(
        (await session.execute(
            select(Survey.org_id, func.count(Survey.id)).group_by(Survey.org_id)
        )).all()
    )
    response_counts = dict(
        (await session.execute(
            select(Survey.org_id, func.count(SurveyResponse.id))
            .join(SurveyResponse, SurveyResponse.survey_id == Survey.id)
            .group_by(Survey.org_id)
        )).all()
    )
    member_counts = dict(
        (await session.execute(
            select(Membership.org_id, func.count(Membership.id)).group_by(Membership.org_id)
        )).all()
    )

    org_rows = []
    for o in orgs:
        org_rows.append({
            "id": str(o.id), "name": o.name, "slug": o.slug,
            "surveys": survey_counts.get(o.id, 0),
            "responses": response_counts.get(o.id, 0),
            "members": member_counts.get(o.id, 0),
            "created_at": o.created_at.isoformat(),
        })
    return {
        "orgs": len(orgs), "users": users_total,
        "surveys": surveys_total, "responses": responses_total,
        "organizations": org_rows,
    }


@router.get("/admin/export")
async def admin_export(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_superadmin),
):
    orgs = (await session.scalars(select(Organization).order_by(Organization.created_at.asc()))).all()
    org_sheet = [["organización", "slug", "encuestas", "respuestas", "miembros", "creada"]]
    for o in orgs:
        sids = [s.id for s in (await session.scalars(select(Survey).where(Survey.org_id == o.id, Survey.deleted_at.is_(None)))).all()]
        counts = await _response_counts(session, sids)
        members = await session.scalar(
            select(func.count(Membership.id)).where(Membership.org_id == o.id)
        )
        org_sheet.append([o.name, o.slug, len(sids), sum(counts.values()), members, o.created_at.isoformat()])

    users = (await session.scalars(select(User).order_by(User.created_at.asc()))).all()
    user_sheet = [["email", "nombre", "verificado", "super-admin", "creado"]]
    for u in users:
        user_sheet.append([
            u.email, u.name or "", "sí" if u.email_verified else "no",
            "sí" if u.is_superadmin else "no", u.created_at.isoformat(),
        ])

    data = await asyncio.to_thread(
        sheets_to_xlsx, [("Organizaciones", org_sheet), ("Usuarios", user_sheet)]
    )
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return StreamingResponse(
        iter([data]), media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="plataforma-{stamp}.xlsx"'},
    )
