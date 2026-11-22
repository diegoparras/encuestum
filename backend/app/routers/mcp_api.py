"""Servidor MCP de Encuestum (Model Context Protocol, transporte Streamable
HTTP): un asistente de IA (Claude, u otro cliente MCP) consulta encuestas,
respuestas y resúmenes, y carga invitados, con una clave de la API pública.

    claude mcp add --transport http encuestum https://<host>/api/v1/mcp \\
        --header "Authorization: Bearer enc_…"

Es JSON-RPC 2.0 por POST con respuestas JSON (sin streaming: ninguna
herramienta tarda lo suficiente para necesitarlo). Las herramientas son una
capa fina sobre la API pública (`app/routers/ext_api.py`): mismos permisos
(lectura/escritura de la clave), mismo alcance (la organización de la clave)
y mismo límite de pedidos.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api_keys import ApiContext, api_context
from app.db import get_session
from app.routers import ext_api

router = APIRouter(prefix="/mcp", tags=["mcp"])

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

_ID = {"type": "string", "description": "ID de la encuesta (UUID)"}
TOOLS: list[dict] = [
    {"name": "list_surveys", "description": "Lista las encuestas de la organización con su cantidad de respuestas.",
     "inputSchema": {"type": "object", "properties": {
         "status": {"type": "string", "enum": ["draft", "published", "closed"], "description": "Filtrar por estado"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "get_survey", "description": "Las preguntas de una encuesta (nombre, tipo, título y opciones).",
     "inputSchema": {"type": "object", "properties": {"survey_id": _ID}, "required": ["survey_id"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "get_summary",
     "description": "Resumen por pregunta: conteos y porcentajes por opción, promedios de escalas, NPS, "
                    "respuestas abiertas. Úsalo para responder preguntas sobre los resultados.",
     "inputSchema": {"type": "object", "properties": {
         "survey_id": _ID,
         "date_from": {"type": "string", "format": "date"}, "date_to": {"type": "string", "format": "date"}},
         "required": ["survey_id"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "get_responses",
     "description": "Respuestas individuales, de la más vieja a la más nueva (máx. 200 por llamada). "
                    "Para seguir, pasá `offset` = next_offset.",
     "inputSchema": {"type": "object", "properties": {
         "survey_id": _ID, "since": {"type": "string", "format": "date-time"},
         "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 200}},
         "required": ["survey_id"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "add_invitees",
     "description": "Carga invitados (emails) a una encuesta de acceso por lista y, opcionalmente, les manda "
                    "la invitación. Requiere una clave de escritura.",
     "inputSchema": {"type": "object", "properties": {
         "survey_id": _ID, "emails": {"type": "array", "items": {"type": "string", "format": "email"}, "maxItems": 500},
         "send": {"type": "boolean", "default": False}}, "required": ["survey_id", "emails"]},
     "annotations": {"readOnlyHint": False, "destructiveHint": False}},
]


def _rpc_result(id_, result) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _rpc_error(id_, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _jsonable(x):
    if hasattr(x, "model_dump"):
        return x.model_dump(mode="json")
    if isinstance(x, list):
        return [_jsonable(i) for i in x]
    if isinstance(x, (datetime, date, uuid.UUID)):
        return str(x)
    return x


def _uuid(v) -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError:
        raise ToolError("survey_id no es un UUID válido")


class ToolError(Exception):
    pass


async def _call(name: str, args: dict, api: ApiContext, session: AsyncSession) -> Any:
    from fastapi import HTTPException

    try:
        if name == "list_surveys":
            return await ext_api.ext_list_surveys(status=args.get("status"), api=api, session=session)
        if name == "get_survey":
            s = await ext_api.ext_get_survey(_uuid(args.get("survey_id")), api=api, session=session)
            preguntas = [
                {k: el.get(k) for k in ("name", "type", "title", "choices", "rows", "columns", "rateMin", "rateMax")
                 if el.get(k) is not None}
                for p in (s["json_schema"].get("pages") or []) for el in (p.get("elements") or [])
                if isinstance(el, dict) and el.get("type") not in ("html", "image")
            ]
            return {k: v for k, v in s.items() if k != "json_schema"} | {"questions": preguntas}
        if name == "get_summary":
            df = date.fromisoformat(args["date_from"]) if args.get("date_from") else None
            dt = date.fromisoformat(args["date_to"]) if args.get("date_to") else None
            res = await ext_api.ext_summary(_uuid(args.get("survey_id")), date_from=df, date_to=dt, api=api, session=session)
            return {k: res.get(k) for k in ("total_responses", "filtered_responses", "timeline", "questions")}
        if name == "get_responses":
            since = datetime.fromisoformat(args["since"]) if args.get("since") else None
            limit = max(1, min(200, int(args.get("limit") or 50)))
            return await ext_api.ext_list_responses(_uuid(args.get("survey_id")), since=since,
                                                    offset=int(args.get("offset") or 0), limit=limit,
                                                    api=api, session=session)
        if name == "add_invitees":
            emails = args.get("emails") or []
            if not isinstance(emails, list) or not emails:
                raise ToolError("emails tiene que ser una lista no vacía")
            payload = ext_api.InviteesIn(invitees=[{"email": e} for e in emails[:500]], send=bool(args.get("send")))
            return await ext_api.ext_add_invitees(_uuid(args.get("survey_id")), payload, api=api, session=session)
    except HTTPException as exc:
        detalle = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail, ensure_ascii=False)
        raise ToolError(detalle)
    except (ValueError, TypeError) as exc:
        raise ToolError(f"Argumentos inválidos: {exc}")
    raise LookupError(name)


async def _handle(msg: Any, api: ApiContext, session: AsyncSession):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return _rpc_error(msg.get("id") if isinstance(msg, dict) else None, -32600, "Pedido JSON-RPC inválido")
    method, id_, params = msg["method"], msg.get("id"), msg.get("params") or {}
    es_notificacion = "id" not in msg
    if method == "initialize":
        from app.main import APP_VERSION

        pedida = params.get("protocolVersion")
        version = pedida if pedida in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return _rpc_result(id_, {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "encuestum", "title": "Encuestum", "version": APP_VERSION},
            "instructions": (f"Encuestas de la organización «{api.org.name}». Empezá por list_surveys; "
                             "para analizar resultados usá get_summary antes que get_responses."),
        })
    if es_notificacion:
        return None  # notifications/initialized, cancelled, etc.: sin respuesta
    if method == "ping":
        return _rpc_result(id_, {})
    if method == "tools/list":
        return _rpc_result(id_, {"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            return _rpc_error(id_, -32602, "arguments tiene que ser un objeto")
        try:
            data = _jsonable(await _call(name, args, api, session))
        except LookupError:
            return _rpc_error(id_, -32602, f"Herramienta desconocida: {name}")
        except ToolError as exc:
            return _rpc_result(id_, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        texto = json.dumps(data, ensure_ascii=False, default=str)
        return _rpc_result(id_, {"content": [{"type": "text", "text": texto}], "isError": False})
    return _rpc_error(id_, -32601, f"Método no soportado: {method}")


@router.post("")
async def mcp_endpoint(request: Request, api: ApiContext = Depends(api_context),
                       session: AsyncSession = Depends(get_session)):
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse(_rpc_error(None, -32700, "JSON inválido"), status_code=400)
    if isinstance(body, list):
        respuestas = [r for r in [await _handle(m, api, session) for m in body] if r is not None]
        return JSONResponse(respuestas) if respuestas else Response(status_code=202)
    r = await _handle(body, api, session)
    return JSONResponse(r) if r is not None else Response(status_code=202)


@router.get("")
async def mcp_get():
    # Sin canal de eventos del servidor (no hay notificaciones que mandar).
    return Response(status_code=405, headers={"Allow": "POST"})
