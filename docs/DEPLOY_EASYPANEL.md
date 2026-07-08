# Deploy de Encuestum en EasyPanel (imagen Docker)

Encuestum se despliega como **una sola imagen Docker all-in-one** (nginx +
Next.js + FastAPI, todo adentro). **No usa docker-compose** en producción: en
EasyPanel se crea como una **App** que corre la imagen y se configura por
variables de entorno. El contenedor escucha en el **puerto 80**.

El frontend habla con el backend *same-origin* (nginx enruta `/api/` a FastAPI),
así que no hay que configurar ninguna URL de API en producción.

## 1. Publicar la imagen (una vez)

El repo trae el workflow [`.github/workflows/docker-release.yml`](../.github/workflows/docker-release.yml)
que buildea y publica la imagen en **GitHub Container Registry**:

```
ghcr.io/diegoparras/encuestum:latest
ghcr.io/diegoparras/encuestum:<tag-del-release>
```

Cómo dispararlo:

- **A mano**: GitHub → Actions → *Publish image* → *Run workflow*.
- **Por release**: publicá un Release (ver abajo) y se buildea solo.
- **Por rama**: pusheá una rama `release/0.1.0` y se buildea sola.

> Tras el **primer** push, hacé el package **público** para que EasyPanel lo
> pullee sin credenciales: `github.com/users/diegoparras/packages` →
> `encuestum` → *Package settings* → *Change visibility* → *Public*.
> (Si lo dejás privado, en EasyPanel cargás un Registry con un PAT
> `read:packages`.)

## 2. Crear la App en EasyPanel

1. **Create → App**.
2. **Source → Image**: `ghcr.io/diegoparras/encuestum:latest` (o el tag del release).
3. **Ports**: contenedor `80` → dominio de EasyPanel (HTTP). Activá HTTPS con el
   certificado de EasyPanel.
4. **Volumes**: montá un volumen persistente en **`/app_data`** (ahí vive el
   SQLite `encuestum.db` si no usás Postgres).
5. **Environment**: pegá las variables (ver punto 3). Sin nada, arranca igual
   con SQLite; para la corrección con IA hace falta una API key.
6. Deploy.

## 3. Variables de entorno

Todas opcionales; ver [`.env.example`](../.env.example).

```env
# Base de datos: por defecto SQLite en /app_data. Para Postgres:
# DATABASE_URL=postgresql://user:pass@host:5432/encuestum

# Proveedor LLM (OpenAI-compatible: OpenRouter / OpenAI / local). BYOK.
ENCUESTUM_LLM_API_KEY=<tu-key>
# ENCUESTUM_LLM_BASE_URL=https://openrouter.ai/api/v1   # default
# ENCUESTUM_LLM_MODEL=openai/gpt-4o-mini                # default

# Gate admin opcional: si lo definís, /api/v1/survey/surveys/* exige
# el header X-Admin-Token. Las rutas públicas siempre quedan abiertas.
# ENCUESTUM_ADMIN_TOKEN=<algo-seguro>
```

- **Sin `ENCUESTUM_LLM_API_KEY`**: las encuestas y la corrección determinística
  funcionan; quedan inactivas la corrección por rúbrica con LLM, los insights y
  la generación de preguntas.
- **Postgres**: `DATABASE_URL` con esquema plano; la app agrega el driver async
  sola. Para Postgres, la imagen ya trae `asyncpg`.
- **Gate admin**: si lo activás, el panel web (mismo dominio) necesita el token.
  Como el frontend se sirve same-origin y no reenvía el token por defecto, para
  un panel protegido conviene rebuildear la imagen con
  `NEXT_PUBLIC_ENCUESTUM_ADMIN_TOKEN`, o dejar el gate apagado y proteger el
  acceso a nivel EasyPanel (Basic Auth / IP allowlist).

## 4. Rutas del contenedor

| Ruta | Va a | Auth |
|---|---|---|
| `/` , `/surveys`, `/surveys/*` | Next.js (panel admin) | según gate |
| `/s/{slug}` | Next.js (página pública de respuesta) | abierta |
| `/api/v1/survey/public/*` | FastAPI (render/submit) | abierta |
| `/api/v1/survey/surveys/*` | FastAPI (admin + evaluación) | gate opcional |
| `/api/health`, `/docs`, `/openapi.json` | FastAPI | abierta |

## 5. Cortar un Release (recomendado para versionar la imagen)

GitHub → Releases → *Draft a new release* → Tag `v0.1.0` (target `main`) →
*Publish*. Esto dispara `docker-release.yml`, que buildea y sube
`ghcr.io/diegoparras/encuestum:v0.1.0` y `:latest`. Después en EasyPanel usás
ese tag inmutable (mejor que `:latest` para poder downgradear con precisión).

## 6. Probar la imagen localmente

```bash
docker build -t encuestum:local .
docker run --rm -p 8080:80 -v encuestum_data:/app_data \
  -e ENCUESTUM_LLM_API_KEY=... encuestum:local
# http://localhost:8080  → panel;  http://localhost:8080/docs → API
```
