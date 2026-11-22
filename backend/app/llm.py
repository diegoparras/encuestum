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


# Proveedores (por base URL) que rechazaron `response_format: json_schema`: a
# esos se les pide `json_object` directamente, sin probar de nuevo cada vez.
_SIN_JSON_SCHEMA: set[str] = set()
_REINTENTOS_HTTP = (0.6, 1.8)  # espera antes del 2.º y 3.er intento ante 429/5xx/red


def _strict_schema(schema: dict) -> dict:
    """El JSON Schema de Pydantic adaptado al modo estricto de OpenAI: todo
    objeto con `additionalProperties: false` y todas sus propiedades
    requeridas, sin `default` ni `title`. Con eso el proveedor garantiza la
    forma (tipos, enums) en vez de que la adivinemos validando después."""

    def walk(node):
        if isinstance(node, dict):
            out = {k: walk(v) for k, v in node.items() if k not in ("default", "title")}
            if out.get("type") == "object" and "properties" in out:
                out["additionalProperties"] = False
                out["required"] = list(out["properties"].keys())
            return out
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node

    return walk(schema)


def _rechaza_json_schema(status: int, body: str) -> bool:
    b = body.lower()
    return status in (400, 404, 422) and (
        "response_format" in b or "json_schema" in b or "structured" in b or "schema" in b
    )


async def structured(
    *,
    system: str,
    user: str,
    schema_model: Type[T],
    max_retries: int = 2,
    temperature: float = 0.2,
    validate=None,
) -> dict:
    """Return a dict validated against ``schema_model``.

    Raises ``LLMNotConfigured`` if there's no key, ``LLMError`` on failure.

    The provider (base URL, key, model) comes from the active tracked call when
    present (see ``ai_usage.track_ai_call``), falling back to env vars.

    Pide salida con `json_schema` estricto (la forma la garantiza el proveedor)
    y, si el proveedor no lo soporta, cae a `json_object` con el esquema en el
    prompt. Ante 429/5xx o fallas de red reintenta con espera. Con `validate`
    (dict -> lista de errores) se pueden exigir reglas que un esquema no
    expresa (p. ej. "el índice correcto existe"): los errores vuelven al modelo
    para que corrija, igual que un JSON inválido.
    """
    import asyncio

    from app import ai_usage  # local import to avoid a cycle at module load

    acc = ai_usage.current()
    provider = acc.provider if acc else None
    if provider is not None:
        key, base_url, model = provider.api_key, provider.base_url, provider.model
    else:
        key, base_url, model = _api_key(), _base_url(), _model()
    if not key:
        raise LLMNotConfigured("No LLM API key configured")

    # SSRF guard: el base_url del proveedor viene de config del usuario.
    from app.net_guard import assert_public_url, UnsafeUrlError

    try:
        assert_public_url(base_url)
    except UnsafeUrlError as exc:
        raise LLMError(f"Base URL del proveedor no permitida: {exc}")

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
    strict = {
        "type": "json_schema",
        "json_schema": {"name": schema_model.__name__, "strict": True, "schema": _strict_schema(schema)},
    }

    last_err = ""
    async with httpx.AsyncClient(timeout=90) as client:
        for attempt in range(max_retries + 1):
            usar_schema = base_url not in _SIN_JSON_SCHEMA
            payload = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "response_format": strict if usar_schema else {"type": "json_object"},
            }
            resp = None
            for espera in (0.0, *_REINTENTOS_HTTP):
                if espera:
                    await asyncio.sleep(espera)
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
                    last_err = f"No se pudo contactar al proveedor LLM: {exc}"
                    resp = None
                    continue
                if usar_schema and _rechaza_json_schema(resp.status_code, resp.text):
                    # Sin soporte de esquema estricto: mismo pedido con json_object.
                    _SIN_JSON_SCHEMA.add(base_url)
                    usar_schema = False
                    payload["response_format"] = {"type": "json_object"}
                    try:
                        resp = await client.post(
                            f"{base_url}/chat/completions",
                            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                            json=payload,
                        )
                    except httpx.HTTPError as exc:
                        last_err = f"No se pudo contactar al proveedor LLM: {exc}"
                        resp = None
                        continue
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_err = f"El proveedor LLM devolvió {resp.status_code}: {resp.text[:300]}"
                    continue
                break
            if resp is None:
                raise LLMError(last_err)
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
                    data = schema_model.model_validate(parsed).model_dump()
                    errores = validate(data) if validate else []
                    if not errores:
                        return data
                    last_err = "; ".join(errores)
                except ValidationError as exc:
                    last_err = str(exc)
            else:
                last_err = "La respuesta no era JSON válido."

            # Feedback for the next attempt.
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": f"La respuesta no cumple ({last_err}). Devolvé SOLO el JSON corregido.",
                }
            )

    raise LLMError(f"El modelo no produjo una respuesta válida tras varios intentos: {last_err}")


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
