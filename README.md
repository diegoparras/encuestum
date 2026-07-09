# Encuestum

**Plataforma de encuestas y evaluaciones con corrección por IA.** Encuestum
permite crear formularios tipo Typeform y exámenes que se corrigen solos:
preguntas cerradas de forma determinística y preguntas abiertas con un motor
híbrido (rúbrica + LLM) que cita evidencia, marca lo dudoso para revisión humana
y resiste inyecciones de prompt. Multi-organización, con cuentas y roles.

Construido sobre [SurveyJS](https://surveyjs.io/) (MIT) para el runtime de
formularios. Backend FastAPI, frontend Next.js. Bring-your-own-key para el LLM.

> Encuestum nació como un satélite del proyecto Presentia y se extrajo a este
> repositorio como software independiente.

## Qué hace

**Cuentas y organizaciones**
- Multi-tenant: registro/login con sesión segura (cookies httpOnly, bcrypt),
  varias organizaciones por usuario, datos aislados por organización.
- Roles `owner` · `admin` · `member`, invitaciones por email, reset de
  contraseña y verificación de email.
- **Subdominio propio por organización** (`acme.tudominio.com`) con branding.
- Super-admin de plataforma (`ENCUESTUM_SUPERADMIN_EMAIL`) con vista global.

**Editor y tipos de pregunta**
- Editor visual drag-and-drop con vista previa en vivo y **plantillas** listas.
- Tipos: texto, párrafo, email, opción única/múltiple, desplegable, escala/NPS
  (con presentaciones: números, rectángulos, estrellas, caritas, con gradiente),
  sí/no, **opción-imagen**, **matriz**, **ranking**, **fecha**, **subir archivo**
  y **respuesta en video** (grabación por webcam tipo Typeform).
- **Lógica condicional** (mostrar según otra respuesta) y **piping** (`{pregunta}`
  en el texto). Una-pregunta-por-pantalla estilo Typeform.

**Diseño**
- Temas de un clic (claros y oscuros), **modo oscuro**, color del texto de las
  preguntas, preguntas transparentes, **buscador de Google Fonts**, color de
  acento y de fondo, imágenes (portada, logo, fondo con opacidad, por pregunta),
  video embebido y **música de fondo**.

**Distribución y acceso**
- Página pública `/s/{slug}` (SurveyJS en el navegador), **código QR**, **embed**
  por iframe, **links con prefill** (`?campo=valor`), guardar-y-retomar.
- **Control de acceso** por encuesta: pública, **con clave (PIN)** o **lista de
  emails admitidos** con código único por persona (entrar + ver resultado) y
  **link mágico** por email.
- Cierre automático por **fecha** o **cupo** de respuestas.
- Al terminar: **mensaje de gracias** personalizable o **redirect**.

**Resultados**
- Panel **"Resumen"** con gráficos por pregunta (barras, histograma NPS con
  promedio, respuestas abiertas, archivos/videos).
- Navegador de respuestas, **export CSV/XLSX**, **duplicar** encuesta.
- **Notificaciones por email** al dueño en cada respuesta.
- **Webhooks** firmados (HMAC) para Zapier / Google Sheets / Make.
- Borrado de respuesta individual (GDPR).

**IA (bring-your-own-key)**
- **Genera** preguntas desde un tema o un documento/markdown.
- **Corrige** respuestas abiertas con motor híbrido (rúbrica + LLM): puntaje,
  veredicto, feedback, **evidencia** citada, `needs_review` e `injection_flag`,
  con doble pasada. Determinística para las cerradas.
- **Gestión de proveedores de IA** (OpenAI / OpenRouter / custom), listado de
  modelos en vivo, config **híbrida** (por organización o global de plataforma),
  y **rastreo de consumo** (tokens y costo aprox. por llamada).

**Evaluaciones / educación**
- Modo examen con integridad (mezclar preguntas/opciones, tiempo, intentos).
- Cola de revisión, override manual, analítica, insights de abiertas.
- **Gradebook** (planilla de notas por alumno) y **certificado** imprimible al
  aprobar.

**Almacenamiento**
- Uploads (videos/archivos) directo del navegador a **Cloudflare R2 / S3** con
  URL prefirmada (el servidor no toca los archivos), o disco local.

Solidez: migraciones versionadas (Alembic), rate limiting, headers de seguridad,
CORS configurable, logging estructurado, manejo de errores de conexión en el
frontend, y tests (pytest + `next build`) en CI.

## Arquitectura

```
encuestum/
├── backend/      FastAPI + SQLModel + Alembic (SQLite por defecto / Postgres)
│   ├── app/
│   │   ├── main.py         monta /api/v1/{auth,orgs} y /api/v1/survey/*, migra al arrancar
│   │   ├── models.py       User · Organization · Membership · Survey · SurveyResponse
│   │   ├── security.py     bcrypt + sesiones JWT en cookie
│   │   ├── deps.py         current_user · organización activa · guardas de rol
│   │   ├── routers/        auth · orgs · public · admin (surveys) · evaluation
│   │   └── grading.py      motor de corrección híbrido
│   ├── alembic/            migraciones
│   └── tests/              pytest (auth, aislamiento por org, roles, corrección)
└── frontend/     Next.js (App Router) + SurveyJS
    └── app/
        ├── page.tsx            landing pública
        ├── (auth)/             login · register
        ├── (survey-builder)/   panel autenticado: shell + selector de org, encuestas, miembros
        └── (public)/s/[slug]/  página pública de respuesta
```

El frontend habla con el backend por HTTP con cookies (`credentials: include`).
En la imagen all-in-one van same-origin (nginx enruta `/api`); en dev van en
puertos distintos con CORS.

## Inicio rápido (Docker · producción, imagen única)

```bash
cp .env.example .env
# Poné ENCUESTUM_SESSION_SECRET (openssl rand -hex 32).
# (opcional) ENCUESTUM_LLM_API_KEY para habilitar la corrección con IA.
docker build -t encuestum:local .
docker run --rm -p 8080:80 -v encuestum_data:/app_data \
  -e ENCUESTUM_SESSION_SECRET=$(openssl rand -hex 32) \
  -e ENCUESTUM_COOKIE_SECURE=false \
  encuestum:local
# http://localhost:8080  → landing;  /register → crear cuenta;  /docs → API
```

Publicada en `ghcr.io/diegoparras/encuestum`. Deploy en EasyPanel:
[docs/DEPLOY_EASYPANEL.md](docs/DEPLOY_EASYPANEL.md).

### Self-host con Postgres (recomendado)

Un comando levanta la app (imagen all-in-one) + Postgres:

```bash
cp .env.example .env
# poné un ENCUESTUM_SESSION_SECRET real: openssl rand -hex 32
docker compose -f docker-compose.prod.yml up -d
# http://localhost:8080
```

Los datos persisten en el volumen `encuestum_pg`. Detrás de un dominio con HTTPS,
poné `ENCUESTUM_PUBLIC_URL=https://tu-dominio` y `ENCUESTUM_COOKIE_SECURE=true`.

## Desarrollo (Docker Compose, dos servicios)

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: <http://localhost:3000>  (landing → `/register`)
- Backend (API + docs): <http://localhost:8000/docs>

El compose ya setea `SESSION_SECRET`, cookies no-seguras y CORS al frontend.

## Desarrollo local (sin Docker)

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
ENCUESTUM_SESSION_SECRET=dev ENCUESTUM_COOKIE_SECURE=false \
  ENCUESTUM_CORS_ORIGINS=http://localhost:3000 \
  uvicorn app.main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Abrí <http://localhost:3000> → landing → **Crear cuenta**.

## Configuración

Ver [`.env.example`](.env.example) para todo. Lo principal:

| Variable | Default | Para qué |
|---|---|---|
| `ENCUESTUM_SESSION_SECRET` | (efímero) | **Firma las sesiones. Fijalo en prod.** |
| `ENCUESTUM_COOKIE_SECURE` | `true` | Cookies solo-HTTPS. `false` para http local. |
| `ENCUESTUM_ALLOW_REGISTRATION` | `true` | Auto-registro público. |
| `ENCUESTUM_CORS_ORIGINS` | (same-origin) | Orígenes permitidos (dev multi-puerto). |
| `DATABASE_URL` | (SQLite) | Postgres u otra base async. |
| `ENCUESTUM_DATA_DIR` | `/app_data` | Carpeta del SQLite si no hay `DATABASE_URL`. |
| `ENCUESTUM_LLM_API_KEY` | — | Key del proveedor LLM (OpenRouter/OpenAI/local). También configurable desde la app (por org o global). |
| `ENCUESTUM_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible. |
| `ENCUESTUM_LLM_MODEL` | `openai/gpt-4o-mini` | Modelo a usar. |
| `ENCUESTUM_BASE_DOMAIN` | — | Dominio base para subdominios por organización. |
| `ENCUESTUM_PUBLIC_URL` | (CORS[0]) | URL base para los links de los emails. |
| `ENCUESTUM_SMTP_HOST` … | — | SMTP para enviar emails (invitaciones, links, notificaciones). Ver `.env.example`. |
| `ENCUESTUM_STORAGE` | `local` | `s3` para uploads directo a Cloudflare R2 / S3. Ver `.env.example`. |
| `NEXT_PUBLIC_API_URL` | (same-origin) | URL del backend (embebida al buildear). |

Sin API key de LLM, las encuestas y la corrección determinística funcionan; sólo
quedan inactivas la corrección por rúbrica con LLM, los insights y la generación.
La IA es **bring-your-own-key**: podés setearla por env o desde la pantalla **IA**
de la app (por organización o global), con rastreo de consumo.

## API

- `/api/v1/auth/*` — `register` · `login` · `logout` · `me`.
- `/api/v1/orgs/*` — crear org · `switch` · miembros (listar/agregar/rol/quitar).
- `/api/v1/survey/public/*` — flujo público (sin auth): render · submit · grade-question.
- `/api/v1/survey/surveys/*` — panel (sesión + organización): CRUD, publish/close,
  responses, grade-all, review-queue, override, analytics, insights, generate-questions.
- `/api/health` · `/api/ready` · `/docs`.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest              # auth, aislamiento por organización, roles y corrección (LLM mockeado)
```

CI (GitHub Actions) corre pytest del backend y `next build` del frontend en cada push/PR.

## Contribuir

¡Bienvenidas las contribuciones! Ver [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencia

[MIT](LICENSE) © 2026 Diego Parras. Construido sobre [SurveyJS](https://surveyjs.io/) (MIT).
