"""Fire-and-forget email notifications to survey owners on each new response.
No DB access in the background task (all data is passed in), so it can't contend
with the request's session."""

import asyncio
import logging
import uuid

from app.email import build_url, send_email

LOGGER = logging.getLogger(__name__)


def parse_emails(raw: str | None) -> list[str]:
    if not raw:
        return []
    seen: list[str] = []
    for part in raw.replace(";", ",").replace("\n", ",").split(","):
        e = part.strip().lower()
        if e and "@" in e and e not in seen:
            seen.append(e)
    return seen


async def _send(emails: list[str], title: str, survey_id: str, count: int) -> None:
    link = build_url(f"/surveys/{survey_id}")
    subject = f"Nueva respuesta: {title}"
    text = (
        f"Recibiste una nueva respuesta en «{title}».\n"
        f"Respuestas totales: {count}.\n\n"
        f"Vela acá:\n{link}\n"
    )
    for e in emails:
        try:
            await send_email(e, subject, text)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("notify email a %s falló: %s", e, exc)


def schedule_response_notification(
    raw_emails: str | None, title: str | None, survey_id: uuid.UUID, count: int
) -> None:
    emails = parse_emails(raw_emails)
    if not emails:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_send(emails, title or "una encuesta", str(survey_id), count))
