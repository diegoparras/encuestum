#!/usr/bin/env pwsh
# Levanta Moodle + Encuestum y explica los pasos manuales que quedan.
# Requiere PowerShell 7+ (pwsh) y Docker Desktop corriendo.
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
#   3. Recién ahí levanta el resto — `moodle` y `encuestum` montan ese
#      archivo de solo lectura y cada uno lo suma a su propio almacén de
#      confianza ANTES de arrancar su aplicación (ver los comentarios de
#      `entrypoint`/`command` de cada servicio en docker-compose.yml).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Fase 1/2: arrancando Caddy solo (para generar su CA local)..." -ForegroundColor Cyan
docker compose up -d caddy

Write-Host "Esperando a que Caddy genere su CA interna..." -ForegroundColor Cyan
$certPath = Join-Path $PSScriptRoot "caddy-root.crt"
if (Test-Path $certPath) { Remove-Item $certPath -Force }
$deadline = (Get-Date).AddMinutes(2)
do {
    Start-Sleep -Seconds 2
    # Caddy provisiona la CA (root.crt + intermediate.crt) al cargar la
    # config de `tls internal`, antes de servir el primer request — no hace
    # falta que nadie le pegue un request para que exista. Layout confirmado
    # contra la documentación oficial de Caddy (carpeta `pki/authorities/local`
    # dentro de `caddy_data`, https://caddyserver.com/docs/conventions#data-directory
    # y https://caddyserver.com/docs/caddyfile/options#local-certs).
    docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt $certPath 2>$null
    $ok = (Test-Path $certPath) -and ((Get-Item $certPath).Length -gt 0)
    if (-not $ok -and (Get-Date) -gt $deadline) {
        throw "La CA de Caddy no aparecio en 2 minutos. Revisa: docker compose logs caddy"
    }
} until ($ok)
Write-Host "  CA extraida a $certPath" -ForegroundColor DarkGray

Write-Host "Fase 2/2: levantando Moodle y Encuestum (la primera vez Moodle tarda varios minutos)..." -ForegroundColor Cyan
docker compose up -d --build

Write-Host "Esperando a que Moodle responda..." -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(10)
do {
    Start-Sleep -Seconds 10
    try {
        $r = Invoke-WebRequest -Uri "https://moodle.localhost/login/index.php" -SkipCertificateCheck -TimeoutSec 10
        $ok = $r.StatusCode -eq 200
    } catch { $ok = $false }
    if (-not $ok -and (Get-Date) -gt $deadline) {
        throw "Moodle no respondió en 10 minutos. Revisá: docker compose logs moodle"
    }
} until ($ok)

Write-Host "Esperando a que Encuestum responda..." -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(3)
do {
    Start-Sleep -Seconds 5
    try {
        $r = Invoke-WebRequest -Uri "https://encuestum.localhost/lti/jwks.json" -SkipCertificateCheck -TimeoutSec 10
        $ok = $r.StatusCode -eq 200
    } catch { $ok = $false }
    if (-not $ok -and (Get-Date) -gt $deadline) {
        throw "Encuestum no respondió en 3 minutos. Revisá: docker compose logs encuestum"
    }
} until ($ok)

$adminPassword = if ($env:MOODLE_ADMIN_PASSWORD) { $env:MOODLE_ADMIN_PASSWORD } else { 'Encuestum#2026' }

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
Write-Host "  Moodle:    https://moodle.localhost     (admin / $adminPassword)"
Write-Host "  Encuestum: https://encuestum.localhost"
Write-Host ""
Write-Host "Moodle y Encuestum ya confian entre si en la CA de Caddy (se hizo solos, ver README)." -ForegroundColor DarkGray
Write-Host "Si TU NAVEGADOR desconfía del certificado, instalá esa misma CA (ya extraída en esta carpeta):" -ForegroundColor Yellow
Write-Host '  Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root'
