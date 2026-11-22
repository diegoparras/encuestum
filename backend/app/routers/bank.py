"""Banco de preguntas de la organización.

Las preguntas se guardan con su corrección y se etiquetan (tema, etiquetas,
dificultad, nivel de Bloom) para reutilizarlas. Al insertarlas en una encuesta
llevan `encBankId`, así que las estadísticas de cada ítem (cuántas veces se
usó, con cuántos alumnos, qué proporción lo acertó) se juntan de todos los
exámenes de la organización donde apareció.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app import scopes
from app.db import get_session
from app.deps import OrgContext, current_context
from app.hygiene import counted_only
from app.models import BankItem, Survey, SurveyResponse

router = APIRouter(prefix="/bank", tags=["bank"], dependencies=[Depends(scopes.guard)])

_MAX_ITEMS = 500


class BankItemIn(BaseModel):
    element: dict[str, Any]
    grading: Optional[dict[str, Any]] = None
    topic: Optional[str] = Field(default=None, max_length=120)
    tags: List[str] = Field(default_factory=list, max_length=20)
    difficulty: Optional[str] = Field(default=None, max_length=20)
    bloom: Optional[str] = Field(default=None, max_length=20)
    source_survey_id: Optional[uuid.UUID] = None


class BankCreate(BaseModel):
    items: List[BankItemIn] = Field(max_length=_MAX_ITEMS)


class BankPatch(BaseModel):
    topic: Optional[str] = Field(default=None, max_length=120)
    tags: Optional[List[str]] = Field(default=None, max_length=20)
    difficulty: Optional[str] = Field(default=None, max_length=20)
    bloom: Optional[str] = Field(default=None, max_length=20)


def _clean_tags(tags: List[str]) -> List[str]:
    out: list[str] = []
    for t in tags:
        t = (t or "").strip()[:40]
        if t and t.lower() not in {x.lower() for x in out}:
            out.append(t)
    return out


def _view(i: BankItem) -> dict:
    return {
        "id": str(i.id),
        "title": i.title,
        "type": i.qtype,
        "element": i.element,
        "grading": i.grading,
        "topic": i.topic,
        "tags": i.tags or [],
        "difficulty": i.difficulty,
        "bloom": i.bloom,
        "created_at": i.created_at.isoformat(),
    }


def _limpiar_elemento(el: dict) -> dict:
    """El elemento sin lo que ata a la encuesta de origen (lógica condicional
    que apunta a otras preguntas, saltos, marca de banco vieja)."""
    el = copy.deepcopy(el)
    for k in ("visibleIf", "encVisibility", "encBranching", "encBankId", "encGroup"):
        el.pop(k, None)
    return el


@router.get("")
async def list_bank(
    q: Optional[str] = Query(None, max_length=200),
    topic: Optional[str] = None,
    tag: Optional[str] = None,
    type: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    stmt = select(BankItem).where(BankItem.org_id == ctx.org.id)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(BankItem.title).like(like), func.lower(BankItem.topic).like(like)))
    if topic:
        stmt = stmt.where(BankItem.topic == topic)
    if type:
        stmt = stmt.where(BankItem.qtype == type)
    items = (await session.scalars(stmt.order_by(BankItem.created_at.desc()).limit(limit))).all()
    if tag:
        items = [i for i in items if tag.lower() in {t.lower() for t in (i.tags or [])}]
    return [_view(i) for i in items]


@router.get("/facets")
async def bank_facets(ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Temas y etiquetas en uso, para los filtros."""
    items = (await session.scalars(select(BankItem).where(BankItem.org_id == ctx.org.id))).all()
    temas: dict[str, int] = {}
    tags: dict[str, int] = {}
    for i in items:
        if i.topic:
            temas[i.topic] = temas.get(i.topic, 0) + 1
        for t in i.tags or []:
            tags[t] = tags.get(t, 0) + 1
    return {
        "total": len(items),
        "topics": [{"value": k, "count": v} for k, v in sorted(temas.items())],
        "tags": [{"value": k, "count": v} for k, v in sorted(tags.items())],
    }


@router.post("", status_code=201)
async def create_items(
    payload: BankCreate,
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    creados = []
    for it in payload.items:
        el = _limpiar_elemento(it.element)
        titulo = str(el.get("title") or el.get("name") or "").strip()
        if not titulo or not el.get("type"):
            continue
        b = BankItem(
            org_id=ctx.org.id, title=titulo[:500], qtype=str(el["type"]), element=el,
            grading=copy.deepcopy(it.grading) if it.grading else None,
            topic=(it.topic or "").strip() or None, tags=_clean_tags(it.tags),
            difficulty=it.difficulty, bloom=it.bloom, source_survey_id=it.source_survey_id,
            created_by=ctx.user.id,
        )
        session.add(b)
        creados.append(b)
    await session.commit()
    return {"created": len(creados), "items": [_view(b) for b in creados]}


@router.post("/import", status_code=201)
async def import_into_bank(
    file: Optional[UploadFile] = File(None),
    text: Optional[str] = Form(None),
    format: str = Form("auto"),
    topic: Optional[str] = Form(None),
    tags: Optional[str] = Form(None, description="Separadas por coma"),
    ctx: OrgContext = Depends(current_context),
    session: AsyncSession = Depends(get_session),
):
    """GIFT, Aiken o Moodle XML directo al banco."""
    from app.interchange import MAX_BYTES, InterchangeError, detect_and_parse

    if file is not None:
        raw = await file.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="El archivo supera los 5 MB.")
        contenido = raw.decode("utf-8", errors="replace")
        if format == "auto" and (file.filename or "").lower().endswith(".xml"):
            format = "moodle"
    elif text:
        contenido = text
    else:
        raise HTTPException(status_code=422, detail="Subí un archivo o pegá el texto.")
    try:
        res = detect_and_parse(contenido, format)
    except InterchangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    etiquetas = _clean_tags((tags or "").split(","))
    for q in res.questions:
        session.add(BankItem(
            org_id=ctx.org.id, title=q.element["title"][:500], qtype=q.element["type"],
            element=q.element, grading=q.grading, topic=(topic or "").strip() or None,
            tags=etiquetas, created_by=ctx.user.id,
        ))
    await session.commit()
    return {"created": len(res.questions), "warnings": res.warnings}


async def _item_or_404(iid: uuid.UUID, ctx: OrgContext, session: AsyncSession) -> BankItem:
    i = await session.get(BankItem, iid)
    if i is None or i.org_id != ctx.org.id:
        raise HTTPException(status_code=404, detail="Pregunta del banco no encontrada")
    return i


@router.patch("/{iid}")
async def patch_item(iid: uuid.UUID, payload: BankPatch, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    i = await _item_or_404(iid, ctx, session)
    data = payload.model_dump(exclude_unset=True)
    if "tags" in data:
        data["tags"] = _clean_tags(data["tags"] or [])
    if "topic" in data:
        data["topic"] = (data["topic"] or "").strip() or None
    for k, v in data.items():
        setattr(i, k, v)
    session.add(i)
    await session.commit()
    await session.refresh(i)
    return _view(i)


@router.delete("/{iid}", status_code=204)
async def delete_item(iid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Borra la pregunta del banco. Las encuestas que ya la usan no cambian:
    tienen su propia copia."""
    i = await _item_or_404(iid, ctx, session)
    await session.delete(i)
    await session.commit()


@router.get("/{iid}/stats")
async def item_stats(iid: uuid.UUID, ctx: OrgContext = Depends(current_context), session: AsyncSession = Depends(get_session)):
    """Cómo le fue a esta pregunta en todos los exámenes de la organización
    donde se usó: en cuántos, con cuántas respuestas y qué proporción del
    puntaje se obtuvo en promedio (la dificultad clásica, p)."""
    await _item_or_404(iid, ctx, session)
    clave = str(iid)
    surveys = (await session.scalars(
        select(Survey).where(Survey.org_id == ctx.org.id, Survey.deleted_at.is_(None))
    )).all()
    usos = []
    fracciones: list[float] = []
    for s in surveys:
        nombres = {
            el.get("name")
            for p in (s.json_schema or {}).get("pages", []) or []
            if isinstance(p, dict)
            for el in p.get("elements", []) or []
            if isinstance(el, dict) and el.get("encBankId") == clave
        }
        if not nombres:
            continue
        resp = (await session.scalars(
            counted_only(select(SurveyResponse).where(SurveyResponse.survey_id == s.id))
        )).all()
        n = 0
        for r in resp:
            for q in (r.grade or {}).get("questions", []) or []:
                pts = float(q.get("points", 0) or 0)
                if q.get("name") in nombres and pts > 0:
                    fracciones.append(max(0.0, min(1.0, float(q.get("awarded", 0) or 0) / pts)))
                    n += 1
        usos.append({"survey_id": str(s.id), "title": s.title, "responses": n})
    return {
        "used_in": len(usos),
        "surveys": usos,
        "responses": len(fracciones),
        "difficulty": round(sum(fracciones) / len(fracciones), 3) if fracciones else None,
    }
