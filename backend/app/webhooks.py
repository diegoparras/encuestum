"""Deliver each new response to configured webhooks (Zapier / Make / Sheets / a
custom URL) in real time. Fire-and-forget with an HMAC signature so receivers can
verify authenticity; delivery never blocks the respondent's submission."""

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


def chat_kind(url: str) -> str | None:
    """Slack, Teams o Discord: esos destinos no entienden nuestro JSON, sino su
    propio formato de mensaje. Se detecta por el host de la URL."""
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    if host == "hooks.slack.com":
        return "slack"
    if host.endswith(".webhook.office.com") or host == "outlook.office.com":
        return "teams"
    if host.endswith(".logic.azure.com") or host.endswith(".powerplatform.com"):
        return "teams_workflow"
    if host in ("discord.com", "discordapp.com") and urlparse(url).path.startswith("/api/webhooks/"):
        return "discord"
    return None


def chat_text(payload: dict) -> tuple[str, str]:
    """(título, texto) legible del evento."""
    from app.email import build_url

    survey = payload.get("survey") or {}
    titulo = survey.get("title") or "Encuesta"
    if payload.get("event") == "ping":
        return "Encuestum", f"Prueba de conexión desde Encuestum para «{titulo}». Funciona."
    r = payload.get("response") or {}
    partes = [f"Nueva respuesta en «{titulo}»"]
    if r.get("score") is not None and r.get("max_score"):
        partes.append(f"puntaje {r['score']:g}/{r['max_score']:g}"
                      + (f" ({r['percent']:.0f}%)" if r.get("percent") is not None else ""))
    if r.get("needs_review"):
        partes.append("necesita revisión")
    link = build_url(f"/surveys/{survey.get('id')}") if survey.get("id") else ""
    return titulo, " · ".join(partes) + (f"\n{link}" if link else "")


def chat_body(kind: str, payload: dict) -> dict:
    titulo, texto = chat_text(payload)
    if kind == "slack":
        return {"text": texto}
    if kind == "discord":
        return {"content": texto[:2000]}
    if kind == "teams":
        return {"@type": "MessageCard", "@context": "https://schema.org/extensions",
                "summary": titulo, "title": titulo, "text": texto.replace("\n", "  \n")}
    # Flujos de trabajo de Teams (Power Automate): tarjeta adaptable.
    return {"type": "message", "attachments": [{
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {"type": "AdaptiveCard", "version": "1.4",
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "body": [{"type": "TextBlock", "text": t, "wrap": True} for t in texto.split("\n")]},
    }]}


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

    kind = chat_kind(url)
    if kind:
        payload = chat_body(kind, payload)
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


async def fanout_job(payload: dict, ctx) -> dict:
    """Handler `webhooks.fanout`: una tarea de entrega por webhook activo. Se
    abre en una por destino para que un receptor caído no frene ni haga
    reintentar a los demás."""
    from app import jobs
    from app.db import _session_maker
    from app.models import Survey, Webhook

    sid = uuid.UUID(payload["survey_id"])
    rid = uuid.UUID(payload["response_id"])
    async with _session_maker() as session:
        survey = await session.get(Survey, sid)
        if survey is None:
            return {"hooks": 0}
        hooks = (
            await session.scalars(
                select(Webhook).where(
                    Webhook.org_id == survey.org_id,
                    Webhook.active == True,  # noqa: E712
                    or_(Webhook.survey_id == survey.id, Webhook.survey_id.is_(None)),
                )
            )
        ).all()
        for h in hooks:
            jobs.enqueue(
                session, "webhook.deliver",
                {"webhook_id": str(h.id), "survey_id": str(sid), "response_id": str(rid), "url": h.url},
                org_id=survey.org_id, survey_id=sid, response_id=rid,
            )
        await session.commit()
    return {"hooks": len(hooks)}


async def deliver_job(payload: dict, ctx) -> dict:
    """Handler `webhook.deliver`: levanta si el receptor no aceptó, para que la
    cola reintente. Lee la respuesta al momento de enviar: si la nota cambió
    entre que se encoló y que salió, sale la última."""
    from app.db import _session_maker
    from app.models import Survey, SurveyResponse, Webhook

    async with _session_maker() as session:
        hook = await session.get(Webhook, uuid.UUID(payload["webhook_id"]))
        survey = await session.get(Survey, uuid.UUID(payload["survey_id"]))
        resp = await session.get(SurveyResponse, uuid.UUID(payload["response_id"]))
        if not hook or not hook.active or not survey or not resp:
            return {"skipped": True}
        url, secret = hook.url, hook.secret
        body = build_payload(survey, resp)
    if not await post_webhook(url, secret, body):
        raise RuntimeError(f"el webhook {url} no aceptó la entrega")
    return {"delivered": True}


def schedule_response_delivery(survey_id, response_id, session=None) -> None:
    """Encola la entrega a los webhooks; nunca levanta hacia el request.

    Con `session`, dentro de esa transacción (ver `app/jobs.py`)."""
    from app import jobs
    from app.config import get_settings

    if not get_settings().webhooks_enabled:
        return
    try:
        sid = survey_id if isinstance(survey_id, uuid.UUID) else uuid.UUID(str(survey_id))
        rid = response_id if isinstance(response_id, uuid.UUID) else uuid.UUID(str(response_id))
        payload = {"survey_id": str(sid), "response_id": str(rid)}
        kw = dict(survey_id=sid, response_id=rid)
        if session is not None:
            jobs.enqueue(session, "webhooks.fanout", payload, **kw)
        else:
            jobs.enqueue_detached("webhooks.fanout", payload, **kw)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("could not schedule webhook delivery: %s", exc)
