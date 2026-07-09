#!/usr/bin/env bash
# Arranque de desarrollo local con configuración ESTABLE (mismo SESSION_SECRET
# entre reinicios → las sesiones no se invalidan). No usar en producción.
set -e
cd "$(dirname "$0")"

# Base de datos: Postgres local en Docker (contenedor encuestum-db, puerto 5433).
# Comentá esta línea para volver a SQLite (E:/app_data/encuestum.db).
export DATABASE_URL="postgresql://encuestum:encuestum_dev@localhost:5433/encuestum"

export ENCUESTUM_SESSION_SECRET="dev-local-secret-estable-no-para-produccion-32b+"
export ENCUESTUM_CORS_ORIGINS="http://localhost:3001,http://localhost:3000"
export ENCUESTUM_BASE_DOMAIN="localhost"
export ENCUESTUM_COOKIE_SECURE="false"

# ── IA (opcional): pegá tu API key para habilitar generar/corregir con IA ─────
# Proveedor por defecto: OpenRouter (https://openrouter.ai/api/v1), modelo
# openai/gpt-4o-mini. Podés cambiarlos con ENCUESTUM_LLM_BASE_URL / _MODEL.
# Sin key, los motores de IA responden 503 "IA no configurada".
export ENCUESTUM_LLM_API_KEY=""
# export ENCUESTUM_LLM_MODEL="anthropic/claude-3.5-sonnet"

# ── Email / SMTP (opcional): para enviar links mágicos e invitaciones ─────────
# Sin SMTP, los emails NO se envían: se registran en el log (podés copiar el link
# de ahí). Con SMTP configurado, se envían de verdad. Usa STARTTLS (puerto 587).
# URL base para armar los links de los emails (apuntá al frontend):
export ENCUESTUM_PUBLIC_URL="http://localhost:3001"
# Pegá los datos de tu proveedor (Gmail, Brevo, Mailgun, SendGrid, SES, Resend…):
# export ENCUESTUM_SMTP_HOST="smtp.tu-proveedor.com"
# export ENCUESTUM_SMTP_PORT="587"
# export ENCUESTUM_SMTP_USER="tu-usuario"
# export ENCUESTUM_SMTP_PASSWORD="tu-clave-o-app-password"
# export ENCUESTUM_SMTP_TLS="true"
# export ENCUESTUM_EMAIL_FROM="Encuestum <no-reply@tudominio.com>"

exec ./.venv/Scripts/python.exe -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8000 --log-level info
