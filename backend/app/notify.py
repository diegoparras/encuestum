"""Fire-and-forget email notifications to survey owners on each new response.
No DB access in the background task (all data is passed in), so it can't contend
with the request's session."""

import logging
import uuid

from app.email import build_url

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


def schedule_response_notification(
    raw_emails: str | None, title: str | None, survey_id: uuid.UUID, count: int, session=None
) -> None:
    """Un email por destinatario, encolado (con reintentos) en la transacción
    de `session`; sin sesión, en segundo plano como red de seguridad."""
    from app import jobs

    emails = parse_emails(raw_emails)
    if not emails:
        return
    title = title or "una encuesta"
    link = build_url(f"/surveys/{survey_id}")
    subject = f"Nueva respuesta: {title}"
    text = (
        f"Recibiste una nueva respuesta en «{title}».\n"
        f"Respuestas totales: {count}.\n\n"
        f"Vela acá:\n{link}\n"
    )
    for e in emails:
        payload = {"to": e, "subject": subject, "text": text}
        if session is not None:
            jobs.enqueue(session, "email.send", payload, survey_id=survey_id)
        else:
            jobs.enqueue_detached("email.send", payload, survey_id=survey_id)
