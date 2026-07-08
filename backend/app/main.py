"""Encuestum API — encuestas y evaluaciones con corrección por IA."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from app.db import create_db_and_tables
from app.routers import admin, evaluation, public


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_db_and_tables()
    yield


app = FastAPI(title="Encuestum", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def admin_auth(request: Request, call_next):
    """Optional admin gate: if ENCUESTUM_ADMIN_TOKEN is set, admin/eval routes
    require the matching X-Admin-Token header. Public routes are always open."""
    token = os.getenv("ENCUESTUM_ADMIN_TOKEN")
    path = request.url.path
    is_admin_api = path.startswith("/api/v1/survey/surveys")
    if token and is_admin_api and request.method != "OPTIONS":
        if request.headers.get("X-Admin-Token") != token:
            return JSONResponse(status_code=401, content={"detail": "Admin token required"})
    return await call_next(request)


API = "/api/v1/survey"
app.include_router(public.router, prefix=API)
app.include_router(admin.router, prefix=API)
app.include_router(evaluation.router, prefix=API)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "encuestum"}
