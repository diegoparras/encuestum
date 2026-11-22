"""Privacidad: anonimato garantizado, retención y derechos de cada persona.

* **Anonimato garantizado** (`Survey.anonymous`): el servidor no guarda email,
  código de invitado, sub del LMS, IP (ni su hash), navegador ni identificador
  de visitante con la respuesta. Lo decide el servidor, no el formulario: un
  navegador que mande `visitor_id` igual no lo ve guardado.
* **Retención**: a los N días de enviada, una respuesta se anonimiza (se le
  quita la identidad y las preguntas que identifican) o se borra. Se configura
  por encuesta, con un valor por defecto de la organización. Corre en el
  mantenimiento periódico de la cola (`app/jobs.py`).
* **Derechos de la persona**: buscar todo lo que hay de un email en la
  organización, exportarlo y borrarlo (o anonimizarlo), con rastro en la
  auditoría.

Anonimizar cambia las respuestas, así que se recalcula la huella de integridad
y el cambio queda en la auditoría con la huella anterior: un control posterior
no lo confunde con una edición por fuera de la aplicación.
"""

from __future__ import annotations

import copy
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models import (
    Organization,
    ResponseDeletion,
    Survey,
    SurveyAttempt,
    SurveyDraft,
    SurveyInvitee,
    SurveyResponse,
)

RETENTION_ACTIONS = ("anonymize", "delete")
_MAX_RETENTION_DAYS = 3650
_IDENTITY_SERVER_KEYS = ("ip_hash", "user_agent")
_IDENTITY_META_KEYS = ("visitor_id", "referrer")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(d: Optional[datetime]) -> Optional[datetime]:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ── Anonimato ───────────────────────────────────────────────────────────────


def strip_identity_meta(meta: Optional[dict]) -> dict:
    """Los metadatos sin nada que permita reconocer a la persona."""
    m = copy.deepcopy(meta or {})
    for k in _IDENTITY_META_KEYS:
        m.pop(k, None)
    server = m.get("server")
    if isinstance(server, dict):
        for k in _IDENTITY_SERVER_KEYS:
            server.pop(k, None)
    return m


def identifying_questions(schema: dict) -> set[str]:
    """Preguntas cuya respuesta identifica a la persona: las de email o
    teléfono, la firma y las que `app.identity` reconoce como nombre/email."""
    from app.identity import identity_fields

    out: set[str] = set()
    for p in (schema or {}).get("pages", []) or []:
        if not isinstance(p, dict):
            continue
        for el in p.get("elements", []) or []:
            if not isinstance(el, dict) or not el.get("name"):
                continue
            if el.get("type") in ("signaturepad", "file") or el.get("inputType") in ("email", "tel"):
                out.add(el["name"])
    nombre, mail = identity_fields(schema or {})
    out.update(x for x in (nombre, mail) if x)
    return out


def anonymize_response(session: AsyncSession, r: SurveyResponse, schema: dict, *, reason: str, actor=None, org_id=None) -> bool:
    """Quita la identidad de una respuesta (no la borra: sigue contando en las
    estadísticas). Devuelve False si ya estaba anonimizada."""
    from app.audit import record_event, response_hash

    if (r.meta or {}).get("anonymized_at"):
        return False
    previo = r.integrity_hash
    quitar = identifying_questions(schema)
    r.answers = {k: v for k, v in (r.answers or {}).items() if k not in quitar}
    r.respondent_email = None
    r.respondent_code = None
    r.lti_sub = None
    meta = strip_identity_meta(r.meta)
    meta["anonymized_at"] = _now().isoformat()
    meta["anonymized_reason"] = reason
    r.meta = meta
    if previo:
        r.integrity_hash = response_hash(r)
    session.add(r)
    record_event(
        session, action="response.anonymized", org_id=org_id, actor=actor,
        survey_id=r.survey_id, response_id=r.id,
        detail={"reason": reason, "removed_questions": sorted(quitar),
                "integrity_hash_before": previo, "integrity_hash_after": r.integrity_hash},
    )
    return True


def delete_response(session: AsyncSession, r: SurveyResponse, *, reason: str, actor=None, org_id=None, respondent: Optional[str] = None) -> None:
    """Borra con rastro (igual que el borrado manual del panel)."""
    from app.audit import _actor, record_event

    actor_id, actor_email = _actor(actor)
    record_event(
        session, action="response.deleted", org_id=org_id, actor=actor,
        survey_id=r.survey_id, response_id=r.id,
        detail={"reason": reason, "respondent": respondent or r.respondent_email,
                "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
                "integrity_hash": r.integrity_hash},
    )
    session.add(ResponseDeletion(
        survey_id=r.survey_id, response_id=r.id, deleted_by=actor_id,
        deleted_by_email=actor_email or f"sistema ({reason})",
        respondent=respondent or r.respondent_email, submitted_at=r.submitted_at,
    ))


# ── Retención ───────────────────────────────────────────────────────────────


def clean_retention(days, action) -> tuple[Optional[int], Optional[str]]:
    """Valida y normaliza (días, acción). (None, None) = sin retención."""
    if days in (None, "", 0):
        return None, None
    try:
        d = int(days)
    except (TypeError, ValueError):
        raise ValueError("Los días de retención tienen que ser un número entero.")
    if d < 1 or d > _MAX_RETENTION_DAYS:
        raise ValueError(f"La retención va de 1 a {_MAX_RETENTION_DAYS} días.")
    a = action or "anonymize"
    if a not in RETENTION_ACTIONS:
        raise ValueError("La acción de retención es «anonymize» o «delete».")
    return d, a


def effective_retention(s: Survey, org: Optional[Organization]) -> tuple[Optional[int], Optional[str]]:
    if s.retention_days:
        return s.retention_days, s.retention_action or "anonymize"
    if org is not None and org.retention_days:
        return org.retention_days, org.retention_action or "anonymize"
    return None, None


async def apply_retention(session: AsyncSession, *, now: Optional[datetime] = None, batch: int = 500) -> dict:
    """Aplica la retención vencida de todas las encuestas. Idempotente: una
    respuesta ya anonimizada no se vuelve a tocar."""
    now = now or _now()
    orgs = {o.id: o for o in (await session.scalars(select(Organization))).all()}
    surveys = (await session.scalars(
        select(Survey).where(or_(Survey.retention_days.is_not(None),
                                 Survey.org_id.in_([o.id for o in orgs.values() if o.retention_days] or [uuid.uuid4()])))
    )).all()
    anon = borradas = 0
    for s in surveys:
        dias, accion = effective_retention(s, orgs.get(s.org_id))
        if not dias:
            continue
        limite = now - timedelta(days=dias)
        rows = (await session.scalars(
            select(SurveyResponse)
            .where(SurveyResponse.survey_id == s.id, SurveyResponse.submitted_at < limite)
            .limit(batch)
        )).all()
        for r in rows:
            if accion == "delete":
                delete_response(session, r, reason=f"retención {dias} días", org_id=s.org_id)
                await session.delete(r)
                borradas += 1
            elif anonymize_response(session, r, s.json_schema or {}, reason=f"retención {dias} días", org_id=s.org_id):
                anon += 1
    await session.commit()
    return {"anonymized": anon, "deleted": borradas}


# ── Derechos de la persona ──────────────────────────────────────────────────


async def find_person(session: AsyncSession, org_id: uuid.UUID, email: str) -> dict:
    """Todo lo que la organización tiene de `email`: respuestas (por email del
    invitado/LMS o porque la escribió en una pregunta de email), invitaciones,
    borradores e intentos."""
    from app.identity import respondent_identity

    email = (email or "").strip().lower()
    surveys = {s.id: s for s in (await session.scalars(select(Survey).where(Survey.org_id == org_id))).all()}
    ids = list(surveys) or [uuid.uuid4()]
    respuestas: list[SurveyResponse] = []
    for r in (await session.scalars(select(SurveyResponse).where(SurveyResponse.survey_id.in_(ids)))).all():
        if (r.respondent_email or "").lower() == email:
            respuestas.append(r)
            continue
        _, mail = respondent_identity(surveys[r.survey_id].json_schema or {}, r.answers or {})
        if mail and mail.strip().lower() == email:
            respuestas.append(r)
    invitados = (await session.scalars(
        select(SurveyInvitee).where(SurveyInvitee.survey_id.in_(ids), SurveyInvitee.email == email)
    )).all()
    codigos = {i.code for i in invitados}
    claves_borrador = {f"inv:{c}" for c in codigos} or {"-"}
    borradores = (await session.scalars(
        select(SurveyDraft).where(SurveyDraft.survey_id.in_(ids), SurveyDraft.key.in_(claves_borrador))
    )).all()
    intentos = (await session.scalars(
        select(SurveyAttempt).where(SurveyAttempt.survey_id.in_(ids),
                                    SurveyAttempt.response_id.in_([r.id for r in respuestas] or [uuid.uuid4()]))
    )).all()
    return {"email": email, "surveys": surveys, "responses": respuestas,
            "invitees": list(invitados), "drafts": list(borradores), "attempts": list(intentos)}


def person_export(found: dict) -> dict:
    """La copia de los datos de una persona (derecho de acceso/portabilidad)."""
    surveys = found["surveys"]

    def titulo(sid):
        s = surveys.get(sid)
        return (s.title if s else None) or "(sin título)"

    return {
        "email": found["email"],
        "generated_at": _now().isoformat(),
        "responses": [{
            "survey_id": str(r.survey_id), "survey": titulo(r.survey_id), "response_id": str(r.id),
            "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            "answers": r.answers or {}, "score": r.score, "max_score": r.max_score,
            "grade": r.grade, "meta": strip_identity_meta(r.meta) | {"server": {
                k: v for k, v in ((r.meta or {}).get("server") or {}).items() if k not in ("ip_hash",)}},
        } for r in found["responses"]],
        "invitations": [{
            "survey_id": str(i.survey_id), "survey": titulo(i.survey_id), "name": i.name,
            "sent_at": i.sent_at.isoformat() if i.sent_at else None,
            "opened_at": i.opened_at.isoformat() if i.opened_at else None,
            "used_at": i.used_at.isoformat() if i.used_at else None,
            "responded_at": i.responded_at.isoformat() if i.responded_at else None,
        } for i in found["invitees"]],
        "drafts": [{"survey_id": str(d.survey_id), "survey": titulo(d.survey_id), "answers": d.answers,
                    "updated_at": d.updated_at.isoformat() if d.updated_at else None} for d in found["drafts"]],
    }


async def person_erase(session: AsyncSession, found: dict, *, mode: str, actor, org_id) -> dict:
    """Borra (o anonimiza) todo lo de la persona. Las invitaciones y los
    borradores se borran siempre: no sirven sin la persona."""
    from app.audit import record_event

    surveys = found["surveys"]
    n_resp = 0
    for r in found["responses"]:
        if mode == "anonymize":
            if anonymize_response(session, r, (surveys.get(r.survey_id).json_schema if surveys.get(r.survey_id) else {}) or {},
                                  reason="pedido de la persona", actor=actor, org_id=org_id):
                n_resp += 1
        else:
            delete_response(session, r, reason="pedido de la persona", actor=actor, org_id=org_id, respondent=found["email"])
            await session.delete(r)
            n_resp += 1
    for a in found["attempts"]:
        if mode != "anonymize":
            await session.delete(a)
    for obj in list(found["invitees"]) + list(found["drafts"]):
        await session.delete(obj)
    record_event(session, action="person.erased", org_id=org_id, actor=actor,
                 detail={"email_hash": _email_hash(found["email"]), "mode": mode, "responses": n_resp,
                         "invitations": len(found["invitees"]), "drafts": len(found["drafts"])})
    await session.commit()
    return {"responses": n_resp, "invitations": len(found["invitees"]), "drafts": len(found["drafts"]), "mode": mode}


def _email_hash(email: str) -> str:
    """En la auditoría del borrado no queda el email en claro (sería guardar
    justo lo que se pidió borrar), sino su huella: alcanza para responder
    «¿borraron lo de tal persona?» sin volver a tener el dato."""
    import hashlib

    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]


def summarize_found(found: dict) -> dict:
    surveys = found["surveys"]
    por: dict = {}
    for r in found["responses"]:
        por.setdefault(r.survey_id, {"responses": 0, "invited": False})["responses"] += 1
    for i in found["invitees"]:
        por.setdefault(i.survey_id, {"responses": 0, "invited": False})["invited"] = True
    return {
        "email": found["email"],
        "responses": len(found["responses"]),
        "invitations": len(found["invitees"]),
        "drafts": len(found["drafts"]),
        "surveys": [{"survey_id": str(sid), "title": (surveys[sid].title if sid in surveys else None),
                     **v} for sid, v in por.items()],
    }
