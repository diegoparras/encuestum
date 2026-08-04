#!/usr/bin/env bash
# Entrypoint for the all-in-one image: runs FastAPI, the Next.js standalone
# server and nginx together. If any one exits, tear the others down so the
# container restarts as a whole.
set -uo pipefail

DATA_DIR="${ENCUESTUM_DATA_DIR:-/app_data}"
mkdir -p "$DATA_DIR"

# LTI 1.3: decide en runtime (no en `next build`, que ya pasó y quedó
# congelado en el frontend) si /lti-select y /s/ se sirven enmarcables.
# `frontend/next.config.js` siempre manda X-Frame-Options: SAMEORIGIN en esas
# dos rutas — eso es correcto para el resto de la app, pero Moodle carga
# ambas dentro de un <iframe> de su propio origen y SAMEORIGIN se lo impide.
# X-Frame-Options no puede expresar "cualquier origen"; su sucesor, la CSP
# `frame-ancestors`, sí. Los dos headers compiten por controlar el framing y
# algunos navegadores honran X-Frame-Options aunque haya una CSP permisiva
# presente, así que no alcanza con agregar la CSP: hay que sacar el
# X-Frame-Options que ya viene de Next.js (proxy_hide_header) antes de poner
# la propia. Mismas grafías de "prendido" que `_bool()` en
# backend/app/config.py, para que back y front nunca queden en desacuerdo
# sobre si LTI está o no.
#
# Trade-off real, no formalidad: con LTI prendido, /s/{slug} (que sirve TODAS
# las encuestas públicas, atadas a LTI o no) queda enmarcable por cualquier
# sitio, no sólo por Moodle — es justo lo que una integración LMS necesita.
# El resto de la app sigue con SAMEORIGIN sin cambios.
mkdir -p /etc/nginx/conf.d
LTI_SNIPPET=/etc/nginx/conf.d/lti-frame.conf
case "$(printf '%s' "${LTI_ENABLED:-}" | tr '[:upper:]' '[:lower:]' | xargs)" in
  1|true|yes|on)
    cat > "$LTI_SNIPPET" <<'EOF'
location = /lti-select {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $http_host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 5m;
  proxy_connect_timeout 5m;
  proxy_hide_header X-Frame-Options;
  add_header Content-Security-Policy "frame-ancestors *" always;
}

location ^~ /s/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $http_host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 5m;
  proxy_connect_timeout 5m;
  proxy_hide_header X-Frame-Options;
  add_header Content-Security-Policy "frame-ancestors *" always;
}
EOF
    ;;
  *)
    # LTI apagado: archivo vacío, `location /` sigue sirviendo estas rutas
    # tal como hoy (X-Frame-Options: SAMEORIGIN, sin CSP de framing).
    : > "$LTI_SNIPPET"
    ;;
esac

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
