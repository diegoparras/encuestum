<div align="center">

<img src="frontend/app/icon.svg" width="88" height="88" alt="Encuestum" />

# Encuestum

### Encuestas y evaluaciones con corrección por IA — self-hosted, open source.

**Mejor que Google Forms y Microsoft Forms.** Formularios tipo Typeform, exámenes que se corrigen solos, control de acceso serio, analítica de embudo, video-respuestas, y un motor de IA _bring-your-own-key_. Todo tuyo, en tu servidor.

[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-8FAF0E.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/Self--hosted-Docker-8FAF0E.svg)](#-instalación-rápida)
[![Backend](https://img.shields.io/badge/Backend-FastAPI-009688.svg)](#-arquitectura)
[![Frontend](https://img.shields.io/badge/Frontend-Next.js%2016-000000.svg)](#-arquitectura)
[![SurveyJS](https://img.shields.io/badge/Runtime-SurveyJS-1ab394.svg)](https://surveyjs.io/)

</div>

---

Encuestum es una **plataforma multi-tenant** de encuestas y evaluaciones. Cualquiera con el link responde en el navegador; los docentes generan preguntas desde un documento y corrigen respuestas abiertas con IA (rúbrica + LLM, con evidencia citada y resistencia a inyección de prompt); las empresas miden NPS con analítica de embudo. Se despliega como **una sola imagen Docker** y usa **tu propia API key** de IA (nunca la nuestra: no hay "nuestra").

> **TL;DR** — Un comando y tenés tu propio Typeform + Forms + corrector con IA corriendo en tu server:
> ```bash
> cp .env.example .env      # poné un ENCUESTUM_SESSION_SECRET
> docker compose -f docker-compose.prod.yml up -d
> # → http://localhost:8080
> ```

## Tabla de contenidos

- [✨ Qué hace](#-qué-hace)
- [🚀 Instalación rápida](#-instalación-rápida)
- [🐳 Deploy con Docker](#-deploy-con-docker)
- [🎛️ Deploy en EasyPanel](#️-deploy-en-easypanel)
- [⚙️ Configuración (variables de entorno)](#️-configuración-variables-de-entorno)
- [🗄️ Almacenamiento externo (Cloudflare R2 / S3)](#️-almacenamiento-externo-cloudflare-r2--s3)
- [✉️ Email / SMTP](#️-email--smtp)
- [🤖 Inteligencia artificial (bring-your-own-key)](#-inteligencia-artificial-bring-your-own-key)
- [🌐 Subdominio propio por organización](#-subdominio-propio-por-organización)
- [🧱 Arquitectura](#-arquitectura)
- [💻 Desarrollo local](#-desarrollo-local)
- [🔐 Seguridad](#-seguridad)
- [🤝 Contribuir](#-contribuir)
- [📄 Licencia](#-licencia)

---

## ✨ Qué hace

### 📝 Editor y tipos de pregunta
- **Editor visual** drag-and-drop con **vista previa en vivo** y **plantillas** listas (NPS, feedback, registro a evento, evaluación de curso, quiz…).
- **14 tipos de pregunta**: texto, párrafo, email, opción única/múltiple, desplegable, **escala/NPS** (con 6 presentaciones: números, rectángulos, gradiente de colores, estrellas, caritas, caritas de colores), sí/no, **opción-imagen**, **matriz** (grilla), **ranking**, **fecha**, **subir archivo**, y **respuesta en video** (grabación por webcam, estilo Typeform).
- **Secciones** para agrupar preguntas (páginas estilo Google Forms o portadas estilo Typeform).
- **Lógica condicional** (mostrar según otra respuesta), **bifurcación / saltos** (ir a otra sección o terminar según la respuesta) y **piping** (`{pregunta}` en el texto).
- **Autosave** en el editor: nunca perdés trabajo.

### 🎨 Diseño de otra liga
Panel de diseño con **temas de un clic** (claros y oscuros), **modo oscuro** de la encuesta, **buscador de Google Fonts**, color de acento/fondo/texto, **cuadros glass** (color + opacidad + desenfoque), **contenedor por pregunta**, **transiciones** entre pantallas (fundido, deslizar, zoom, voltear, desenfoque), **alineación** (izquierda/centro), color y sombra de botones, imágenes (portada, logo, fondo con opacidad, por pregunta), video embebido y **música de fondo**. Además, **estilo por pregunta**: transparencia y alineación individuales.

**💬 Modo conversacional (chat).** Un motor de chat tipo Typebot montado sobre el render: una pregunta a la vez, respuestas como **quick-reply chips**, indicador de *"escribiendo…"*, auto-avance y burbujas. Con **9 skins de un clic** (Encuestum, WhatsApp, Telegram, iMessage, Messenger, Slack, Discord, Terminal, Minimal), **identidad del bot** (avatar + nombre + estado) y comportamiento configurable.

### 🚪 Distribución y control de acceso
- Página pública `/s/{slug}` (SurveyJS en el navegador), **código QR**, **embed** por iframe, **links con prefill** (`?campo=valor`), guardar-y-retomar.
- **3 modos de acceso** por encuesta: **pública**, **con clave (PIN)**, o **lista de emails admitidos** — cada persona con su **código único** (para entrar y para ver su resultado después) y **link mágico** por email.
- **Cierre automático** por fecha o cupo.
- **Protección anti-bot** opcional en encuestas públicas: un **captcha proof-of-work** self-hosted (sin terceros, sin keys, invisible para la persona) que frena el spam de respuestas.
- **Pantalla de gracias totalmente customizable**: **confeti**, ícono/emoji/imagen a elección, layouts (tarjeta/minimal/hero), colores propios, **tokens** (`¡Gracias, {nombre}!`), **botones CTA**, **compartir** (WhatsApp/X/LinkedIn), **redirect con cuenta regresiva** — y en modo chat, cierre como última burbuja del bot.

### 📊 Resultados y analítica
- Panel **"Resumen"** con **gráficos por pregunta** (barras, histograma NPS con promedio, respuestas abiertas, archivos/videos).
- **Embudo de conversión**: vistas → comenzaron → completaron, con **dónde abandonan**.
- **Export CSV / Excel**, **duplicar** encuesta, **notificaciones por email** al recibir respuestas, **webhooks** firmados (HMAC) para Zapier / Google Sheets / Make, y **borrado de respuesta** individual (GDPR).

### 🧠 Inteligencia artificial (BYO-key)
- **Genera** preguntas desde un tema o un **documento/markdown** que pegás o subís.
- **Corrige** respuestas abiertas con un motor híbrido (rúbrica determinística + LLM): puntaje, veredicto, feedback, **evidencia citada**, `needs_review` e `injection_flag`, con doble pasada.
- **Gestión de proveedores de IA** (OpenAI / OpenRouter / endpoint propio) por organización o globales, con listado de modelos en vivo y **rastreo de consumo** (tokens y costo aprox. por llamada).

### 🎓 Evaluaciones y educación
Modo examen con integridad (mezclar preguntas/opciones, tiempo límite, intentos), **cola de revisión**, override manual, **gradebook** (planilla de notas por alumno) y **certificado imprimible** al aprobar.

### 🏢 Plataforma
Multi-tenant (organizaciones, roles owner/admin/member), invitaciones, reset de contraseña, verificación de email, **subdominio propio por organización** con branding, panel de super-admin, **interfaz en 7 idiomas** (English, Español, Français, Português, Italiano, 中文, 日本語), y **almacenamiento de archivos directo a Cloudflare R2 / S3** con URL prefirmada (el servidor no toca los archivos grandes).

---

## 🚀 Instalación rápida

**Requisitos:** Docker (con Compose). Nada más.

```bash
git clone https://github.com/diegoparras/encuestum.git
cd encuestum
cp .env.example .env
# Editá .env y poné un secreto real:
#   ENCUESTUM_SESSION_SECRET=$(openssl rand -hex 32)
docker compose -f docker-compose.prod.yml up -d
```

Abrí **http://localhost:8080** → **Crear cuenta** → ¡a armar tu primera encuesta!

Esto levanta la app all-in-one **+ PostgreSQL** con datos persistentes. Los detalles de cada modo de deploy están abajo.

---

## 🐳 Deploy con Docker

Encuestum se empaqueta como **una sola imagen all-in-one**: nginx (puerto 80) enruta el frontend (Next.js) y `/api/` al backend (FastAPI). El frontend habla con el backend **same-origin**, así que en producción no configurás ninguna URL de API.

Imagen publicada: **`ghcr.io/diegoparras/encuestum:latest`**

### Opción A — Compose con Postgres (recomendado)

El archivo [`docker-compose.prod.yml`](docker-compose.prod.yml) levanta la app + Postgres de una:

```bash
cp .env.example .env      # poné ENCUESTUM_SESSION_SECRET
docker compose -f docker-compose.prod.yml up -d
# → http://localhost:8080  ·  datos en el volumen encuestum_pg
```

Detrás de un dominio con HTTPS, en `.env`:
```bash
ENCUESTUM_PUBLIC_URL=https://encuestas.tudominio.com
ENCUESTUM_COOKIE_SECURE=true
```
y serví el puerto 8080 detrás de tu reverse proxy (nginx/Caddy/Traefik).

### Opción B — Imagen suelta (SQLite, para probar)

```bash
docker run --rm -p 8080:80 -v encuestum_data:/app_data \
  -e ENCUESTUM_SESSION_SECRET=$(openssl rand -hex 32) \
  -e ENCUESTUM_COOKIE_SECURE=false \
  ghcr.io/diegoparras/encuestum:latest
```
Usa SQLite dentro del volumen `/app_data`. Perfecto para una prueba rápida; para producción usá Postgres (Opción A).

### Opción C — Buildear la imagen vos mismo

```bash
docker build -t encuestum:local .
```

---

## 🎛️ Deploy en EasyPanel

EasyPanel es la forma más cómoda de correrlo en un VPS. Encuestum es **una App** (no compose): corre la imagen y se configura por variables de entorno. Guía completa en [`docs/DEPLOY_EASYPANEL.md`](docs/DEPLOY_EASYPANEL.md). Resumen:

1. **Base de datos** → en tu proyecto de EasyPanel, creá un servicio **Postgres** (te da un host interno tipo `tuproyecto_encuestum-db`).
2. **App** → **Create** → **App** → source **Docker Image**: `ghcr.io/diegoparras/encuestum:latest`.
   > Si el package de GHCR es **público**, se pullea sin credenciales. Si lo dejaste privado, cargá un Registry con un PAT (`read:packages`).
3. **Environment** de la App:
   ```
   DATABASE_URL=postgresql://USER:PASS@HOST_INTERNO:5432/DBNAME
   ENCUESTUM_SESSION_SECRET=<openssl rand -hex 32>
   ENCUESTUM_PUBLIC_URL=https://encuestas.tudominio.com
   ENCUESTUM_COOKIE_SECURE=true
   ```
4. **Ports / Domains** → mapeá el dominio al **puerto 80** del contenedor. EasyPanel emite el certificado (Let's Encrypt) automáticamente.
5. **Deploy**. Al arrancar corre las migraciones solo y crea todo el esquema. Entrá a tu dominio → **Crear cuenta**.
6. *(Opcional)* Sumá `ENCUESTUM_SMTP_*`, `ENCUESTUM_STORAGE=s3`, `ENCUESTUM_SUPERADMIN_EMAIL`, etc. (ver abajo). Cambiar variables = **Redeploy**.

> **Volumen**: si usás SQLite en vez de Postgres, montá un volumen en `/app_data` para no perder los datos entre deploys. Con Postgres externo no hace falta.

---

## ⚙️ Configuración (variables de entorno)

Todo se configura por env con prefijo `ENCUESTUM_*`. Ver [`.env.example`](.env.example) para la lista completa y comentada. Las principales:

| Variable | Default | Para qué |
|---|---|---|
| `ENCUESTUM_SESSION_SECRET` | *(efímero)* | **Firma las sesiones. OBLIGATORIO en prod** (`openssl rand -hex 32`). Si no lo fijás, las sesiones se invalidan en cada reinicio. |
| `DATABASE_URL` | *(SQLite)* | `postgresql://user:pass@host:5432/db` para Postgres. Sin esto usa SQLite en `ENCUESTUM_DATA_DIR`. |
| `ENCUESTUM_PUBLIC_URL` | *(CORS[0])* | URL base pública (para los links de los emails). En prod, tu dominio. |
| `ENCUESTUM_COOKIE_SECURE` | `true` | Cookies solo-HTTPS. Poné `false` solo en http local. |
| `ENCUESTUM_ALLOW_REGISTRATION` | `true` | Auto-registro público. `false` para cerrar el alta. |
| `ENCUESTUM_REQUIRE_EMAIL_VERIFICATION` | `false` | Exigir verificar el email antes de usar la cuenta. |
| `ENCUESTUM_SUPERADMIN_EMAIL` | — | Email (verificado) que obtiene el panel de super-admin de la plataforma. |
| `ENCUESTUM_CORS_ORIGINS` | *(same-origin)* | Orígenes permitidos (solo si front y back van en dominios distintos). |
| `ENCUESTUM_TRUST_PROXY` | `false` | Poné `true` solo si estás detrás de un proxy propio (nginx) para leer bien la IP real (rate limiting). |
| `ENCUESTUM_LLM_API_KEY` | — | Key del proveedor LLM (o configurá la IA desde la pantalla **IA** de la app). |
| `ENCUESTUM_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible. |
| `ENCUESTUM_LLM_MODEL` | `openai/gpt-4o-mini` | Modelo por defecto. |
| `ENCUESTUM_STORAGE` | `local` | `s3` para subir a Cloudflare R2 / S3 (ver abajo). |
| `ENCUESTUM_SMTP_HOST` … | — | Email para invitaciones/links/notificaciones (ver abajo). |
| `ENCUESTUM_BASE_DOMAIN` | — | Habilita subdominios por organización (`acme.tudominio.com`). |
| `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND` | `false` | Permite webhooks/LLM hacia IPs internas (ej. Ollama en `localhost`). Dejalo en `false` si es multi-tenant. |

---

## 🗄️ Almacenamiento externo (Cloudflare R2 / S3)

Por defecto, los archivos que suben los respondientes (videos, adjuntos) se guardan en el **disco** del contenedor (`ENCUESTUM_DATA_DIR/assets`). Perfecto para empezar, pero **no escala** ni sobrevive a un contenedor efímero. Para producción, usá **almacenamiento de objetos**.

### Cómo funciona (por qué no te explota el servidor)
Encuestum genera una **URL prefirmada** y el navegador del respondiente **sube el archivo DIRECTO al bucket** — el servidor **nunca toca** el archivo grande. Barato, rápido y escalable.

### Recomendado: Cloudflare R2 (egress gratis)
R2 no cobra por descarga (egress), ideal para servir videos. 10 GB gratis; ~$0,015/GB/mes después.

1. En Cloudflare → **R2** → creá un bucket (ej. `encuestum`).
2. Generá un **API Token** de R2 (Access Key ID + Secret).
3. Activá un **dominio público** para el bucket (r2.dev o un dominio propio/CDN).
4. Configurá **CORS** en el bucket: permitir `PUT` y `GET` desde el dominio de tu app.
5. Variables:
   ```bash
   ENCUESTUM_STORAGE=s3
   ENCUESTUM_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   ENCUESTUM_S3_BUCKET=encuestum
   ENCUESTUM_S3_ACCESS_KEY_ID=<r2-access-key>
   ENCUESTUM_S3_SECRET_ACCESS_KEY=<r2-secret>
   ENCUESTUM_S3_REGION=auto
   ENCUESTUM_S3_PUBLIC_URL=https://cdn.tudominio.com   # dominio público del bucket
   # ENCUESTUM_S3_PREFIX=                              # (opcional) carpeta dentro del bucket
   ```

### Amazon S3 (o cualquier S3-compatible)
Mismo esquema: `ENCUESTUM_S3_ENDPOINT` (el de tu región/proveedor), bucket con **lectura pública** y **CORS** que permita `PUT`/`GET` desde tu dominio. Sirve para MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces, etc.

> Los límites de tamaño se controlan con `ENCUESTUM_ASSET_MAX_VIDEO_MB`, `_IMAGE_MB`, `_AUDIO_MB`.

---

## ✉️ Email / SMTP

El email se usa para **invitaciones**, **reset de contraseña**, **verificación**, **links mágicos** de acceso y **notificaciones** de respuestas.

> **No es obligatorio.** Sin SMTP, Encuestum **no se rompe**: los emails se **registran en el log** (podés copiar el link de ahí) y siempre podés **descargar el CSV de códigos** de acceso y repartirlos vos.

Con SMTP configurado, se envían de verdad (STARTTLS, puerto 587):

```bash
ENCUESTUM_SMTP_HOST=smtp.tu-proveedor.com
ENCUESTUM_SMTP_PORT=587
ENCUESTUM_SMTP_USER=tu-usuario
ENCUESTUM_SMTP_PASSWORD=tu-clave-o-app-password
ENCUESTUM_SMTP_TLS=true
ENCUESTUM_EMAIL_FROM="Encuestum <no-reply@tudominio.com>"
ENCUESTUM_PUBLIC_URL=https://encuestas.tudominio.com   # para que los links del mail apunten bien
```

**Proveedores probados** (mismo esquema, puerto 587):
- **Gmail** — host `smtp.gmail.com`, usuario tu correo, password un **App Password** (requiere 2FA).
- **Brevo** (ex-Sendinblue) — 300 emails/día gratis, host `smtp-relay.brevo.com`.
- **Resend / Mailgun / SendGrid / Amazon SES** — usuario + API key como password.

---

## 🤖 Inteligencia artificial (bring-your-own-key)

Encuestum **no incluye** una API key de IA: usás la tuya. Es **provider-agnostic** (cualquier endpoint OpenAI-compatible: OpenRouter, OpenAI, Together, un LLM local…).

Dos formas de configurarla:
1. **Desde la app** (recomendado): pantalla **IA** → agregás un proveedor (OpenAI / OpenRouter / custom), pegás la key, elegís el modelo (se listan en vivo). Podés tener una key **por organización** o una **global** de la plataforma. La app **rastrea el consumo** (tokens y costo aprox.) por cada llamada.
2. **Por variables de entorno** (`ENCUESTUM_LLM_API_KEY`, `_BASE_URL`, `_MODEL`) como fallback global.

**Sin key**, todo lo demás funciona (incluida la corrección determinística de preguntas cerradas); solo quedan inactivas la corrección por rúbrica con LLM, los insights y la generación de preguntas.

> ¿LLM local (Ollama)? Apuntá `ENCUESTUM_LLM_BASE_URL` a `http://localhost:11434/v1` y poné `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND=true`.

---

## 🌐 Subdominio propio por organización

Cada organización puede reclamar `acme.tudominio.com` para que sus encuestas queden bajo su propia marca. La app ya está lista; solo configurás **DNS comodín + TLS wildcard**. Guía completa en [`docs/SUBDOMINIOS.md`](docs/SUBDOMINIOS.md). En resumen: definís `ENCUESTUM_BASE_DOMAIN=tudominio.com`, apuntás un registro `*.tudominio.com` a tu app, y emitís un certificado wildcard (Cloudflare proxied lo hace solo).

---

## 🧱 Arquitectura

```
encuestum/
├── backend/          FastAPI + SQLModel + Alembic  (SQLite por defecto / Postgres)
│   ├── app/
│   │   ├── main.py            monta /api/v1/*, migra al arrancar, headers de seguridad
│   │   ├── models.py          User · Organization · Membership · Survey · Response · …
│   │   ├── routers/           auth · orgs · public · admin · evaluation · ai · webhooks · …
│   │   ├── grading.py         motor de corrección híbrido (determinístico + LLM)
│   │   ├── llm.py             cliente LLM provider-agnostic (OpenAI-compatible)
│   │   ├── net_guard.py       guard anti-SSRF (webhooks / LLM base URL)
│   │   └── storage.py         local / S3-R2 con URL prefirmada
│   ├── alembic/               migraciones idempotentes
│   └── tests/                 pytest (auth, aislamiento por org, roles, acceso, corrección…)
├── frontend/         Next.js 16 (App Router) + SurveyJS + Tailwind
│   └── app/
│       ├── page.tsx                landing pública
│       ├── (auth)/                 login · register · reset · verify
│       ├── (survey-builder)/       panel autenticado (chrome estilo Escriba)
│       └── (public)/s/[slug]/      página pública de respuesta (SurveyJS)
├── docker-compose.yml          desarrollo (backend + frontend separados)
├── docker-compose.prod.yml     producción (imagen all-in-one + Postgres)
└── Dockerfile                  imagen all-in-one (nginx + Next + FastAPI)
```

**Stack:** FastAPI · SQLModel · Alembic · asyncpg/aiosqlite · PyJWT + bcrypt · boto3 (R2/S3) · Next.js 16 · React 19 · [SurveyJS](https://surveyjs.io/) (MIT) · Tailwind. Bring-your-own-key para el LLM.

---

## 💻 Desarrollo local

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
ENCUESTUM_SESSION_SECRET=dev ENCUESTUM_COOKIE_SECURE=false \
  ENCUESTUM_CORS_ORIGINS=http://localhost:3000 \
  uvicorn app.main:app --reload --port 8000
```

**Frontend** (otra terminal)
```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Abrí <http://localhost:3000> → **Crear cuenta**. O usá `docker compose up --build` (dos servicios).

**Tests**
```bash
cd backend && pytest              # LLM mockeado; no necesita red
cd frontend && npx next build     # typecheck + build
```
CI (GitHub Actions) corre ambos en cada push/PR.

---

## 🔐 Seguridad

- Sesiones firmadas (JWT en cookie httpOnly), contraseñas con **bcrypt**.
- **Aislamiento multi-tenant** verificado (sin IDOR entre organizaciones).
- **Anti-SSRF** en webhooks y en el base URL de proveedores IA.
- **Rate limiting** por IP en los endpoints públicos (submit, acceso, códigos).
- **Least-privilege**: operaciones destructivas y export solo para admin+.
- Headers de seguridad (nosniff, X-Frame-Options, Referrer-Policy), CORS configurable, límite de tamaño de body, API keys de IA **enmascaradas** al leer.
- **Fijá `ENCUESTUM_SESSION_SECRET` y `ENCUESTUM_COOKIE_SECURE=true` en producción.**

¿Encontraste una vulnerabilidad? Reportala en privado (no abras un issue público).

---

## 🤝 Contribuir

¡Bienvenidas las contribuciones! Issues, mejoras y PRs. Antes de un PR: `pytest` en verde (backend) y `next build` sin errores (frontend). Detalles en [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 Licencia

[MIT](LICENSE) © 2026 Diego Parras. Construido sobre [SurveyJS](https://surveyjs.io/) (MIT).

Parte del **Ecosistema Escriba** 🫒 — una familia de herramientas self-hosted.

<div align="center">

**Si te sirve, dejá una ⭐ — ayuda un montón.**

</div>
