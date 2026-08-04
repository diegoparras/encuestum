#!/usr/bin/env bash
# Levanta Moodle + Encuestum. Equivalente de up.ps1 para Linux y WSL.
#
# Arranque en dos fases — no es opcional, es la razón de ser de este script
# (ver "Por qué hace falta confiar en la CA de Caddy" en el README de esta
# carpeta): Caddy genera su CA local recién al arrancar, y esa CA es distinta
# cada vez que se recrea el volumen `caddy_data` (`docker compose down -v`).
# Ni Moodle ni Encuestum pueden confiar en una CA que todavía no existe, así
# que:
#   1. Arranca SOLO Caddy y espera a que la CA aparezca en su volumen.
#   2. Extrae esa CA a `caddy-root.crt` en esta carpeta (gitignored: es
#      contenido generado, no fuente).
#   3. Recién ahí levanta el resto — `moodle` y `encuestum` montan ese archivo
#      de solo lectura y cada uno lo suma a su propio almacén de confianza
#      ANTES de arrancar su aplicación.
#
# Ojo con el orden: `caddy-root.crt` tiene que existir como ARCHIVO antes de
# que Docker monte los servicios que lo usan. Si no existe, Docker crea un
# directorio vacío con ese nombre y el montaje queda inservible.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

CERT="$PWD/caddy-root.crt"

# Los nombres son `lvh.me` y no `.localhost` a propósito: libcurl resuelve
# `*.localhost` a loopback por su cuenta y Moodle, que usa curl, nunca llegaba
# a Encuestum (ver el comentario largo en el Caddyfile). `lvh.me` apunta a
# 127.0.0.1 por DNS público, así que no hace falta tocar el archivo hosts.
if ! getent hosts moodle.lvh.me >/dev/null 2>&1; then
    echo "AVISO: moodle.lvh.me no resuelve. Es un dominio público que apunta a" >&2
    echo "       127.0.0.1, así que esto suele significar que no hay DNS o que" >&2
    echo "       algo lo está bloqueando. Los contenedores igual van a andar" >&2
    echo "       entre ellos (usan el DNS de Docker); el que no va a poder" >&2
    echo "       entrar es tu navegador." >&2
    echo >&2
fi

echo "Fase 1/2: arrancando Caddy solo (para generar su CA local)..."
docker compose up -d caddy

echo "Esperando a que Caddy genere su CA interna..."
rm -rf "$CERT"
deadline=$((SECONDS + 120))
until [ -s "$CERT" ]; do
    sleep 2
    # Caddy provisiona la CA al cargar la config de `tls internal`, antes de
    # servir el primer request: no hace falta que nadie le pegue para que exista.
    docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CERT" >/dev/null 2>&1 || true
    if [ ! -s "$CERT" ] && [ "$SECONDS" -gt "$deadline" ]; then
        echo "ERROR: la CA de Caddy no apareció en 2 minutos. Revisá: docker compose logs caddy" >&2
        exit 1
    fi
done
echo "  CA extraída a $CERT"

echo "Fase 2/2: levantando Moodle y Encuestum (la primera vez tarda varios minutos:"
echo "          hay que construir la imagen de Encuestum e instalar Moodle entero)..."
docker compose up -d --build

# Se consulta a través de Caddy, igual que lo hará el navegador, así que este
# chequeo también valida que el proxy y los certificados estén bien.
espera() {
    local nombre="$1" url="$2" minutos="$3" servicio="$4"
    echo "Esperando a que $nombre responda..."
    local deadline=$((SECONDS + minutos * 60))
    until curl -sk --max-time 10 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -q '^200$'; do
        sleep 5
        if [ "$SECONDS" -gt "$deadline" ]; then
            echo "ERROR: $nombre no respondió en $minutos minutos. Revisá: docker compose logs $servicio" >&2
            exit 1
        fi
    done
}

espera "Moodle" "https://moodle.lvh.me/login/index.php" 15 moodle
espera "Encuestum" "https://encuestum.lvh.me/lti/jwks.json" 3 encuestum

# Moodle trae su propia protección anti-SSRF: `curlsecurityblockedhosts` viene
# con 172.16.0.0/12 entre otras redes privadas, y la red de Docker cae justo
# ahí. Con eso, la llamada de Moodle al jwks_uri del tool devuelve "The URL is
# blocked", no puede validar el client_assertion de AGS, y responde 404 al
# pedido de token: la nota nunca llega y el único rastro es un 404 opaco.
# Es el espejo exacto de ENCUESTUM_ALLOW_PRIVATE_OUTBOUND, que ya se activa en
# docker-compose.yml por el mismo motivo. SOLO para este entorno: en producción
# el LMS y el tool están en dominios públicos y no hace falta tocar nada.
#
# El CLI se corre como `daemon` (el usuario de Apache en esta imagen) y no como
# root: si crea archivos de caché siendo root, Apache después no puede
# escribirlos y Moodle empieza a responder 500 con "Invalid permissions
# detected when trying to create a directory".
echo "Permitiendo que Moodle alcance direcciones privadas (solo en dev)..."
docker compose exec -T -u daemon moodle \
    php /opt/bitnami/moodle/admin/cli/cfg.php \
    --name=curlsecurityblockedhosts --set="" >/dev/null

echo
echo "Listo."
echo "  Moodle:    https://moodle.lvh.me     (admin / ${MOODLE_ADMIN_PASSWORD:-Encuestum#2026})"
echo "  Encuestum: https://encuestum.lvh.me"
echo
echo "Moodle y Encuestum ya confían entre sí en la CA de Caddy (se hizo solo, ver README)."
echo "Si TU NAVEGADOR desconfía del certificado, instalá esa misma CA — desde PowerShell"
echo "en Windows, con el repo en E: y sin necesidad de permisos de administrador:"
echo '  Import-Certificate -FilePath .\dev\moodle\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root'
