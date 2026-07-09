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
5. **Environment**: pegá las variables (ver punto 3). Como mínimo un
   `ENCUESTUM_SESSION_SECRET` estable; para la corrección con IA, una API key.
6. Deploy. La primera cuenta que se registre crea su organización y queda como
   owner. El esquema se crea solo (migraciones al arranque).

## 3. Variables de entorno

Ver [`.env.example`](../.env.example) para la lista completa.

```env
# OBLIGATORIA: firma las cookies de sesión. Estable y secreta.
#   openssl rand -hex 32
ENCUESTUM_SESSION_SECRET=<hex-de-64-chars>

# Base de datos: por defecto SQLite en /app_data. Para Postgres:
# DATABASE_URL=postgresql://user:pass@host:5432/encuestum

# Proveedor LLM (OpenAI-compatible: OpenRouter / OpenAI / local). BYOK.
ENCUESTUM_LLM_API_KEY=<tu-key>
# ENCUESTUM_LLM_BASE_URL=https://openrouter.ai/api/v1   # default
# ENCUESTUM_LLM_MODEL=openai/gpt-4o-mini                # default

# Cerrar el auto-registro una vez creadas las cuentas (opcional):
# ENCUESTUM_ALLOW_REGISTRATION=false

# Email (invitaciones, reset de contraseña, verificación). Los enlaces apuntan a
# esta URL pública (el dominio de la app). Sin SMTP, los emails se loguean (el
# enlace queda en el log) y las invitaciones igual muestran el enlace para copiar.
ENCUESTUM_PUBLIC_URL=https://encuestum.tudominio.com
# ENCUESTUM_SMTP_HOST=smtp.tuservidor.com
# ENCUESTUM_SMTP_USER=...
# ENCUESTUM_SMTP_PASSWORD=...
# ENCUESTUM_EMAIL_FROM=Encuestum <no-reply@tudominio.com>

# Rate limiting compartido entre réplicas (opcional):
# ENCUESTUM_REDIS_URL=redis://host:6379/0
```

- **`ENCUESTUM_SESSION_SECRET`**: si no lo definís, se genera uno efímero y las
  sesiones se caen en cada reinicio (verás un warning en el log). En producción,
  fijalo.
- **HTTPS**: con el dominio de EasyPanel en HTTPS, dejá `ENCUESTUM_COOKIE_SECURE`
  en su default (`true`). Sólo lo ponés en `false` si servís por HTTP plano.
- **Sin `ENCUESTUM_LLM_API_KEY`**: las encuestas y la corrección determinística
  funcionan; quedan inactivas la corrección por rúbrica con LLM, los insights y
  la generación de preguntas.
- **Postgres**: `DATABASE_URL` con esquema plano; la app agrega el driver async
  sola. La imagen ya trae `asyncpg`. Las migraciones corren al arrancar.

## 4. Rutas del contenedor

| Ruta | Va a | Auth |
|---|---|---|
| `/` | Next.js (landing pública) | abierta |
| `/login`, `/register` | Next.js (cuentas) | abierta |
| `/surveys/*`, `/members` | Next.js (panel) | sesión requerida |
| `/s/{slug}` | Next.js (página pública de respuesta) | abierta |
| `/api/v1/auth/*`, `/api/v1/orgs/*` | FastAPI (cuentas y organizaciones) | sesión (salvo login/register) |
| `/api/v1/survey/public/*` | FastAPI (render/submit) | abierta |
| `/api/v1/survey/surveys/*` | FastAPI (panel + evaluación) | sesión + organización |
| `/api/health`, `/api/ready`, `/docs` | FastAPI | abierta |

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
