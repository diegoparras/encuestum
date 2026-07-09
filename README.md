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

- **Cuentas y organizaciones (multi-tenant)**: registro/login con sesión segura
  (cookies httpOnly, contraseñas con bcrypt). Cada usuario puede tener varias
  organizaciones; los datos están aislados por organización.
- **Roles**: `owner` · `admin` · `member`. Gestión de miembros (invitar por
  email, cambiar rol, quitar) para admin o superior.
- **Editor visual** drag-and-drop de encuestas y exámenes (opción, texto,
  comentario, escala…), con vista previa en vivo.
- **Diseño superior a Google/Microsoft Forms**: panel de diseño con **temas
  predefinidos** de un clic, **tipografía** (fuentes curadas), color de acento y
  de fondo, **imágenes** (portada, logo, fondo con opacidad, e imagen por
  pregunta), **video** embebido por pregunta (YouTube/Vimeo o archivo propio),
  preguntas de **opción-imagen** (elegir entre imágenes), y **música de fondo**
  en la página pública — todo desde una biblioteca de medios por organización.
- **Publicación pública**: cada encuesta tiene un slug y una página de respuesta
  sin login (`/s/{slug}`) que corre el runtime de SurveyJS en el navegador.
- **Corrección híbrida**: cerradas → determinística; abiertas → LLM con rúbrica,
  que devuelve puntaje, veredicto, feedback, **evidencia** citada, `needs_review`
  y `injection_flag`, con doble pasada.
- **Panel del profe**: cola de revisión, override manual de notas, analítica
  (distribución, tasa de aprobación, por-pregunta), insights de respuestas
  abiertas (anclados a las respuestas reales) y reporte por alumno.
- **Generación de preguntas** con IA a partir de un tema.

Solidez: migraciones versionadas (Alembic), rate limiting, headers de seguridad,
CORS configurable, logging estructurado, `/api/ready`, y tests (pytest + `next build`)
en CI.

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
| `ENCUESTUM_LLM_API_KEY` | — | Key del proveedor LLM (OpenRouter/OpenAI/local). |
| `ENCUESTUM_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible. |
| `ENCUESTUM_LLM_MODEL` | `openai/gpt-4o-mini` | Modelo a usar. |
| `NEXT_PUBLIC_API_URL` | (same-origin) | URL del backend (embebida al buildear). |

Sin API key, las encuestas y la corrección determinística funcionan; sólo quedan
inactivas la corrección por rúbrica con LLM, los insights y la generación.

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

## Licencia

[MIT](LICENSE).
