"""Lean, provider-agnostic LLM client for Encuestum.

Talks to any OpenAI-compatible chat-completions endpoint (OpenAI, OpenRouter,
Together, a local server, …). Configured entirely by environment variables so
the app stays self-hosted and bring-your-own-key. Structured output is obtained
with ``response_format: json_object`` plus the target JSON schema in the prompt
and a validate/retry loop — the most portable approach across providers.
"""

from __future__ import annotations

import json
import os
from typing import Optional, Type, TypeVar

import httpx
from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)


class LLMNotConfigured(RuntimeError):
    """Raised when no API key is configured — callers defer to human review."""


class LLMError(RuntimeError):
    """Raised when the provider fails or returns unusable content."""


def _api_key() -> Optional[str]:
    return (
        os.getenv("ENCUESTUM_LLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or os.getenv("OPENROUTER_API_KEY")
    )


def _base_url() -> str:
    return (
        os.getenv("ENCUESTUM_LLM_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or "https://openrouter.ai/api/v1"
    ).rstrip("/")


def _model() -> str:
    return os.getenv("ENCUESTUM_LLM_MODEL") or os.getenv("OPENAI_MODEL") or "openai/gpt-4o-mini"


def is_configured() -> bool:
    return bool(_api_key())


async def structured(
    *,
    system: str,
    user: str,
    schema_model: Type[T],
    max_retries: int = 2,
    temperature: float = 0.2,
) -> dict:
    """Return a dict validated against ``schema_model``.

    Raises ``LLMNotConfigured`` if there's no key, ``LLMError`` on failure.

    The provider (base URL, key, model) comes from the active tracked call when
    present (see ``ai_usage.track_ai_call``), falling back to env vars.
    """
    from app import ai_usage  # local import to avoid a cycle at module load

    acc = ai_usage.current()
    provider = acc.provider if acc else None
    if provider is not None:
        key, base_url, model = provider.api_key, provider.base_url, provider.model
    else:
        key, base_url, model = _api_key(), _base_url(), _model()
    if not key:
        raise LLMNotConfigured("No LLM API key configured")

    schema = schema_model.model_json_schema()
    sys_prompt = (
        f"{system}\n\n"
        "Respondé EXCLUSIVAMENTE con un objeto JSON válido que cumpla este JSON Schema "
        "(sin texto adicional, sin markdown):\n"
        f"{json.dumps(schema, ensure_ascii=False)}"
    )
    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user},
    ]

    last_err = ""
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(max_retries + 1):
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "response_format": {"type": "json_object"},
            }
            try:
                resp = await client.post(
                    f"{base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            except httpx.HTTPError as exc:
                raise LLMError(f"No se pudo contactar al proveedor LLM: {exc}") from exc

            if resp.status_code >= 400:
                raise LLMError(f"El proveedor LLM devolvió {resp.status_code}: {resp.text[:300]}")

            resp_json = resp.json()
            usage = resp_json.get("usage") or {}
            ai_usage.record_usage(
                resp_json.get("model") or model,
                usage.get("prompt_tokens"),
                usage.get("completion_tokens"),
            )
            content = (
                resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")
            )
            parsed = _extract_json(content)
            if parsed is not None:
                try:
                    return schema_model.model_validate(parsed).model_dump()
                except ValidationError as exc:
                    last_err = str(exc)
            else:
                last_err = "La respuesta no era JSON válido."

            # Feedback for the next attempt.
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": f"El JSON no validó ({last_err}). Devolvé SOLO el JSON corregido.",
                }
            )

    raise LLMError(f"El modelo no produjo JSON válido tras varios intentos: {last_err}")


def _extract_json(text: str):
    text = (text or "").strip()
    if text.startswith("```"):
        # strip ```json … ``` fences
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        # last resort: grab the outermost {...}
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except Exception:
                return None
    return None
