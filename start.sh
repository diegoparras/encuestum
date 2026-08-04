#!/usr/bin/env bash
# Entrypoint for the all-in-one image: runs FastAPI, the Next.js standalone
# server and nginx together. If any one exits, tear the others down so the
# container restarts as a whole.
set -uo pipefail

DATA_DIR="${ENCUESTUM_DATA_DIR:-/app_data}"
mkdir -p "$DATA_DIR"

# LTI 1.3: decide en runtime (no en `next build`, que ya pasó y quedó
# congelado en el frontend) si /lti-select, /s/ y /lti/ se sirven enmarcables.
# `frontend/next.config.js` siempre manda X-Frame-Options: SAMEORIGIN en
# /lti-select y /s/, y `backend/app/main.py` siempre manda
# X-Frame-Options: DENY en toda respuesta de FastAPI (incluido /lti/) — eso es
# correcto para el resto de la app, pero Moodle carga estas rutas dentro de un
# <iframe> de su propio origen y ni SAMEORIGIN ni DENY se lo permiten.
# X-Frame-Options no puede expresar "cualquier origen"; su sucesor, la CSP
# `frame-ancestors`, sí. Los dos headers compiten por controlar el framing y
# algunos navegadores honran X-Frame-Options aunque haya una CSP permisiva
# presente, así que no alcanza con agregar la CSP: hay que sacar el
# X-Frame-Options que ya viene del backend (proxy_hide_header) antes de poner
# la propia. Mismas grafías de "prendido" que `_bool()` en
# backend/app/config.py (ver el trim más abajo), para que back y front nunca
# queden en desacuerdo sobre si LTI está o no.
#
# /lti/ entra acá también (y no como bloque estático en nginx.conf) porque, sin
# esto, cualquier error de /lti/launch (state inválido o vencido, deep linking
# sin return URL, 404 con LTI apagado) es un documento con DENY renderizado
# adentro del iframe de Moodle: el usuario ve un iframe en blanco en vez del
# mensaje de error. Iterar nginx.conf para ver por qué no conviene un bloque
# estático + este include compitiendo por el mismo path.
#
# Trade-off real, no formalidad: con LTI prendido, /s/{slug} (que sirve TODAS
# las encuestas públicas, atadas a LTI o no) queda enmarcable por cualquier
# sitio, no sólo por Moodle — es justo lo que una integración LMS necesita.
# El resto de la app sigue con SAMEORIGIN/DENY sin cambios.
mkdir -p /etc/nginx/conf.d
LTI_SNIPPET=/etc/nginx/conf.d/lti-frame.conf
# Trim de espacios con `tr -d '[:space:]'`, NO `xargs`: xargs además saca
# comillas y desescapa backslashes, algo que
# `_bool()` (backend/app/config.py) no hace — con LTI_ENABLED='"true"',
# xargs lo dejaría en `true` (prendido acá) mientras `_bool()` ve el string
# literal `"true"` (con comillas) y lo evalúa apagado. Ese desacuerdo corre en
# el sentido inseguro: framing relajado en nginx con el backend todavía
# devolviendo 404 en /lti/*. `tr -d '[:space:]'` sólo saca espacios, igual que
# `.strip()` de Python, sin tocar comillas ni backslashes.
LTI_RAW="$(printf '%s' "${LTI_ENABLED:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$LTI_RAW" in
  1|true|yes|on)
    cat > "$LTI_SNIPPET" <<'EOF'
location /lti/ {
  proxy_pass http://127.0.0.1:8000;
  proxy_set_header Host $http_host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_hide_header X-Frame-Options;
  add_header Content-Security-Policy "frame-ancestors *" always;
}

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
    # LTI apagado: /lti-select y /s/ quedan sin declarar acá — `location /`
    # sigue sirviéndolas tal como hoy (X-Frame-Options: SAMEORIGIN, sin CSP de
    # framing). /lti/ sí se declara, como copia fiel del bloque que antes
    # vivía estático en nginx.conf (mismo proxy_pass, sin tocar headers):
    # sigue devolviendo DENY, correcto porque los endpoints 404 igual.
    cat > "$LTI_SNIPPET" <<'EOF'
location /lti/ {
  proxy_pass http://127.0.0.1:8000;
  proxy_set_header Host $http_host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
EOF
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
