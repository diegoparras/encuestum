"""Resolve which LLM provider to use for an organization (hybrid: org override
→ global default → legacy env vars) and convert token usage into money via an
editable price table (USD per 1M tokens)."""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models import AiModelPrice, AiProvider


@dataclass
class ProviderConfig:
    base_url: str
    api_key: str
    model: str
    kind: str  # openai | openrouter | custom
    provider_id: Optional[uuid.UUID] = None


# Default OpenAI-compatible base URLs per provider kind.
DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "custom": "https://openrouter.ai/api/v1",
}

# Seed prices — USD per 1M tokens (input, output). The editable AiModelPrice table
# overrides these; OpenRouter models can also be priced from its /models feed.
DEFAULT_PRICES: dict[tuple[str, str], tuple[float, float]] = {
    ("openai", "gpt-4o-mini"): (0.15, 0.60),
    ("openai", "gpt-4o"): (2.50, 10.0),
    ("openai", "gpt-4.1-mini"): (0.40, 1.60),
    ("openai", "gpt-4.1"): (2.0, 8.0),
    ("openai", "gpt-4.1-nano"): (0.10, 0.40),
    ("openai", "o4-mini"): (1.10, 4.40),
    ("openrouter", "openai/gpt-4o-mini"): (0.15, 0.60),
    ("openrouter", "openai/gpt-4o"): (2.50, 10.0),
    ("openrouter", "anthropic/claude-3.5-sonnet"): (3.0, 15.0),
    ("openrouter", "anthropic/claude-3.5-haiku"): (0.80, 4.0),
    ("openrouter", "anthropic/claude-3-haiku"): (0.25, 1.25),
    ("openrouter", "google/gemini-2.0-flash-001"): (0.10, 0.40),
}


def _env_provider() -> Optional[ProviderConfig]:
    key = (
        os.getenv("ENCUESTUM_LLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or os.getenv("OPENROUTER_API_KEY")
    )
    if not key:
        return None
    base = (
        os.getenv("ENCUESTUM_LLM_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or "https://openrouter.ai/api/v1"
    ).rstrip("/")
    model = os.getenv("ENCUESTUM_LLM_MODEL") or os.getenv("OPENAI_MODEL") or "openai/gpt-4o-mini"
    return ProviderConfig(base_url=base, api_key=key, model=model, kind="custom")


def _to_config(p: AiProvider) -> ProviderConfig:
    return ProviderConfig(
        base_url=p.base_url.rstrip("/"),
        api_key=p.api_key,
        model=p.model,
        kind=p.kind,
        provider_id=p.id,
    )


async def _pick(session: AsyncSession, org_id: Optional[uuid.UUID]) -> Optional[AiProvider]:
    """Enabled provider for this scope, preferring the one marked default, then
    the most recently created."""
    stmt = select(AiProvider).where(AiProvider.enabled == True)  # noqa: E712
    if org_id is None:
        stmt = stmt.where(AiProvider.org_id.is_(None))
    else:
        stmt = stmt.where(AiProvider.org_id == org_id)
    stmt = stmt.order_by(AiProvider.is_default.desc(), AiProvider.created_at.desc())
    return (await session.scalars(stmt)).first()


async def resolve_provider(
    session: AsyncSession, org_id: Optional[uuid.UUID]
) -> Optional[ProviderConfig]:
    """Hybrid resolution: the org's own provider first, then the platform-global
    default, then legacy env vars. None → AI is not configured anywhere."""
    if org_id is not None:
        own = await _pick(session, org_id)
        if own:
            return _to_config(own)
    glob = await _pick(session, None)
    if glob:
        return _to_config(glob)
    return _env_provider()


async def price_for(
    session: AsyncSession, kind: str, model: str
) -> Optional[tuple[float, float]]:
    row = (
        await session.scalars(
            select(AiModelPrice).where(
                AiModelPrice.kind == kind, AiModelPrice.model == model
            )
        )
    ).first()
    if row:
        return (row.input_per_m, row.output_per_m)
    return DEFAULT_PRICES.get((kind, model))


async def compute_cost(
    session: AsyncSession,
    kind: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
) -> Optional[float]:
    """USD cost, or None when we have no price for the model (tokens-only)."""
    price = await price_for(session, kind, model)
    if not price:
        return None
    inp, out = price
    return round(prompt_tokens / 1e6 * inp + completion_tokens / 1e6 * out, 6)
