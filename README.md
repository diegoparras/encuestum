# Encuestum

**Encuestas y evaluaciones con corrección por IA.** Encuestum es una app
self-contained para crear formularios tipo Typeform y exámenes que se corrigen
solos: preguntas cerradas de forma determinística y preguntas abiertas con un
motor híbrido (rúbrica + LLM) que cita evidencia, marca lo dudoso para revisión
humana y resiste inyecciones de prompt.

Construido sobre [SurveyJS](https://surveyjs.io/) (MIT) para el runtime de
formularios. Backend FastAPI, frontend Next.js. Bring-your-own-key para el LLM.

> Encuestum nació como un satélite del proyecto Presentia y se extrajo a este
> repositorio como software independiente.

## Qué hace

- **Editor visual** drag-and-drop de encuestas y exámenes (preguntas de opción,
  texto, comentario, escala…), con vista previa en vivo y acento configurable.
- **Publicación pública**: cada encuesta tiene un slug y una página de respuesta
  sin login (`/s/{slug}`) que corre el runtime de SurveyJS en el navegador.
- **Corrección híbrida**:
  - preguntas cerradas → determinística contra la respuesta correcta;
  - preguntas abiertas → LLM con rúbrica, que devuelve puntaje, veredicto,
    feedback, **evidencia** citada, `needs_review` y `injection_flag`, con doble
    pasada para robustez.
- **Panel del profe**: cola de revisión, override manual de notas, analítica
  (distribución de puntajes, tasa de aprobación, por-pregunta).
- **Insights de respuestas abiertas** que no alucinan (se anclan a las
  respuestas reales) y **reporte por alumno**.
- **Generación de preguntas** con IA a partir de un tema.
- **Gate admin opcional** por token; las rutas públicas siempre quedan abiertas.

## Arquitectura

```
encuestum/
├── backend/      FastAPI + SQLModel (SQLite por defecto, Postgres opcional)
│   └── app/
│       ├── main.py            monta /api/v1/survey/*  + /api/health
│       ├── routers/           public · admin (surveys) · evaluation
│       ├── grading.py         motor de corrección híbrido
│       ├── llm.py             cliente LLM OpenAI-compatible (BYOK)
│       └── models.py          Survey · SurveyResponse
└── frontend/     Next.js (App Router) + SurveyJS
    └── app/
        ├── (survey-builder)/  panel admin: builder, dashboards, insights
        └── (public)/s/[slug]/ página pública de respuesta
```

El frontend habla con el backend por HTTP (`NEXT_PUBLIC_API_URL`); no comparten
proceso, así que se pueden escalar o desplegar por separado.

## Inicio rápido (Docker)

```bash
cp .env.example .env
# (opcional) poné ENCUESTUM_LLM_API_KEY para habilitar la corrección con IA
docker compose up --build
```

- Frontend: <http://localhost:3000>
- Backend (API + docs): <http://localhost:8000/docs>

Ese compose levanta backend y frontend como **dos servicios** (ideal para
desarrollo). Para **producción** hay además una **imagen all-in-one** (nginx +
Next.js + FastAPI en un solo contenedor, puerto 80) pensada para EasyPanel:

```bash
docker build -t encuestum:local .
docker run --rm -p 8080:80 -v encuestum_data:/app_data encuestum:local
# http://localhost:8080
```

Publicada en `ghcr.io/diegoparras/encuestum`. Ver
[docs/DEPLOY_EASYPANEL.md](docs/DEPLOY_EASYPANEL.md).

## Desarrollo local (sin Docker)

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Abrí <http://localhost:3000> → te redirige a `/surveys`.

## Configuración

Todas las variables son opcionales; ver [`.env.example`](.env.example).

| Variable | Default | Para qué |
|---|---|---|
| `DATABASE_URL` | (SQLite) | Postgres u otra base async. |
| `ENCUESTUM_DATA_DIR` | `/app_data` | Carpeta del SQLite si no hay `DATABASE_URL`. |
| `ENCUESTUM_LLM_API_KEY` | — | Key del proveedor LLM (OpenRouter/OpenAI/local). |
| `ENCUESTUM_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible. |
| `ENCUESTUM_LLM_MODEL` | `openai/gpt-4o-mini` | Modelo a usar. |
| `ENCUESTUM_ADMIN_TOKEN` | — | Si se define, protege las rutas admin. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | URL del backend (embebida al buildear). |
| `NEXT_PUBLIC_ENCUESTUM_ADMIN_TOKEN` | — | Replica del token admin para el panel. |

Sin API key, las encuestas y la corrección determinística funcionan igual; sólo
quedan inactivas la corrección por rúbrica con LLM, los insights y la generación.

## API

Rutas montadas bajo `/api/v1/survey`:

- `GET  /public/{slug}` · `POST /public/{slug}/submit` · `POST /public/{slug}/grade-question` — flujo público (sin auth).
- `POST|GET /surveys` · `GET|PUT|DELETE /surveys/{id}` · `POST /surveys/{id}/publish|close` — CRUD admin.
- `POST /surveys/{id}/grade-all` · `GET /surveys/{id}/review-queue` · `POST /surveys/{id}/responses/{rid}/override` · `GET /surveys/{id}/analytics` · `GET|POST /surveys/{id}/insights` · `POST /surveys/{id}/generate-questions` — evaluación e insights.

Docs interactivas en `/docs`.

## Tests

```bash
cd backend
python test_e2e.py   # E2E con el LLM mockeado: corrección, inyección, analítica, insights, generación
```

## Licencia

[MIT](LICENSE).
