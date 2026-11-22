"""Per-call AI usage tracking. An endpoint opens ``track_ai_call`` around an AI
operation; the LLM client (``llm.structured``) reads the active provider from the
context and reports token counts back here. On exit we persist one AiUsage row
and expose a summary for the response modal."""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from contextvars import ContextVar
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.ai_config import ProviderConfig, compute_cost
from app.models import AiUsage, Organization

LOGGER = logging.getLogger("encuestum.ai_usage")
BUDGET_WARN_AT = 0.8


class AiBudgetExceeded(HTTPException):
    """La organización llegó a su tope mensual de gasto en IA. 402 para que el
    panel lo muestre como lo que es (no un error del proveedor)."""

    def __init__(self, spent: float, budget: float):
        super().__init__(
            status_code=402,
            detail=(f"Se alcanzó el tope mensual de IA de la organización "
                    f"(USD {spent:.2f} de {budget:.2f}). Un administrador puede subirlo en la sección IA."),
        )


def _month_start(now: Optional[datetime] = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def month_spend(session: AsyncSession, org_id: uuid.UUID, now: Optional[datetime] = None) -> float:
    total = await session.scalar(
        select(func.coalesce(func.sum(AiUsage.cost_usd), 0)).where(
            AiUsage.org_id == org_id, AiUsage.created_at >= _month_start(now)
        )
    )
    return float(total or 0)


async def budget_status(session: AsyncSession, org: Organization) -> dict:
    spent = await month_spend(session, org.id)
    budget = org.ai_monthly_budget_usd
    return {
        "budget_usd": budget,
        "spent_usd": round(spent, 4),
        "ratio": round(spent / budget, 3) if budget else None,
        "blocked": bool(budget) and spent >= budget,
        "warn": bool(budget) and spent >= budget * BUDGET_WARN_AT,
        "month": _month_start().strftime("%Y-%m"),
    }


async def check_budget(session: AsyncSession, org_id: Optional[uuid.UUID]) -> None:
    if org_id is None:
        return
    org = await session.get(Organization, org_id)
    if org is None or not org.ai_monthly_budget_usd:
        return
    spent = await month_spend(session, org_id)
    if spent >= org.ai_monthly_budget_usd:
        raise AiBudgetExceeded(spent, org.ai_monthly_budget_usd)


async def _warn_if_needed(session: AsyncSession, org_id: uuid.UUID) -> None:
    """Al cruzar el 80% del tope, un aviso por mes a dueños y administradores."""
    from app.audit import record_event
    from app.email import build_url, enqueue_email
    from app.models import ROLE_ADMIN, ROLE_OWNER, Membership, User

    org = await session.get(Organization, org_id)
    if org is None or not org.ai_monthly_budget_usd:
        return
    mes = _month_start().strftime("%Y-%m")
    if org.ai_budget_warned == mes:
        return
    spent = await month_spend(session, org_id)
    if spent < org.ai_monthly_budget_usd * BUDGET_WARN_AT:
        return
    org.ai_budget_warned = mes
    session.add(org)
    record_event(session, action="ai.budget_warning", org_id=org_id,
                 detail={"spent_usd": round(spent, 4), "budget_usd": org.ai_monthly_budget_usd, "month": mes})
    admins = (await session.scalars(
        select(User).join(Membership, Membership.user_id == User.id).where(
            Membership.org_id == org_id, Membership.role.in_((ROLE_OWNER, ROLE_ADMIN))
        )
    )).all()
    pct = int(round(100 * spent / org.ai_monthly_budget_usd))
    for u in admins:
        enqueue_email(
            session, u.email, f"Encuestum: {org.name} usó el {pct}% del tope de IA",
            (f"La organización «{org.name}» lleva gastados USD {spent:.2f} en IA este mes, "
             f"el {pct}% del tope de USD {org.ai_monthly_budget_usd:.2f}.\n\n"
             "Al llegar al tope se frenan la generación y la corrección con IA hasta el mes que viene "
             f"(las correcciones pendientes se reintentan solas). Podés revisarlo en:\n{build_url('/ai')}\n"),
            org_id=org_id,
        )


class AiCall:
    def __init__(
        self,
        provider: Optional[ProviderConfig],
        org_id: Optional[uuid.UUID],
        operation: str,
        survey_id: Optional[uuid.UUID],
        created_by: Optional[uuid.UUID],
        response_id: Optional[uuid.UUID] = None,
    ):
        self.response_id = response_id
        self.provider = provider
        self.org_id = org_id
        self.operation = operation
        self.survey_id = survey_id
        self.created_by = created_by
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.model = provider.model if provider else ""
        self.cost_usd: Optional[float] = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


_ctx: ContextVar[Optional[AiCall]] = ContextVar("ai_call", default=None)


def current() -> Optional[AiCall]:
    return _ctx.get()


def record_usage(model: str, prompt_tokens, completion_tokens) -> None:
    """Called by the LLM client after each provider response (accumulates across
    retries). No-op outside a tracked call."""
    acc = _ctx.get()
    if acc is None:
        return
    if model:
        acc.model = model
    acc.prompt_tokens += int(prompt_tokens or 0)
    acc.completion_tokens += int(completion_tokens or 0)


@asynccontextmanager
async def track_ai_call(
    session: AsyncSession,
    provider: Optional[ProviderConfig],
    org_id: Optional[uuid.UUID],
    operation: str,
    survey_id: Optional[uuid.UUID] = None,
    created_by: Optional[uuid.UUID] = None,
    response_id: Optional[uuid.UUID] = None,
):
    await check_budget(session, org_id)
    acc = AiCall(provider, org_id, operation, survey_id, created_by, response_id)
    token = _ctx.set(acc)
    try:
        yield acc
    finally:
        _ctx.reset(token)
        if acc.total_tokens > 0:
            kind = provider.kind if provider else "custom"
            acc.cost_usd = await compute_cost(
                session, kind, acc.model, acc.prompt_tokens, acc.completion_tokens
            )
            session.add(
                AiUsage(
                    org_id=org_id,
                    provider_id=provider.provider_id if provider else None,
                    survey_id=survey_id,
                    response_id=response_id,
                    operation=operation,
                    model=acc.model,
                    prompt_tokens=acc.prompt_tokens,
                    completion_tokens=acc.completion_tokens,
                    total_tokens=acc.total_tokens,
                    cost_usd=acc.cost_usd,
                    created_by=created_by,
                )
            )
            await session.commit()
            if org_id is not None and acc.cost_usd:
                try:
                    await _warn_if_needed(session, org_id)
                    await session.commit()
                except Exception as exc:  # noqa: BLE001 — el aviso no rompe la operación
                    LOGGER.warning("aviso de tope de IA falló: %s", exc)
                    await session.rollback()


def summary(acc: AiCall) -> dict:
    return {
        "model": acc.model,
        "prompt_tokens": acc.prompt_tokens,
        "completion_tokens": acc.completion_tokens,
        "total_tokens": acc.total_tokens,
        "cost_usd": acc.cost_usd,
    }
