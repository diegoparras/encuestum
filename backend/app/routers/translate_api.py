"""Traducción de encuestas (ver app/translation.py)."""

from __future__ import annotations

import asyncio
import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import scopes
from app import translation
from app.audit import record_event
from app.db import get_session
from app.deps import OrgContext, current_context
from app.routers.admin import _survey_or_404

router = APIRouter(prefix="/surveys", tags=["translations"], dependencies=[Depends(scopes.guard)])

_BATCH = 60


class TranslateIn(BaseModel):
    languages: List[str] = Field(min_length=1, max_length=8)
    # Sólo lo que falta (lo ya traducido, quizás revisado a mano, no se toca).
    only_missing: bool = True


def _lang(code: str) -> str:
    c = (code or "").strip().lower()
    if c not in translation.LANGS:
        raise HTTPException(status_code=422, detail=f"Idioma no soportado: {code}")
    return c


@router.get("/{sid}/translations")
async def get_translations(sid: uuid.UUID, ctx: OrgContext = Depends(current_context),
                           session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    return {"source_language": s.language or "es",
            "languages": translation.coverage(s.json_schema or {}, s.translations)}


@router.get("/{sid}/translations/{lang}")
async def get_language(sid: uuid.UUID, lang: str, ctx: OrgContext = Depends(current_context),
                       session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    m = (s.translations or {}).get(_lang(lang)) or {}
    return [{"source": t, "text": m.get(t)} for t in translation.source_texts(s.json_schema or {})]


class EditIn(BaseModel):
    items: Dict[str, str] = Field(max_length=translation.MAX_TEXTS)


@router.put("/{sid}/translations/{lang}")
async def edit_language(sid: uuid.UUID, lang: str, payload: EditIn, ctx: OrgContext = Depends(current_context),
                        session: AsyncSession = Depends(get_session)):
    """Corrección a mano. Un texto vacío borra esa traducción."""
    s = await _survey_or_404(sid, ctx.org.id, session)
    lang = _lang(lang)
    vivos = set(translation.source_texts(s.json_schema or {}))
    m = dict((s.translations or {}).get(lang) or {})
    for src, dst in payload.items.items():
        if src not in vivos:
            continue
        if not (dst or "").strip():
            m.pop(src, None)
            continue
        err = translation.check_translation(src, dst)
        if err:
            raise HTTPException(status_code=422, detail=f"«{src[:60]}»: {err}")
        m[src] = dst.strip()
    s.translations = {**(s.translations or {}), lang: m}
    session.add(s)
    record_event(session, action="survey.translation_edited", org_id=ctx.org.id, actor=ctx.user,
                 survey_id=s.id, detail={"language": lang, "count": len(payload.items)})
    await session.commit()
    return translation.coverage(s.json_schema or {}, s.translations)


@router.delete("/{sid}/translations/{lang}", status_code=204)
async def delete_language(sid: uuid.UUID, lang: str, ctx: OrgContext = Depends(current_context),
                          session: AsyncSession = Depends(get_session)):
    s = await _survey_or_404(sid, ctx.org.id, session)
    lang = _lang(lang)
    s.translations = {k: v for k, v in (s.translations or {}).items() if k != lang} or None
    session.add(s)
    await session.commit()


@router.post("/{sid}/translate")
async def translate_survey(sid: uuid.UUID, payload: TranslateIn, ctx: OrgContext = Depends(current_context),
                           session: AsyncSession = Depends(get_session)):
    """Traduce con IA a los idiomas pedidos, en tandas en paralelo."""
    from app import llm_calls
    from app.ai_config import resolve_provider
    from app.ai_usage import summary, track_ai_call

    s = await _survey_or_404(sid, ctx.org.id, session)
    origen = s.language or "es"
    idiomas = [_lang(x) for x in dict.fromkeys(payload.languages) if _lang(x) != origen]
    if not idiomas:
        raise HTTPException(status_code=422, detail="Elegí al menos un idioma distinto del de la encuesta.")
    textos = translation.source_texts(s.json_schema or {})
    if not textos:
        raise HTTPException(status_code=422, detail="La encuesta no tiene textos para traducir.")
    memoria = translation.prune(s.json_schema or {}, s.translations)
    provider = await resolve_provider(session, ctx.org.id)
    hechos: dict[str, int] = {}
    async with track_ai_call(session, provider, ctx.org.id, "translate", sid, ctx.user.id) as acc:
        for lang in idiomas:
            m = dict(memoria.get(lang) or {})
            pendientes = [t for t in textos if not (payload.only_missing and m.get(t))]
            tandas = [pendientes[i:i + _BATCH] for i in range(0, len(pendientes), _BATCH)]
            resultados = await asyncio.gather(*[
                llm_calls.translate_texts(texts=tanda, source_language=origen, target_language=lang)
                for tanda in tandas
            ])
            for r in resultados:
                m.update(r)
            memoria[lang] = m
            hechos[lang] = sum(len(r) for r in resultados)
    s.translations = memoria
    session.add(s)
    record_event(session, action="survey.translated", org_id=ctx.org.id, actor=ctx.user, survey_id=s.id,
                 detail={"languages": idiomas, "translated": hechos})
    await session.commit()
    return {"translated": hechos, "languages": translation.coverage(s.json_schema or {}, s.translations),
            "usage": summary(acc)}
