#!/usr/bin/env bash
# Arranque de desarrollo local con configuración ESTABLE (mismo SESSION_SECRET
# entre reinicios → las sesiones no se invalidan). No usar en producción.
set -e
cd "$(dirname "$0")"

export ENCUESTUM_SESSION_SECRET="dev-local-secret-estable-no-para-produccion-32b+"
export ENCUESTUM_CORS_ORIGINS="http://localhost:3001,http://localhost:3000"
export ENCUESTUM_BASE_DOMAIN="localhost"
export ENCUESTUM_COOKIE_SECURE="false"

exec ./.venv/Scripts/python.exe -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8000 --log-level info
