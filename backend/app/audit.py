"""Trazabilidad: versiones de encuesta, historial de notas, auditoría e integridad.

Tres preguntas que antes no tenían respuesta y ahora sí:

* ¿Qué encuesta contestó esta persona? -> `ensure_survey_version` congela la
  estructura y la rúbrica en una `SurveyVersion` y la respuesta apunta a ella.
* ¿Quién cambió esta nota, cuándo y desde qué valor? -> `record_grade_revision`.
* ¿Quién hizo qué sobre esta encuesta? -> `record_event`.

Ninguna función hace commit: se suman a la transacción del endpoint, así el
rastro y el cambio que describe se persisten juntos o no se persiste ninguno.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import uuid
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models import AuditEvent, GradeRevision, SurveyVersion


def canonical_hash(obj: Any) -> str:
    """SHA-256 de una serialización estable (claves ordenadas, sin espacios)."""
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def survey_content_hash(s) -> str:
    """Huella de lo que se edita en el editor. Distinta de la de versión (que
    sólo mira estructura y rúbrica): acá también cuentan título y diseño,
    porque pisar esos cambios ajenos también es perder trabajo."""
    return canonical_hash(
        {"title": s.title, "schema": s.json_schema or {}, "evaluation": s.evaluation or None,
         "theme": s.theme or None}
    )[:16]


def _survey_content(s) -> dict:
    return {"schema": s.json_schema or {}, "evaluation": s.evaluation or None}


async def ensure_survey_version(session: AsyncSession, s) -> SurveyVersion:
    """La versión que corresponde al contenido ACTUAL de la encuesta.

    Perezosa: si ya hay una versión con el mismo contenido se reutiliza (aunque
    no sea la última: deshacer una edición vuelve a la versión de antes), y si
    no, se crea la siguiente. Dos envíos simultáneos pueden intentar crear el
    mismo número; el que pierde la carrera choca con el UNIQUE, se deshace sólo
    su savepoint y relee la que creó el otro."""
    h = canonical_hash(_survey_content(s))
    for _ in range(3):
        existing = (
            await session.scalars(
                select(SurveyVersion)
                .where(SurveyVersion.survey_id == s.id, SurveyVersion.content_hash == h)
                .order_by(SurveyVersion.number.desc())
                .limit(1)
            )
        ).first()
        if existing is not None:
            return existing
        latest = await session.scalar(
            select(SurveyVersion.number)
            .where(SurveyVersion.survey_id == s.id)
            .order_by(SurveyVersion.number.desc())
            .limit(1)
        )
        v = SurveyVersion(
            survey_id=s.id,
            number=(latest or 0) + 1,
            json_schema=copy.deepcopy(s.json_schema or {}),
            evaluation=copy.deepcopy(s.evaluation) if s.evaluation else None,
            content_hash=h,
        )
        try:
            async with session.begin_nested():
                session.add(v)
            return v
        except IntegrityError:
            continue
    raise RuntimeError("No se pudo registrar la versión de la encuesta")


def _actor(actor) -> tuple[Optional[uuid.UUID], Optional[str]]:
    if actor is None:
        return None, None
    return getattr(actor, "id", None), getattr(actor, "email", None)


def record_event(
    session: AsyncSession,
    *,
    action: str,
    org_id: Optional[uuid.UUID],
    actor=None,
    survey_id: Optional[uuid.UUID] = None,
    response_id: Optional[uuid.UUID] = None,
    detail: Optional[dict] = None,
) -> AuditEvent:
    actor_id, actor_email = _actor(actor)
    ev = AuditEvent(
        org_id=org_id,
        survey_id=survey_id,
        response_id=response_id,
        actor_id=actor_id,
        actor_email=actor_email,
        action=action,
        detail=detail,
    )
    session.add(ev)
    return ev


def record_grade_revision(
    session: AsyncSession,
    r,
    *,
    source: str,
    grade_before: Optional[dict],
    actor=None,
    survey_version_id: Optional[uuid.UUID] = None,
    note: Optional[str] = None,
) -> GradeRevision:
    """Deja asentado el estado de la nota DESPUÉS del cambio, junto al de antes.

    Llamar después de asignar `r.grade`. `grade_before` va copiado: el `grade`
    es un JSON mutable y el que lo modifique después no puede reescribir la
    historia."""
    actor_id, actor_email = _actor(actor)
    before_score = (grade_before or {}).get("total") if grade_before else None
    rev = GradeRevision(
        response_id=r.id,
        survey_id=r.survey_id,
        source=source,
        actor_id=actor_id,
        actor_email=actor_email,
        score_before=before_score,
        score_after=r.score,
        max_score=r.max_score,
        grade_before=copy.deepcopy(grade_before) if grade_before else None,
        grade_after=copy.deepcopy(r.grade) if r.grade else None,
        survey_version_id=survey_version_id,
        note=note,
    )
    session.add(rev)
    return rev


# ── Integridad de la respuesta ───────────────────────────────────────────────


def response_hash(r) -> str:
    """Huella de lo que contestó la persona: si alguien edita las respuestas o
    la fecha directo en la base, deja de coincidir. No incluye la nota, que
    tiene su propio historial y cambia legítimamente."""
    submitted = r.submitted_at.isoformat() if r.submitted_at else None
    return canonical_hash(
        {
            "id": str(r.id),
            "survey_id": str(r.survey_id),
            "survey_version_id": str(r.survey_version_id) if r.survey_version_id else None,
            "answers": r.answers or {},
            "submitted_at": submitted,
        }
    )


def verify_response(r) -> Optional[bool]:
    """True/False si se puede verificar; None si la respuesta es anterior a la
    huella (no hay con qué comparar)."""
    if not r.integrity_hash:
        return None
    return hmac.compare_digest(r.integrity_hash, response_hash(r))


# ── Metadatos de la respuesta ────────────────────────────────────────────────

# Lo único que el navegador puede aportar a `meta`. Antes se guardaba cualquier
# JSON que mandara el cliente, sin límite de claves ni de tamaño.
_CLIENT_META_KEYS = {"locale", "referrer", "visitor_id", "timezone", "screen", "started_at"}
_MAX_META_VALUE = 512


def sanitize_client_meta(meta: Optional[dict]) -> dict:
    out: dict = {}
    for k, v in (meta or {}).items():
        if k not in _CLIENT_META_KEYS:
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v[:_MAX_META_VALUE] if isinstance(v, str) else v
    return out


def hash_ip(ip: str, secret: str) -> Optional[str]:
    """Seudónimo de la IP: permite ver "estas 40 respuestas vinieron de la misma
    conexión" sin guardar la IP. HMAC con el secreto de sesión del servidor:
    sin él no se puede recorrer el espacio de IPv4 para revertirlo."""
    if not ip or ip == "unknown":
        return None
    return hmac.new(secret.encode(), ip.encode(), hashlib.sha256).hexdigest()[:32]
