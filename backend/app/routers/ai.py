"""AI provider management (hybrid: org-owned + platform-global), live model
listing, usage/cost read-outs and the editable price table."""

import uuid
from datetime import datetime
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.ai_config import DEFAULT_BASE_URLS, DEFAULT_PRICES
from app.db import get_session
from app.deps import OrgContext, current_context, is_superadmin
from app.models import (
    AI_KINDS,
    AiModelPrice,
    AiProvider,
    AiUsage,
    ROLE_ADMIN,
    ROLE_RANK,
)

router = APIRouter(prefix="/ai", tags=["ai"])


# ── helpers ──────────────────────────────────────────────────────────────────
def _is_org_admin(ctx: OrgContext) -> bool:
    return ROLE_RANK.get(ctx.role, 0) >= ROLE_RANK[ROLE_ADMIN]


def _mask(key: str) -> str:
    return ("…" + key[-4:]) if key and len(key) > 4 else "…"


def _price_per_m(v) -> Optional[float]:
    """OpenRouter/OpenAI-style per-token price string → USD per 1M tokens."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 1_000_000, 4) if f > 0 else None


async def _fetch_models(base_url: str, api_key: str) -> List[dict]:
    from app.net_guard import assert_public_url, UnsafeUrlError
    try:
        assert_public_url(base_url)
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=422, detail=f"Base URL no permitida: {exc}")
    url = f"{base_url.rstrip('/')}/models"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo contactar al proveedor: {exc}")
    if resp.status_code == 401:
        raise HTTPException(status_code=400, detail="API key inválida para este proveedor")
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"El proveedor devolvió {resp.status_code}")
    data = resp.json().get("data", []) or []
    out: List[dict] = []
    for m in data:
        mid = m.get("id")
        if not mid:
            continue
        pricing = m.get("pricing") or {}
        out.append(
            {
                "id": mid,
                "name": m.get("name") or mid,
                "input_per_m": _price_per_m(pricing.get("prompt")),
                "output_per_m": _price_per_m(pricing.get("completion")),
            }
        )
    out.sort(key=lambda x: x["id"])
    return out


# ── schemas ──────────────────────────────────────────────────────────────────
class ProviderOut(BaseModel):
    id: uuid.UUID
    scope: str  # "org" | "global"
    name: str
    kind: str
    base_url: str
    model: str
    key_hint: str
    is_default: bool
    enabled: bool
    editable: bool
    created_at: datetime


class ProviderCreate(BaseModel):
    scope: str = "org"  # "org" | "global"
    name: str = Field(min_length=1, max_length=80)
    kind: str = "openrouter"
    base_url: Optional[str] = None
    api_key: str = Field(min_length=8, max_length=400)
    model: str = Field(min_length=1, max_length=120)
    is_default: bool = True

    @field_validator("kind")
    @classmethod
    def _kind_ok(cls, v: str) -> str:
        if v not in AI_KINDS:
            raise ValueError(f"kind debe ser uno de {sorted(AI_KINDS)}")
        return v


class ProviderUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    base_url: Optional[str] = None
    api_key: Optional[str] = Field(default=None, max_length=400)
    model: Optional[str] = Field(default=None, max_length=120)
    is_default: Optional[bool] = None
    enabled: Optional[bool] = None


class ListModelsRequest(BaseModel):
    kind: str = "openrouter"
    base_url: Optional[str] = None
    api_key: str = Field(min_length=8, max_length=400)


class PriceIn(BaseModel):
    kind: str
    model: str = Field(min_length=1, max_length=120)
    input_per_m: float = Field(ge=0)
    output_per_m: float = Field(ge=0)


def _provider_out(p: AiProvider, editable: bool) -> ProviderOut:
    return ProviderOut(
        id=p.id,
        scope="global" if p.org_id is None else "org",
        name=p.name,
        kind=p.kind,
        base_url=p.base_url,
        model=p.model,
        key_hint=_mask(p.api_key),
        is_default=p.is_default,
        enabled=p.enabled,
        editable=editable,
        created_at=p.created_at,
    )


# ── providers ────────────────────────────────────────────────────────────────
@router.get("/providers", response_model=List[ProviderOut])
async def list_providers(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    super_ = is_superadmin(ctx.user)
    org_admin = _is_org_admin(ctx)
    org_rows = (
        await session.scalars(
            select(AiProvider).where(AiProvider.org_id == ctx.org.id).order_by(AiProvider.created_at.desc())
        )
    ).all()
    global_rows = (
        await session.scalars(
            select(AiProvider).where(AiProvider.org_id.is_(None)).order_by(AiProvider.created_at.desc())
        )
    ).all()
    result = [_provider_out(p, editable=org_admin) for p in org_rows]
    result += [_provider_out(p, editable=super_) for p in global_rows]
    return result


async def _unset_defaults(session: AsyncSession, org_id: Optional[uuid.UUID], keep: Optional[uuid.UUID]) -> None:
    stmt = select(AiProvider).where(AiProvider.is_default == True)  # noqa: E712
    stmt = stmt.where(AiProvider.org_id.is_(None)) if org_id is None else stmt.where(AiProvider.org_id == org_id)
    for p in (await session.scalars(stmt)).all():
        if p.id != keep:
            p.is_default = False
            session.add(p)


@router.post("/providers", response_model=ProviderOut)
async def create_provider(
    payload: ProviderCreate,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    is_global = payload.scope == "global"
    if is_global:
        if not is_superadmin(ctx.user):
            raise HTTPException(status_code=403, detail="Solo el super-admin puede crear proveedores globales")
        org_id = None
    else:
        if not _is_org_admin(ctx):
            raise HTTPException(status_code=403, detail="Requiere rol admin en la organización")
        org_id = ctx.org.id

    base_url = (payload.base_url or DEFAULT_BASE_URLS.get(payload.kind) or "").strip().rstrip("/")
    if not base_url:
        raise HTTPException(status_code=422, detail="Falta base_url para este proveedor")

    p = AiProvider(
        org_id=org_id,
        name=payload.name.strip(),
        kind=payload.kind,
        base_url=base_url,
        api_key=payload.api_key.strip(),
        model=payload.model.strip(),
        is_default=payload.is_default,
        enabled=True,
        created_by=ctx.user.id,
    )
    session.add(p)
    if payload.is_default:
        await _unset_defaults(session, org_id, keep=p.id)
    await session.commit()
    await session.refresh(p)
    return _provider_out(p, editable=True)


async def _get_editable(session: AsyncSession, ctx: OrgContext, pid: uuid.UUID) -> AiProvider:
    p = await session.get(AiProvider, pid)
    if not p:
        raise HTTPException(status_code=404, detail="Proveedor no encontrado")
    if p.org_id is None:
        if not is_superadmin(ctx.user):
            raise HTTPException(status_code=403, detail="Solo el super-admin edita proveedores globales")
    else:
        if p.org_id != ctx.org.id or not _is_org_admin(ctx):
            raise HTTPException(status_code=403, detail="Sin permiso sobre este proveedor")
    return p


@router.patch("/providers/{pid}", response_model=ProviderOut)
async def update_provider(
    pid: uuid.UUID,
    payload: ProviderUpdate,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    p = await _get_editable(session, ctx, pid)
    if payload.name is not None:
        p.name = payload.name.strip()
    if payload.base_url is not None:
        p.base_url = payload.base_url.strip().rstrip("/")
    if payload.api_key:
        p.api_key = payload.api_key.strip()
    if payload.model is not None:
        p.model = payload.model.strip()
    if payload.enabled is not None:
        p.enabled = payload.enabled
    if payload.is_default is not None:
        p.is_default = payload.is_default
        if payload.is_default:
            await _unset_defaults(session, p.org_id, keep=p.id)
    session.add(p)
    await session.commit()
    await session.refresh(p)
    return _provider_out(p, editable=True)


@router.delete("/providers/{pid}")
async def delete_provider(
    pid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    p = await _get_editable(session, ctx, pid)
    await session.delete(p)
    await session.commit()
    return {"detail": "Proveedor eliminado"}


@router.get("/providers/{pid}/models")
async def provider_models(
    pid: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    p = await session.get(AiProvider, pid)
    if not p or (p.org_id is not None and p.org_id != ctx.org.id):
        raise HTTPException(status_code=404, detail="Proveedor no encontrado")
    return {"models": await _fetch_models(p.base_url, p.api_key)}


@router.post("/list-models")
async def list_models(
    payload: ListModelsRequest,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """List models for an unsaved provider (used by the 'add provider' form)."""
    if not (_is_org_admin(ctx) or is_superadmin(ctx.user)):
        raise HTTPException(status_code=403, detail="Requiere rol admin")
    base_url = (payload.base_url or DEFAULT_BASE_URLS.get(payload.kind) or "").strip()
    if not base_url:
        raise HTTPException(status_code=422, detail="Falta base_url")
    return {"models": await _fetch_models(base_url, payload.api_key)}


# ── usage ────────────────────────────────────────────────────────────────────
@router.get("/usage")
async def usage(
    scope: str = "org",
    limit: int = 50,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    limit = max(1, min(200, limit))
    global_scope = scope == "global"
    if global_scope and not is_superadmin(ctx.user):
        raise HTTPException(status_code=403, detail="Requiere super-admin")

    stmt = select(AiUsage).order_by(AiUsage.created_at.desc())
    if not global_scope:
        stmt = stmt.where(AiUsage.org_id == ctx.org.id)
    rows = (await session.scalars(stmt.limit(limit))).all()

    # Totals + by_operation aggregated in SQL over the whole (unlimited) scope.
    # func.sum(cost_usd) ignores NULLs; func.count(cost_usd) counts only rows
    # that actually reported a cost, so we can preserve the "None if no cost" rule.
    agg_stmt = select(
        AiUsage.operation,
        func.count(),
        func.coalesce(func.sum(AiUsage.total_tokens), 0),
        func.coalesce(func.sum(AiUsage.cost_usd), 0),
        func.count(AiUsage.cost_usd),
    ).group_by(AiUsage.operation)
    if not global_scope:
        agg_stmt = agg_stmt.where(AiUsage.org_id == ctx.org.id)
    agg_rows = (await session.execute(agg_stmt)).all()

    by_op: dict[str, dict] = {}
    total_calls = 0
    total_tokens = 0
    total_cost = 0.0
    cost_rows = 0
    for operation, calls, tokens, cost_sum, cost_count in agg_rows:
        by_op[operation] = {
            "calls": calls,
            "tokens": tokens,
            "cost_usd": float(cost_sum),
        }
        total_calls += calls
        total_tokens += tokens
        total_cost += cost_sum
        cost_rows += cost_count
    has_cost = cost_rows > 0

    return {
        "scope": "global" if global_scope else "org",
        "totals": {
            "calls": total_calls,
            "total_tokens": total_tokens,
            "total_cost_usd": round(total_cost, 4) if has_cost else None,
        },
        "by_operation": by_op,
        "recent": [
            {
                "id": str(u.id),
                "operation": u.operation,
                "model": u.model,
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens,
                "cost_usd": u.cost_usd,
                "survey_id": str(u.survey_id) if u.survey_id else None,
                "created_at": u.created_at.isoformat(),
            }
            for u in rows
        ],
    }


# ── price table ──────────────────────────────────────────────────────────────
@router.get("/prices")
async def list_prices(
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    custom = (await session.scalars(select(AiModelPrice))).all()
    seen = {(p.kind, p.model) for p in custom}
    out = [
        {
            "id": str(p.id),
            "kind": p.kind,
            "model": p.model,
            "input_per_m": p.input_per_m,
            "output_per_m": p.output_per_m,
            "source": "custom",
        }
        for p in custom
    ]
    for (kind, model), (inp, outp) in DEFAULT_PRICES.items():
        if (kind, model) not in seen:
            out.append(
                {
                    "id": None,
                    "kind": kind,
                    "model": model,
                    "input_per_m": inp,
                    "output_per_m": outp,
                    "source": "default",
                }
            )
    out.sort(key=lambda x: (x["kind"], x["model"]))
    return {"prices": out, "editable": is_superadmin(ctx.user)}


@router.put("/prices")
async def upsert_price(
    payload: PriceIn,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    if not is_superadmin(ctx.user):
        raise HTTPException(status_code=403, detail="Solo el super-admin edita precios")
    existing = (
        await session.scalars(
            select(AiModelPrice).where(
                AiModelPrice.kind == payload.kind, AiModelPrice.model == payload.model
            )
        )
    ).first()
    if existing:
        existing.input_per_m = payload.input_per_m
        existing.output_per_m = payload.output_per_m
        session.add(existing)
    else:
        session.add(
            AiModelPrice(
                kind=payload.kind,
                model=payload.model,
                input_per_m=payload.input_per_m,
                output_per_m=payload.output_per_m,
            )
        )
    await session.commit()
    return {"detail": "Precio guardado"}


@router.delete("/prices/{price_id}")
async def delete_price(
    price_id: uuid.UUID,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    if not is_superadmin(ctx.user):
        raise HTTPException(status_code=403, detail="Solo el super-admin edita precios")
    p = await session.get(AiModelPrice, price_id)
    if p:
        await session.delete(p)
        await session.commit()
    return {"detail": "Precio eliminado"}
