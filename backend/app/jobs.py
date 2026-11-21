"""Cola de tareas persistente, guardada en la propia base de datos.

Antes, webhooks, notas al LMS y emails salían con `asyncio.create_task` sueltos:
si el proceso se reiniciaba se perdían, si fallaban sólo quedaba una línea en el
log y nadie se enteraba. Ahora cada una es una fila de `jobs`:

* **Persistente.** Se encola dentro de la misma transacción que la causa
  (`enqueue` no hace commit): si el cambio se guarda, la tarea también, y no
  hay ventana entre una cosa y la otra.
* **Con reintentos.** Si el handler levanta, se reintenta con espera creciente
  (30 s, 1 min, 2 min, … hasta 1 h) hasta `max_attempts`; después queda en
  `failed` con su último error, a la vista en el panel.
* **Recuperable.** Una tarea que quedó `running` porque el proceso murió a la
  mitad vuelve a `pending` pasado `STALE_AFTER`.

Por qué no Redis/arq/RQ: Encuestum es una sola imagen que corre igual con
SQLite que con Postgres, y Redis es opcional. Una tabla alcanza para el volumen
de una instancia self-hosted y no suma ninguna pieza más para operar.

Varios workers pueden convivir: cada uno "reclama" una tarea con un UPDATE
condicionado a `status = 'pending'` y sólo sigue si le tocó la fila.

Los handlers reciben el `payload` y LEVANTAN si algo salió mal: el reintento
vive acá, en un solo lugar, y no en cada handler.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.models import JOB_DONE, JOB_FAILED, JOB_PENDING, JOB_RUNNING, Job

LOGGER = logging.getLogger("encuestum.jobs")

STALE_AFTER = timedelta(minutes=15)
_BACKOFF_BASE_S = 30
_BACKOFF_MAX_S = 3600
_IDLE_SLEEP_S = 1.0

# kind -> "modulo:funcion". Import perezoso: los handlers tocan LTI, email,
# corrección... y cargarlos todos al importar este módulo crearía ciclos.
HANDLERS: dict[str, str] = {
    "lms.grade": "app.lti.ags:deliver_job",
    "webhooks.fanout": "app.webhooks:fanout_job",
    "webhook.deliver": "app.webhooks:deliver_job",
    "email.send": "app.email:send_job",
    "grades.regrade_all": "app.routers.evaluation:regrade_all_job",
    "grade.response": "app.routers.evaluation:grade_response_job",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def backoff(attempts: int) -> timedelta:
    """Espera antes del reintento número `attempts` (1, 2, 3...)."""
    return timedelta(seconds=min(_BACKOFF_MAX_S, _BACKOFF_BASE_S * 2 ** max(0, attempts - 1)))


def enqueue(
    session: AsyncSession,
    kind: str,
    payload: Optional[dict] = None,
    *,
    org_id: Optional[uuid.UUID] = None,
    survey_id: Optional[uuid.UUID] = None,
    response_id: Optional[uuid.UUID] = None,
    dedupe_key: Optional[str] = None,
    max_attempts: int = 6,
    delay: Optional[timedelta] = None,
) -> Job:
    """Agrega una tarea a la transacción en curso (NO hace commit).

    Sincrónica a propósito: se llama desde puntos que ya existían y no eran
    `async` (`schedule_score`, `schedule_response_delivery`). Con `dedupe_key`,
    dos pedidos iguales en la misma transacción son una sola tarea; entre
    transacciones distintas el handler lee el estado al correr, así que una
    tarea de más sólo repite un envío idempotente."""
    if kind not in HANDLERS:
        raise ValueError(f"tipo de tarea desconocido: {kind}")
    if dedupe_key:
        for obj in session.new:
            if isinstance(obj, Job) and obj.dedupe_key == dedupe_key and obj.status == JOB_PENDING:
                return obj
    job = Job(
        kind=kind,
        payload=_jsonable(payload or {}),
        org_id=org_id,
        survey_id=survey_id,
        response_id=response_id,
        dedupe_key=dedupe_key,
        max_attempts=max_attempts,
        run_after=_now() + (delay or timedelta(0)),
    )
    session.add(job)
    return job


async def find_active(session: AsyncSession, dedupe_key: str) -> Optional[Job]:
    """Una tarea con esa clave que todavía no terminó (pendiente o corriendo)."""
    return (
        await session.scalars(
            select(Job)
            .where(Job.dedupe_key == dedupe_key, Job.status.in_((JOB_PENDING, JOB_RUNNING)))
            .order_by(Job.created_at.desc())
            .limit(1)
        )
    ).first()


def enqueue_detached(kind: str, payload: Optional[dict] = None, **kw) -> None:
    """Para quien no tiene una sesión a mano: encola en una transacción propia,
    en segundo plano. Sólo como red de seguridad de llamadas viejas; lo correcto
    es `enqueue` dentro de la transacción que causa la tarea."""

    async def _go():
        from app.db import _session_maker

        async with _session_maker() as session:
            enqueue(session, kind, payload, **kw)
            await session.commit()

    try:
        asyncio.get_running_loop().create_task(_go())
    except RuntimeError:
        LOGGER.debug("sin event loop: no se encola %s", kind)


def _jsonable(v: Any) -> Any:
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def _handler(kind: str) -> Callable[[dict, "JobContext"], Awaitable[Any]]:
    mod, fn = HANDLERS[kind].split(":")
    return getattr(importlib.import_module(mod), fn)


class JobContext:
    """Lo que un handler puede hacer además de trabajar: informar avance."""

    def __init__(self, job_id: uuid.UUID):
        self.job_id = job_id

    async def progress(self, **values) -> None:
        from app.db import _session_maker

        async with _session_maker() as session:
            await session.execute(update(Job).where(Job.id == self.job_id).values(progress=values))
            await session.commit()


async def _requeue_stale(session: AsyncSession) -> None:
    limite = _now() - STALE_AFTER
    await session.execute(
        update(Job)
        .where(Job.status == JOB_RUNNING, Job.locked_at < limite)
        .values(status=JOB_PENDING, locked_at=None, last_error="Interrumpida: se retoma")
    )


async def _claim(session: AsyncSession, limit: int) -> list[Job]:
    candidatos = (
        await session.scalars(
            select(Job.id)
            .where(Job.status == JOB_PENDING, Job.run_after <= _now())
            .order_by(Job.run_after)
            .limit(limit)
        )
    ).all()
    tomados: list[Job] = []
    for jid in candidatos:
        res = await session.execute(
            update(Job)
            .where(Job.id == jid, Job.status == JOB_PENDING)
            .values(status=JOB_RUNNING, locked_at=_now(), attempts=Job.attempts + 1)
        )
        if res.rowcount == 1:
            tomados.append(jid)
    await session.commit()
    if not tomados:
        return []
    return list((await session.scalars(select(Job).where(Job.id.in_(tomados)))).all())


async def _run_one(job: Job) -> None:
    from app.db import _session_maker

    ok, error, result = True, None, None
    try:
        result = await _handler(job.kind)(dict(job.payload or {}), JobContext(job.id))
    except Exception as exc:  # noqa: BLE001 — cualquier falla se reintenta
        ok, error = False, f"{type(exc).__name__}: {exc}"[:1000]
        LOGGER.warning("tarea %s (%s) falló en el intento %s: %s", job.id, job.kind, job.attempts, error)

    values: dict = {"locked_at": None}
    if ok:
        values.update(status=JOB_DONE, finished_at=_now(), last_error=None,
                      result=result if isinstance(result, dict) else None)
    elif job.attempts >= job.max_attempts:
        values.update(status=JOB_FAILED, finished_at=_now(), last_error=error)
    else:
        values.update(status=JOB_PENDING, last_error=error, run_after=_now() + backoff(job.attempts))
    async with _session_maker() as session:
        await session.execute(update(Job).where(Job.id == job.id).values(**values))
        await session.commit()


async def run_pending(limit: int = 20) -> int:
    """Corre una tanda de lo que esté listo. Devuelve cuántas tareas tomó.

    Es lo que llama el worker en bucle, y lo que llaman los tests para vaciar la
    cola de forma determinística."""
    from app.db import _session_maker

    async with _session_maker() as session:
        await _requeue_stale(session)
        jobs = await _claim(session, limit)
    for job in jobs:
        await _run_one(job)
    return len(jobs)


async def drain(max_rounds: int = 50) -> int:
    """Corre hasta que no quede nada listo (ignora lo que espera un reintento)."""
    total = 0
    for _ in range(max_rounds):
        n = await run_pending()
        total += n
        if n == 0:
            break
    return total


async def retry_now(session: AsyncSession, job: Job) -> None:
    """Reintento manual desde el panel: vuelve a la cola ya, con intentos nuevos."""
    job.status = JOB_PENDING
    job.run_after = _now()
    job.max_attempts = max(job.max_attempts, job.attempts + 3)
    job.finished_at = None
    session.add(job)


DONE_TTL = timedelta(days=90)
_MAINTENANCE_EVERY = timedelta(hours=1)


async def maintenance() -> dict:
    """Limpieza periódica: borradores vencidos y tareas terminadas viejas.

    Las tareas FALLIDAS no se borran: son las que alguien tiene que mirar. Las
    terminadas bien se conservan 90 días como registro de entregas."""
    from sqlalchemy import delete

    from app.db import _session_maker
    from app.models import DRAFT_TTL_DAYS, SurveyDraft

    async with _session_maker() as session:
        borradores = await session.execute(
            delete(SurveyDraft).where(SurveyDraft.updated_at < _now() - timedelta(days=DRAFT_TTL_DAYS))
        )
        viejas = await session.execute(
            delete(Job).where(Job.status == JOB_DONE, Job.finished_at < _now() - DONE_TTL)
        )
        await session.commit()
    return {"drafts": borradores.rowcount or 0, "jobs": viejas.rowcount or 0}


async def worker_loop(stop: asyncio.Event) -> None:
    LOGGER.info("Worker de tareas en segundo plano iniciado.")
    ultimo_mantenimiento = None
    while not stop.is_set():
        if ultimo_mantenimiento is None or _now() - ultimo_mantenimiento > _MAINTENANCE_EVERY:
            ultimo_mantenimiento = _now()
            try:
                await maintenance()
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("mantenimiento de la cola falló: %s", exc)
        try:
            n = await run_pending()
        except Exception as exc:  # noqa: BLE001 — el worker no se muere por una tanda
            LOGGER.error("worker: error al procesar la cola: %s", exc, exc_info=True)
            n = 0
        if n == 0:
            try:
                await asyncio.wait_for(stop.wait(), timeout=_IDLE_SLEEP_S)
            except asyncio.TimeoutError:
                pass


def job_view(j: Job) -> dict:
    return {
        "id": str(j.id),
        "kind": j.kind,
        "status": j.status,
        "attempts": j.attempts,
        "max_attempts": j.max_attempts,
        "last_error": j.last_error,
        "progress": j.progress,
        "result": j.result,
        "response_id": str(j.response_id) if j.response_id else None,
        "payload": {k: v for k, v in (j.payload or {}).items() if k in ("url", "to", "webhook_id")},
        "created_at": _aware(j.created_at).isoformat() if j.created_at else None,
        "run_after": _aware(j.run_after).isoformat() if j.run_after else None,
        "finished_at": _aware(j.finished_at).isoformat() if j.finished_at else None,
    }
