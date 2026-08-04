#!/usr/bin/env pwsh
# Levanta Moodle + Encuestum y explica los pasos manuales que quedan.
# Requiere PowerShell 7+ (pwsh) y Docker Desktop corriendo.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Levantando el entorno (la primera vez Moodle tarda varios minutos)..." -ForegroundColor Cyan
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
Write-Host "Si el navegador desconfía del certificado, instalá la CA de Caddy:" -ForegroundColor Yellow
Write-Host '  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt'
Write-Host '  Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root'
