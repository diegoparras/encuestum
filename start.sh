#!/usr/bin/env bash
# Entrypoint for the all-in-one image: runs FastAPI, the Next.js standalone
# server and nginx together. If any one exits, tear the others down so the
# container restarts as a whole.
set -uo pipefail

DATA_DIR="${ENCUESTUM_DATA_DIR:-/app_data}"
mkdir -p "$DATA_DIR"

# Backend (FastAPI) on :8000
( cd /app/backend && exec uvicorn app.main:app --host 127.0.0.1 --port 8000 ) &
BACKEND=$!

# Frontend (Next.js standalone) on :3000
( cd /app/frontend && PORT=3000 HOSTNAME=127.0.0.1 exec node server.js ) &
FRONTEND=$!

# Reverse proxy (nginx) on :80
nginx -g 'daemon off;' &
NGINX=$!

wait -n "$BACKEND" "$FRONTEND" "$NGINX"
echo "[start] a process exited — shutting down the container." >&2
kill "$BACKEND" "$FRONTEND" "$NGINX" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
