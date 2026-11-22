"""Distribución: invitaciones con seguimiento y recordatorios automáticos.

Seguimiento de cada invitado (en `SurveyInvitee`):

* **enviada** (`sent_at`): se encoló el email.
* **abierta** (`opened_at`): el cliente de correo cargó el píxel del email.
  Es un indicio: muchos clientes bloquean imágenes (o las precargan todas), así
  que «no abrió» no quiere decir que no lo vio. Si entró, cuenta como abierta.
* **clic** (`used_at`): entró con su enlace.
* **respondió** (`responded_at`): envió la encuesta.

Recordatorios: `Survey.reminders = {"enabled": true, "every_days": 3, "max": 2}`.
El mantenimiento periódico (`app/jobs.py`) le escribe a quien ya recibió la
invitación y no respondió, cada `every_days` días, hasta `max` veces, mientras
la encuesta esté abierta.
"""

from __future__ import annotations

import html as html_mod
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models import Survey, SurveyInvitee

OPEN_PURPOSE = "invite_open"
_PIXEL_TTL_H = 24 * 120
_MAX_REMINDERS = 5
# Un GIF transparente de 1x1.
PIXEL_GIF = bytes.fromhex(
    "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(d: Optional[datetime]) -> Optional[datetime]:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def clean_reminders(raw) -> Optional[dict]:
    if not raw:
        return None
    if not isinstance(raw, dict):
        raise ValueError("Configuración de recordatorios inválida.")
    try:
        every = int(raw.get("every_days") or 3)
        maximo = int(raw.get("max") or 2)
    except (TypeError, ValueError):
        raise ValueError("Los recordatorios llevan días y cantidad enteros.")
    if not 1 <= every <= 60:
        raise ValueError("Los recordatorios van cada 1 a 60 días.")
    if not 1 <= maximo <= _MAX_REMINDERS:
        raise ValueError(f"Se pueden mandar de 1 a {_MAX_REMINDERS} recordatorios.")
    return {"enabled": bool(raw.get("enabled", True)), "every_days": every, "max": maximo}


def open_pixel_url(inv: SurveyInvitee) -> str:
    from app.config import get_settings
    from app.security import create_purpose_token

    tok = create_purpose_token(OPEN_PURPOSE, {"i": str(inv.id)}, ttl_hours=_PIXEL_TTL_H)
    base = get_settings().public_api_base_url.rstrip("/")
    return f"{base}/api/v1/survey/public/track/open/{tok}.gif"


def invite_message(s: Survey, inv: SurveyInvitee, *, reminder: bool = False) -> tuple[str, str, str]:
    """(asunto, texto, html) de la invitación o del recordatorio."""
    from app.email import build_url

    title = s.title or "una encuesta"
    link = build_url(f"/s/{s.slug}", email=inv.email, code=inv.code)
    saludo = f"Hola{(' ' + inv.name) if inv.name else ''},"
    if reminder:
        subject = f"Recordatorio: {title}"
        cuerpo = f"Todavía no respondiste «{title}». Te lleva unos minutos."
    else:
        subject = f"Invitación: {title}"
        cuerpo = f"Fuiste invitado/a a responder «{title}»."
    cierre = ""
    if s.closes_at:
        cierre = f"Cierra el {_aware(s.closes_at).strftime('%d/%m/%Y')}.\n"
    text = (
        f"{saludo}\n\n{cuerpo}\nIngresá con este enlace:\n{link}\n\n"
        f"Tu código de acceso es: {inv.code}\n{cierre}"
    )
    e = html_mod.escape
    html = (
        f"<p>{e(saludo)}</p><p>{e(cuerpo)}</p>"
        f'<p><a href="{e(link)}" style="display:inline-block;padding:10px 18px;background:#4f46e5;'
        f'color:#fff;border-radius:8px;text-decoration:none">Responder</a></p>'
        f"<p>Tu código de acceso es: <b>{e(inv.code)}</b></p>"
        + (f"<p>{e(cierre.strip())}</p>" if cierre else "")
        + f'<img src="{e(open_pixel_url(inv))}" width="1" height="1" alt="" style="display:none">'
    )
    return subject, text, html


def enqueue_invite(session: AsyncSession, s: Survey, inv: SurveyInvitee, *, reminder: bool = False) -> None:
    from app import jobs

    subject, text, html = invite_message(s, inv, reminder=reminder)
    jobs.enqueue(
        session, "email.send", {"to": inv.email, "subject": subject, "text": text, "html": html},
        org_id=s.org_id, survey_id=s.id,
    )


async def mark_opened(session: AsyncSession, token: str) -> bool:
    import uuid

    from app.security import read_purpose_token

    data = read_purpose_token(OPEN_PURPOSE, token or "")
    if not data or not data.get("i"):
        return False
    try:
        inv = await session.get(SurveyInvitee, uuid.UUID(data["i"]))
    except ValueError:
        return False
    if inv is None or inv.opened_at is not None:
        return inv is not None
    inv.opened_at = _now()
    session.add(inv)
    await session.commit()
    return True


async def mark_responded(session: AsyncSession, survey_id, code: Optional[str], *, day_only: bool = False) -> None:
    """Dentro de la transacción del envío."""
    if not code:
        return
    inv = (await session.scalars(
        select(SurveyInvitee).where(SurveyInvitee.survey_id == survey_id, SurveyInvitee.code == code)
    )).first()
    if inv is not None and inv.responded_at is None:
        ahora = _now()
        if day_only:
            ahora = ahora.replace(hour=0, minute=0, second=0, microsecond=0)
        inv.responded_at = ahora
        inv.used_at = inv.used_at or ahora
        session.add(inv)


def is_open(s: Survey, now: datetime) -> bool:
    if s.status != "published" or s.deleted_at is not None:
        return False
    if s.opens_at and _aware(s.opens_at) > now:
        return False
    if s.closes_at and _aware(s.closes_at) < now:
        return False
    return True


def due_reminder(inv: SurveyInvitee, cfg: dict, now: datetime) -> bool:
    if inv.sent_at is None or inv.responded_at is not None:
        return False
    if (inv.reminders_sent or 0) >= cfg["max"]:
        return False
    ultimo = _aware(inv.last_reminded_at) or _aware(inv.sent_at)
    return now - ultimo >= timedelta(days=cfg["every_days"])


async def send_due_reminders(session: AsyncSession, *, now: Optional[datetime] = None) -> dict:
    """Encola los recordatorios que tocan. Idempotente dentro del intervalo:
    `last_reminded_at` se mueve en la misma transacción que el encolado."""
    from app.config import get_settings

    if not get_settings().smtp_configured:
        return {"reminders": 0, "skipped": "smtp"}
    now = now or _now()
    surveys = (await session.scalars(
        select(Survey).where(Survey.access_mode == "list", Survey.reminders.is_not(None))
    )).all()
    n = 0
    for s in surveys:
        try:
            cfg = clean_reminders(s.reminders)
        except ValueError:
            continue
        if not cfg or not cfg["enabled"] or not is_open(s, now):
            continue
        invitados = (await session.scalars(
            select(SurveyInvitee).where(
                SurveyInvitee.survey_id == s.id,
                SurveyInvitee.sent_at.is_not(None),
                SurveyInvitee.responded_at.is_(None),
            )
        )).all()
        for inv in invitados:
            if not due_reminder(inv, cfg, now):
                continue
            enqueue_invite(session, s, inv, reminder=True)
            inv.reminders_sent = (inv.reminders_sent or 0) + 1
            inv.last_reminded_at = now
            session.add(inv)
            n += 1
    await session.commit()
    return {"reminders": n}


def tracking_summary(invitees: list[SurveyInvitee]) -> dict:
    total = len(invitees)
    enviadas = sum(1 for i in invitees if i.sent_at)
    abiertas = sum(1 for i in invitees if i.opened_at or i.used_at)
    clics = sum(1 for i in invitees if i.used_at)
    respondieron = sum(1 for i in invitees if i.responded_at)
    return {
        "total": total, "sent": enviadas, "opened": abiertas, "clicked": clics,
        "responded": respondieron,
        "reminders": sum(i.reminders_sent or 0 for i in invitees),
        "response_rate": round(respondieron / enviadas, 3) if enviadas else None,
    }
