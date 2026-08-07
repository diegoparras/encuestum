#!/usr/bin/env bash
# Entrypoint for the all-in-one image: runs FastAPI, the Next.js standalone
# server and nginx together. If any one exits, tear the others down so the
# container restarts as a whole.
set -uo pipefail

DATA_DIR="${ENCUESTUM_DATA_DIR:-/app_data}"
mkdir -p "$DATA_DIR"

# Integraciones con Moodle (LTI 1.3 y el módulo nativo `mod_encuestum`): decide
# en runtime (no en `next build`, que ya pasó y quedó congelado en el frontend)
# si /lti-select y /s/ se sirven enmarcables.
# `frontend/next.config.js` siempre manda X-Frame-Options: SAMEORIGIN en esas
# rutas — correcto para el resto de la app, pero Moodle las carga dentro de un
# <iframe> de su propio origen y SAMEORIGIN no se lo permite. X-Frame-Options
# no puede expresar "cualquier origen"; su sucesor, la CSP `frame-ancestors`,
# sí. Los dos headers compiten por controlar el framing y algunos navegadores
# honran X-Frame-Options aunque haya una CSP permisiva presente, así que no
# alcanza con agregar la CSP: hay que sacar el X-Frame-Options que ya viene de
# Next.js (proxy_hide_header) antes de poner la propia. Mismas grafías de
# "prendido" que `_bool()` en backend/app/config.py (ver el trim más abajo),
# para que back y front nunca queden en desacuerdo sobre si una integración
# está o no.
#
# `/lti/` NO entra acá — es un bloque estático en nginx.conf, con la
# relajación de framing incondicional (no atada a este flag). Ver el comentario
# ahí para el porqué: en corto, /lti/ es la API que Moodle necesita alcanzar
# siempre, y hacer que su ruteo dependiera de que esta escritura tuviera éxito
# era peor que el problema que resolvía.
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
prendido() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}
# Quién puede embeber las encuestas mientras alguna de las dos integraciones
# con Moodle está activa. Sin definir (o vacía) queda `*`, que es lo que se
# venía haciendo y lo que hace falta para que un LMS cualquiera las muestre. Un despliegue que conoce sus LMS puede
# cerrar el cerco:
#
#   LTI_FRAME_ANCESTORS="https://moodle.escuela.edu https://aula.otro.org"
#
# El valor va tal cual al `frame-ancestors` de la CSP, así que la sintaxis es
# la de esa directiva: orígenes separados por espacios. El precio de cerrarlo
# es editar la variable al conectar un colegio nuevo — una vez por institución,
# no todos los días.
#
# `:-` y no `-`: una variable definida pero vacía también cae en `*`. Con `-`
# quedaría `frame-ancestors ` a secas, que es una CSP inválida y bloquearía el
# framing por completo — el LMS dejaría de mostrar las encuestas y el síntoma
# aparecería lejísimos de la causa.
#
# La variable se sigue llamando LTI_FRAME_ANCESTORS aunque ahora también rija
# para el módulo nativo: es la misma pregunta ("quién puede embeber /s/") y una
# segunda variable con el mismo valor sería una más para olvidarse de sincronizar.
ANCESTROS="${LTI_FRAME_ANCESTORS:-*}"

# `/s/` (la encuesta que ve el alumno) hace falta enmarcable con CUALQUIERA de
# las dos integraciones: tanto `/lti/launch` como el `/mod/launch` del módulo
# nativo terminan redirigiendo ahí adentro del iframe de Moodle. Con
# MOD_ENABLED=1 y LTI_ENABLED=0 —una instalación que sólo usa el módulo, que es
# el caso que la Fase A viene a habilitar— este snippet quedaba vacío y el
# alumno veía un iframe en blanco: el 302 de /mod/launch llegaba bien y era
# /s/{slug} el que salía con `X-Frame-Options: SAMEORIGIN` por `location /`.
# `/lti-select`, en cambio, es la pantalla del deep linking de LTI y el módulo
# no la usa, así que sigue atada sólo a LTI_ENABLED.
: > "$LTI_SNIPPET"
if prendido "${LTI_ENABLED:-}"; then
    # Heredoc entrecomillado para que `$http_upgrade` y compañía lleguen a
    # nginx literales, sin que la shell los expanda. El único valor que sí hay
    # que interpolar entra después, por su marcador.
    cat >> "$LTI_SNIPPET" <<'EOF'
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
  add_header Content-Security-Policy "frame-ancestors __ANCESTROS__" always;
}
EOF
fi

if prendido "${LTI_ENABLED:-}" || prendido "${MOD_ENABLED:-}"; then
    cat >> "$LTI_SNIPPET" <<'EOF'
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
  add_header Content-Security-Policy "frame-ancestors __ANCESTROS__" always;
}
EOF
fi

# Con las dos apagadas el archivo queda vacío (se truncó arriba) y `location /`
# sigue sirviendo /lti-select y /s/ tal como hoy: X-Frame-Options: SAMEORIGIN,
# sin CSP de framing. `/lti/` y `/mod/` son estáticos en nginx.conf y no
# dependen de esta escritura.
#
# `|` como delimitador porque el valor son URLs y trae `/`. El contenido lo
# pone quien despliega, mismo nivel de confianza que el resto de este script.
sed -i "s|__ANCESTROS__|${ANCESTROS}|g" "$LTI_SNIPPET"

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
