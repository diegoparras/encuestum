# ─────────────────────────────────────────────────────────────────────────────
# Encuestum — imagen all-in-one (nginx + Next.js + FastAPI) para EasyPanel.
# El contenedor escucha en el puerto 80. El frontend habla con el backend
# same-origin (nginx enruta /api/ a FastAPI), así que se buildea sin
# NEXT_PUBLIC_API_URL.
# ─────────────────────────────────────────────────────────────────────────────

# 1) Build del frontend → salida standalone (.next/standalone)
FROM node:20-slim AS frontend
WORKDIR /app/frontend
ENV NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
# Same-origin: base URL vacía → el navegador pega a /api/... (nginx → FastAPI)
ENV NEXT_PUBLIC_API_URL=""
RUN npm run build

# 2) Imagen final: Node (para el server standalone) + Python (FastAPI) + nginx
FROM node:20-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# venv aislado para las deps del backend
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Backend. Se instala desde el lockfile con hashes: la imagen sale igual hoy
# que dentro de seis meses, y una versión mayor nueva de una dependencia no la
# rompe sola (pasó con SQLAlchemy 2.1, que dejó de traer `greenlet`). Para
# actualizar: `uv pip compile requirements.txt --universal --python-version 3.11
# --generate-hashes -o requirements.lock`, correr los tests y commitear.
COPY backend/requirements.lock /app/backend/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/backend/requirements.lock
COPY backend/ /app/backend/

# Frontend standalone (server.js + estáticos)
COPY --from=frontend /app/frontend/.next/standalone /app/frontend/
COPY --from=frontend /app/frontend/.next/static /app/frontend/.next/static
COPY --from=frontend /app/frontend/public /app/frontend/public

# nginx + entrypoint
COPY nginx.conf /etc/nginx/nginx.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENV ENCUESTUM_DATA_DIR=/app_data \
    NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
VOLUME ["/app_data"]

EXPOSE 80
# Sano = nginx responde y el backend contesta /api/ready (que toca la base).
# Sin curl en la imagen slim: Python ya está.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1/api/ready', timeout=4)" || exit 1
CMD ["/start.sh"]
