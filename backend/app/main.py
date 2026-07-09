"""Encuestum API — plataforma de encuestas y evaluaciones con corrección por IA."""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.responses import JSONResponse, Response

from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.db import engine
from app.logging_conf import configure_logging
from app.routers import (
    admin, assets, auth, evaluation, orgs, panel, public, uploads, webhooks_api,
)

LOGGER = logging.getLogger("encuestum")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    settings = get_settings()
    if settings.session_secret_is_ephemeral:
        LOGGER.warning(
            "ENCUESTUM_SESSION_SECRET no está seteado: se generó uno efímero. "
            "Las sesiones se invalidan en cada reinicio. Definilo en producción."
        )
    if os.getenv("ENCUESTUM_AUTO_MIGRATE", "true").strip().lower() in {"1", "true", "yes", "on"}:
        from app.migrate import run_migrations

        LOGGER.info("Aplicando migraciones de base de datos…")
        await run_migrations()
        LOGGER.info("Migraciones al día.")
    yield


app = FastAPI(title="Encuestum", version="1.0.0", lifespan=lifespan)

settings = get_settings()

# CORS: same-origin por defecto (no hace falta el middleware). Solo se activa si
# se configuran orígenes explícitos, y ahí sí con credenciales.
if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# AI errors → clean JSON responses (so they pass back through CORS with a helpful
# message instead of a raw 500 the browser mis-reports as a CORS failure).
from fastapi.responses import JSONResponse
from app.llm import LLMNotConfigured, LLMError


@app.exception_handler(LLMNotConfigured)
async def _llm_not_configured(request: Request, exc: LLMNotConfigured) -> Response:
    return JSONResponse(
        status_code=503,
        content={
            "detail": "La IA no está configurada: falta la API key del proveedor. "
            "Definí ENCUESTUM_LLM_API_KEY (OpenRouter/OpenAI) en el servidor.",
        },
    )


@app.exception_handler(LLMError)
async def _llm_error(request: Request, exc: LLMError) -> Response:
    return JSONResponse(
        status_code=502,
        content={"detail": f"El proveedor de IA falló: {exc}"},
    )


@app.middleware("http")
async def security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-XSS-Protection", "0")
    if settings.enable_hsts and request.url.scheme == "https":
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


API = "/api/v1"
# Auth y organizaciones bajo /api/v1
app.include_router(auth.router, prefix=API)
app.include_router(orgs.router, prefix=API)
app.include_router(assets.router, prefix=API)
app.include_router(uploads.router, prefix=API)
app.include_router(webhooks_api.router, prefix=API)
app.include_router(panel.router, prefix=API)

# Archivos subidos (imágenes/audio de diseño), servidos públicamente.
os.makedirs(settings.asset_dir, exist_ok=True)
app.mount("/assets", StaticFiles(directory=settings.asset_dir), name="assets")
# Encuestas bajo /api/v1/survey (contrato existente)
SURVEY = "/api/v1/survey"
app.include_router(public.router, prefix=SURVEY)
app.include_router(admin.router, prefix=SURVEY)
app.include_router(evaluation.router, prefix=SURVEY)


@app.get("/api/health", tags=["ops"])
async def health():
    return {"status": "ok", "service": "encuestum"}


@app.get("/api/ready", tags=["ops"])
async def ready():
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception as exc:  # noqa: BLE001
        LOGGER.error("readiness check failed: %s", exc)
        return JSONResponse(status_code=503, content={"status": "not-ready"})
