"""Deliver each new response to configured webhooks (Zapier / Make / Sheets / a
custom URL) in real time. Fire-and-forget with an HMAC signature so receivers can
verify authenticity; delivery never blocks the respondent's submission."""

import asyncio
import hashlib
import hmac
import json
import logging
import uuid

from sqlalchemy import or_
from sqlmodel import select

LOGGER = logging.getLogger("encuestum.webhooks")


def build_payload(survey, resp, event: str = "response.created") -> dict:
    grade = resp.grade or {}
    return {
        "event": event,
        "survey": {"id": str(survey.id), "slug": survey.slug, "title": survey.title},
        "response": {
            "id": str(resp.id),
            "submitted_at": resp.submitted_at.isoformat() if resp.submitted_at else None,
            "answers": resp.answers or {},
            "completed": resp.completed,
            "score": resp.score,
            "max_score": resp.max_score,
            "percent": grade.get("percent"),
            "needs_review": resp.needs_review,
        },
    }


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


async def post_webhook(url: str, secret: str, payload: dict, event: str = "response.created") -> bool:
    import httpx

    from app.net_guard import UnsafeUrlError, assert_public_url

    # Revalidar en CADA entrega, no solo al registrar el webhook: si validáramos
    # únicamente al crearlo, un dominio que resuelve a una IP pública en ese
    # momento podría re-apuntarse luego (TTL bajo) a 169.254.169.254 o a la red
    # interna, y cada respuesta nueva se convertiría en un SSRF persistente.
    # Falla cerrado: si la URL dejó de ser segura, no se entrega.
    try:
        assert_public_url(url)
    except UnsafeUrlError as exc:
        LOGGER.warning("webhook %s bloqueado por el guard SSRF: %s", url, exc)
        return False

    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Encuestum-Webhook/1.0",
        "X-Encuestum-Event": event,
        "X-Encuestum-Signature": sign(secret, body),
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, content=body, headers=headers)
        if resp.status_code >= 400:
            LOGGER.warning("webhook %s -> HTTP %s", url, resp.status_code)
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("webhook %s failed: %s", url, exc)
        return False


async def _dispatch(survey_id: uuid.UUID, response_id: uuid.UUID) -> None:
    from app.db import _session_maker
    from app.models import Survey, SurveyResponse, Webhook

    async with _session_maker() as session:
        survey = await session.get(Survey, survey_id)
        resp = await session.get(SurveyResponse, response_id)
        if not survey or not resp:
            return
        hooks = (
            await session.scalars(
                select(Webhook).where(
                    Webhook.org_id == survey.org_id,
                    Webhook.active == True,  # noqa: E712
                    or_(Webhook.survey_id == survey.id, Webhook.survey_id.is_(None)),
                )
            )
        ).all()
        if not hooks:
            return
        payload = build_payload(survey, resp)
        for h in hooks:
            await post_webhook(h.url, h.secret, payload)


def schedule_response_delivery(survey_id, response_id) -> None:
    """Enqueue delivery on the running loop; never raises into the request."""
    from app.config import get_settings

    if not get_settings().webhooks_enabled:
        return
    try:
        sid = survey_id if isinstance(survey_id, uuid.UUID) else uuid.UUID(str(survey_id))
        rid = response_id if isinstance(response_id, uuid.UUID) else uuid.UUID(str(response_id))
        asyncio.get_running_loop().create_task(_dispatch(sid, rid))
    except RuntimeError:
        pass  # no running loop (e.g. sync test context)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("could not schedule webhook delivery: %s", exc)
