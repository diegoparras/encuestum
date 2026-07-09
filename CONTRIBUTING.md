# Contribuir a Encuestum

¡Gracias por tu interés! Encuestum es open source (MIT). Las contribuciones son
bienvenidas: issues, mejoras, fixes y features.

## Cómo empezar

Levantá el entorno local (ver [README](README.md) → "Desarrollo local"):

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
ENCUESTUM_SESSION_SECRET=dev ENCUESTUM_COOKIE_SECURE=false \
  ENCUESTUM_CORS_ORIGINS=http://localhost:3000 \
  uvicorn app.main:app --reload --port 8000

# Frontend (otra terminal)
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

## Antes de abrir un PR

- **Backend**: `cd backend && pytest` en verde. Si tocás modelos, agregá una
  migración Alembic **idempotente** (mirá `alembic/versions/`); nunca edites una
  migración ya publicada.
- **Frontend**: `cd frontend && npx next build` sin errores de TypeScript.
- Mantené el estilo del código que te rodea. Sin secretos ni claves en los
  commits.
- Mensajes de commit en formato convencional (`feat:`, `fix:`, `docs:`…).

## Arquitectura rápida

- **Backend**: FastAPI + SQLModel + Alembic. Rutas en `app/routers/`, modelos en
  `app/models.py`, corrección en `app/grading.py`, cliente LLM
  provider-agnostic en `app/llm.py`.
- **Frontend**: Next.js App Router + SurveyJS. El "modelo del builder" y su
  serialización a/desde SurveyJS viven en
  `app/(survey-builder)/builder/model.ts`.

## Reportar seguridad

Si encontrás una vulnerabilidad, por favor **no** abras un issue público:
escribí en privado al responsable del repositorio.

## Licencia

Al contribuir, aceptás que tu aporte se publique bajo la licencia
[MIT](LICENSE) del proyecto.
