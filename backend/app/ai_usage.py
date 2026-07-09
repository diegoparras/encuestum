"""Per-call AI usage tracking. An endpoint opens ``track_ai_call`` around an AI
operation; the LLM client (``llm.structured``) reads the active provider from the
context and reports token counts back here. On exit we persist one AiUsage row
and expose a summary for the response modal."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_config import ProviderConfig, compute_cost
from app.models import AiUsage


class AiCall:
    def __init__(
        self,
        provider: Optional[ProviderConfig],
        org_id: Optional[uuid.UUID],
        operation: str,
        survey_id: Optional[uuid.UUID],
        created_by: Optional[uuid.UUID],
    ):
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
):
    acc = AiCall(provider, org_id, operation, survey_id, created_by)
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


def summary(acc: AiCall) -> dict:
    return {
        "model": acc.model,
        "prompt_tokens": acc.prompt_tokens,
        "completion_tokens": acc.completion_tokens,
        "total_tokens": acc.total_tokens,
        "cost_usd": acc.cost_usd,
    }
