# Deploy de Encuestum en EasyPanel — de cero a producción

Manual completo para dejar Encuestum andando **en tu propio VPS con EasyPanel**, prolijo y
listo para usar. Encuestum es **una sola imagen Docker all-in-one** (nginx + Next.js + FastAPI,
todo adentro): en EasyPanel se crea como **una App**, se le pone el dominio y se configura por
**variables de entorno**. El contenedor escucha en el **puerto 80**, y el frontend habla con el
backend *same-origin* (nginx enruta `/api/`), así que **no hay que configurar ninguna URL de API**.

> **Al final vas a tener**: `https://encuestas.tudominio.com` con TLS, base Postgres, tu cuenta
> de owner creada, y (opcional) IA, emails, almacenamiento de videos en R2/S3 y SSO de la Suite.

> ¿Querés el **stack completo de la Suite** (Encuestum + Cloudflare R2 + hub Lockatus con SSO)
> en un solo instructivo? → [`DEPLOY_EASYPANEL_SUITE.md`](DEPLOY_EASYPANEL_SUITE.md).

---

## 0. Requisitos

- Un **VPS** (2 vCPU / 2 GB RAM alcanzan para arrancar) con **EasyPanel** instalado.
  Si no lo tenés: `curl -sSL https://get.easypanel.io | sh` y entrás a `http://IP:3000`.
- Un **dominio** (o subdominio) apuntando a la IP del VPS (un registro **A**). Ej:
  `encuestas.tudominio.com → 203.0.113.10`.
- La **imagen** de Encuestum publicada en GHCR (ya sale sola con cada release):
  `ghcr.io/diegoparras/encuestum:latest` y `:vX.Y.Z`.

> **Importante — imagen pública.** Para que EasyPanel la pullee **sin credenciales**, el package
> de GHCR tiene que estar **público**: `github.com/diegoparras?tab=packages` → **encuestum** →
> *Package settings* → *Change visibility* → **Public**. (Si preferís dejarlo privado, en EasyPanel
> vas a **Settings → Registries** y cargás GHCR con un PAT de scope `read:packages`.)

---

## 1. Crear el proyecto

En EasyPanel → **Create Project** → ponele un nombre (ej. `escriba`). Todos los servicios de
Encuestum (base + app) viven adentro de este proyecto y se hablan por su **red interna**.

---

## 2. Base de datos (Postgres)

Podés usar **Postgres** (recomendado en producción) o **SQLite** (más simple, con un volumen).

**Opción A — Postgres (recomendada):**
1. Dentro del proyecto → **Create → Postgres**.
2. Ponele nombre (ej. `encuestum-db`), definí usuario/clave/DB (o dejá los que sugiere).
3. Deploy. EasyPanel te da un **host interno** (algo como `escriba_encuestum-db`) y el puerto `5432`.
4. Armá el `DATABASE_URL` con esos datos (lo usás en el paso 4):
   ```
   postgresql://USUARIO:CLAVE@HOST_INTERNO:5432/DBNAME
   ```

**Opción B — SQLite:** no creás nada acá; en la App montás un **volumen en `/app_data`**
(ahí vive `encuestum.db`). Sirve para instancias chicas de una sola réplica.

---

## 3. Crear la App Encuestum

Dentro del proyecto → **Create → App**:

1. **Source → Docker Image**:
   ```
   ghcr.io/diegoparras/encuestum:v1.1.3
   ```
   > Usá el **tag de versión** (inmutable) en vez de `:latest`, así controlás cuándo actualizás y
   > podés volver atrás con precisión.
2. **Ports / Domains** → agregá tu dominio (`encuestas.tudominio.com`) mapeado al **puerto 80** del
   contenedor. EasyPanel emite el certificado **Let's Encrypt** solo (HTTPS automático).
3. **Volumes** (solo si usás **SQLite**): montá un volumen persistente en **`/app_data`**.
   Con Postgres externo no hace falta.
4. **Environment** → pegá las variables del paso 4.
5. **Deploy.**

Al arrancar, Encuestum **corre las migraciones y crea el esquema solo**. No hay que hacer nada más.

---

## 4. Variables de entorno (lo mínimo)

Referencia completa en [`.env.example`](../.env.example). Lo mínimo para producción:

```env
# Base de datos (Postgres del paso 2). Con SQLite, omitila (usa /app_data).
DATABASE_URL=postgresql://USUARIO:CLAVE@HOST_INTERNO:5432/DBNAME

# OBLIGATORIA — firma las cookies de sesión. Estable y secreta:
#   openssl rand -hex 32
ENCUESTUM_SESSION_SECRET=<hex de 64 caracteres>

# URL pública de la app (los links de los emails apuntan acá):
ENCUESTUM_PUBLIC_URL=https://encuestas.tudominio.com

# Cookies solo por HTTPS (default true; dejalo así con TLS):
ENCUESTUM_COOKIE_SECURE=true
```

Qué hace cada una:
- **`ENCUESTUM_SESSION_SECRET`** — si no la ponés, se genera una efímera y **las sesiones se caen
  en cada reinicio** (vas a ver un warning en el log). **Fijala.**
- **`DATABASE_URL`** — esquema plano `postgresql://…`; la app le agrega el driver async sola (la
  imagen ya trae `asyncpg`).
- **`ENCUESTUM_PUBLIC_URL`** — el dominio público; se usa en los enlaces de invitaciones/reset.
- **`ENCUESTUM_COOKIE_SECURE`** — `true` con HTTPS (lo normal en EasyPanel).

> Cambiar variables después = botón **Redeploy** de la App.

---

## 5. Primer arranque

1. Entrá a `https://encuestas.tudominio.com`.
2. **Crear cuenta** → esa primera cuenta crea su **organización** y queda como **owner**.
3. *(Opcional)* Convertite en **super-admin de la plataforma** (ver todas las orgs/uso) seteando
   `ENCUESTUM_SUPERADMIN_EMAIL=vos@tudominio.com` y Redeploy.
4. *(Opcional)* Cerrá el auto-registro cuando ya tengas tus cuentas: `ENCUESTUM_ALLOW_REGISTRATION=false`.

Listo — ya podés crear encuestas. Lo de abajo es **opcional**, activás lo que necesites.

---

## 6. Extras (activá lo que quieras)

### 🗄️ Almacenamiento de videos/archivos (R2 / S3) — recomendado
Por defecto los archivos que suben los respondientes van al disco del contenedor. En producción
conviene un **bucket** (Cloudflare R2 con egress gratis, o S3/MinIO): los videos suben **directo
del navegador al bucket**, el server no los bufferea. El bucket queda **privado** — la app sirve
los archivos same-origin y su ruta nunca se expone; los archivos de respuesta solo los ven
miembros de la organización.
```
ENCUESTUM_STORAGE=s3
ENCUESTUM_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
ENCUESTUM_S3_BUCKET=encuestum
ENCUESTUM_S3_ACCESS_KEY_ID=...
ENCUESTUM_S3_SECRET_ACCESS_KEY=...
ENCUESTUM_S3_REGION=auto
```
El bucket solo necesita una regla **CORS** que permita `PUT` desde tu dominio (para la subida
directa). No habilites acceso público de lectura.
👉 Guía completa (bucket, **CORS**, control de acceso, migración): [`ALMACENAMIENTO_EXTERNO.md`](ALMACENAMIENTO_EXTERNO.md).

### ✉️ Emails (invitaciones, reset, verificación)
Sin SMTP, los emails se **loguean** (el enlace queda en el log) — sirve para probar. Para enviarlos
de verdad (Gmail, Brevo, Mailgun, SendGrid, SES, Resend…):
```
ENCUESTUM_SMTP_HOST=smtp.tu-proveedor.com
ENCUESTUM_SMTP_PORT=587
ENCUESTUM_SMTP_USER=...
ENCUESTUM_SMTP_PASSWORD=...
ENCUESTUM_SMTP_TLS=true
ENCUESTUM_EMAIL_FROM=Encuestum <no-reply@tudominio.com>
```

### 🤖 IA (bring-your-own-key)
Genera preguntas desde un documento y corrige respuestas abiertas. Con tu propia key (OpenRouter/
OpenAI/endpoint propio). Sin key, la corrección determinística igual anda.
```
ENCUESTUM_LLM_API_KEY=<tu-key>
# ENCUESTUM_LLM_BASE_URL=https://openrouter.ai/api/v1   # default
# ENCUESTUM_LLM_MODEL=openai/gpt-4o-mini                # default
```

### 🛡️ Captcha anti-bot (encuestas públicas)
Proof-of-work self-hosted, sin terceros. Se activa **por encuesta** en el panel de Acceso; el
kill-switch global es `ENCUESTUM_CAPTCHA_ENABLED=true` (default). Ver [`SEGURIDAD.md`](SEGURIDAD.md).

### 🌐 Subdominio propio por organización
Cada org puede reclamar `acme.tudominio.com` con su branding. Requiere DNS wildcard + TLS wildcard.
```
ENCUESTUM_BASE_DOMAIN=tudominio.com
```
👉 Guía: [`SUBDOMINIOS.md`](SUBDOMINIOS.md).

### 🔗 SSO con Lockatus (login unificado de la Suite)
Si corrés la Suite Escriba, delegá el login en **Lockatus** (OIDC): una sola identidad para todas
las apps, con 2FA. Default `local` (login propio).
```
AUTH_MODE=federado
LOCKATUS_ISSUER=https://identidad.tudominio.com
LOCKATUS_CLIENT_ID=encuestum
LOCKATUS_REDIRECT_URI=https://encuestas.tudominio.com/api/v1/auth/sso/callback
```
👉 Requiere declarar la app en el hub. Guía: [`LOCKATUS.md`](LOCKATUS.md).

### ⚙️ Detrás del proxy de EasyPanel
El proxy de EasyPanel setea `X-Forwarded-For`. Para que el rate-limit vea la IP real:
```
ENCUESTUM_TRUST_PROXY=true
ENCUESTUM_ENABLE_HSTS=true
```

### 📈 Escalar (más de una réplica)
Si corrés varias réplicas, compartí el rate-limit con Redis:
```
ENCUESTUM_REDIS_URL=redis://HOST_INTERNO:6379/0
```

---

## 7. Actualizar a una versión nueva

1. En GitHub, la nueva versión ya publicó su imagen (`ghcr.io/diegoparras/encuestum:vX.Y.Z`).
2. En la App de EasyPanel → cambiá la **Image** al tag nuevo → **Deploy**.
3. Al arrancar, corre las **migraciones nuevas solas** (son idempotentes). Cero downtime de datos.

> Volver atrás = poné el tag anterior y Deploy. (Por eso conviene fijar el tag y no `:latest`.)

---

## 8. Backups

- **Postgres**: usá el backup del servicio Postgres de EasyPanel (o un `pg_dump` programado). Es la
  fuente de verdad de encuestas, respuestas y usuarios.
- **Archivos**: si usás **R2/S3**, ya están afuera (durables). Si usás **SQLite/local**, respaldá el
  **volumen `/app_data`** (incluye la DB y los assets).

---

## 9. Troubleshooting

| Síntoma | Causa probable / fix |
|---|---|
| La app no levanta / 502 | Revisá los **logs** de la App. Casi siempre falta `DATABASE_URL` bien armado o el Postgres no está *ready*. |
| "Sesión inválida" tras cada reinicio | Falta `ENCUESTUM_SESSION_SECRET` estable (se regenera efímero). Fijalo. |
| EasyPanel no puede pullear la imagen | El package de GHCR está **privado** → hacelo público, o cargá un Registry con PAT. |
| "No se pudo subir el video" | CORS del bucket (falta tu dominio o el método `PUT`) — ver [`ALMACENAMIENTO_EXTERNO.md`](ALMACENAMIENTO_EXTERNO.md). |
| Los emails no llegan | Sin SMTP se **loguean** (mirá el log). Con SMTP, revisá host/puerto/credenciales. |
| Cookies no persisten | Con HTTPS, `ENCUESTUM_COOKIE_SECURE=true`. Con HTTP plano (no recomendado), ponelo en `false`. |

---

## 10. Checklist de producción

- [ ] `ENCUESTUM_SESSION_SECRET` estable (`openssl rand -hex 32`).
- [ ] Dominio con **HTTPS** (TLS de EasyPanel) + `ENCUESTUM_COOKIE_SECURE=true` + `ENCUESTUM_ENABLE_HSTS=true`.
- [ ] `DATABASE_URL` a Postgres (o volumen en `/app_data` si SQLite).
- [ ] `ENCUESTUM_PUBLIC_URL` = tu dominio público.
- [ ] `ENCUESTUM_TRUST_PROXY=true` (estás detrás del proxy de EasyPanel).
- [ ] `ENCUESTUM_SUPERADMIN_EMAIL` seteado (email verificado).
- [ ] Almacenamiento externo (R2/S3) para los videos — [`ALMACENAMIENTO_EXTERNO.md`](ALMACENAMIENTO_EXTERNO.md).
- [ ] SMTP para emails reales.
- [ ] Captcha anti-bot en las encuestas públicas y abiertas.
- [ ] Backups de Postgres (y del volumen si usás local).
- [ ] Imagen **fijada por tag** (`vX.Y.Z`), no `:latest`.

Más profundidad: [Seguridad](SEGURIDAD.md) · [Almacenamiento externo](ALMACENAMIENTO_EXTERNO.md) ·
[Lockatus / SSO](LOCKATUS.md) · [Subdominios](SUBDOMINIOS.md).

---

## Anexo — probar la imagen localmente (sin EasyPanel)

```bash
docker run --rm -p 8080:80 -v encuestum_data:/app_data \
  -e ENCUESTUM_SESSION_SECRET=$(openssl rand -hex 32) \
  ghcr.io/diegoparras/encuestum:latest
# http://localhost:8080  → panel;  http://localhost:8080/docs → API
```
