"""Email delivery. Uses SMTP if configured; otherwise logs the message (with
the link) so invite / reset / verify flows stay usable without an SMTP server."""

import asyncio
import logging
import smtplib
from email.message import EmailMessage
from urllib.parse import quote

from app.config import get_settings

LOGGER = logging.getLogger("encuestum.email")


def build_url(path: str, **query: str) -> str:
    s = get_settings()
    url = f"{s.public_base_url}{path}"
    if query:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in query.items())
        url = f"{url}?{qs}"
    return url


def _send_sync(to: str, subject: str, text: str, html: str | None) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["From"] = s.email_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as server:
        if s.smtp_tls:
            server.starttls()
        if s.smtp_user and s.smtp_password:
            server.login(s.smtp_user, s.smtp_password)
        server.send_message(msg)


async def send_email(to: str, subject: str, text: str, html: str | None = None) -> None:
    s = get_settings()
    if not s.smtp_configured:
        # Dev/degraded mode: surface the content (and any link) in the logs.
        LOGGER.info("EMAIL (no SMTP) → %s | %s\n%s", to, subject, text)
        return
    try:
        await asyncio.to_thread(_send_sync, to, subject, text, html)
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("No se pudo enviar el email a %s: %s", to, exc)
        raise


# ── Templates ────────────────────────────────────────────────────────────────
async def send_invite_email(to: str, org_name: str, accept_url: str) -> None:
    text = (
        f"Te invitaron a unirte a la organización «{org_name}» en Encuestum.\n\n"
        f"Aceptá la invitación acá:\n{accept_url}\n\n"
        "Si no esperabas esta invitación, podés ignorar este mensaje."
    )
    await send_email(to, f"Invitación a {org_name} en Encuestum", text)


async def send_reset_email(to: str, reset_url: str) -> None:
    text = (
        "Recibimos un pedido para restablecer tu contraseña en Encuestum.\n\n"
        f"Restablecela acá (el enlace vence pronto):\n{reset_url}\n\n"
        "Si no fuiste vos, ignorá este mensaje: tu contraseña no cambia."
    )
    await send_email(to, "Restablecer tu contraseña · Encuestum", text)


async def send_verify_email(to: str, verify_url: str) -> None:
    text = (
        "¡Bienvenido/a a Encuestum! Confirmá tu email para activar tu cuenta.\n\n"
        f"Verificá acá:\n{verify_url}"
    )
    await send_email(to, "Verificá tu email · Encuestum", text)
