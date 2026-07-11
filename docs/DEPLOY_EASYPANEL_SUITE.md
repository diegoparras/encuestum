# Encuestum completo en EasyPanel — con Cloudflare R2 + federación Lockatus

Instructivo de cero a producción para dejar **Encuestum** andando en tu VPS con EasyPanel,
con almacenamiento de videos/archivos en **Cloudflare R2** y login unificado de la Suite vía
**Lockatus** (SSO OIDC con 2FA).

> **Al final vas a tener:** `https://encuestas.tudominio.com` con TLS, base Postgres, videos
> yendo directo a R2, y el login delegado en `https://identidad.tudominio.com` (Lockatus).

Guías complementarias: [Deploy base](DEPLOY_EASYPANEL.md) ·
[Almacenamiento externo](ALMACENAMIENTO_EXTERNO.md) · [Lockatus / SSO](LOCKATUS.md).

---

## 0. Requisitos

- **VPS** con EasyPanel instalado (2 vCPU / 2 GB RAM alcanzan). Si no lo tenés:
  ```bash
  curl -sSL https://get.easypanel.io | sh
  ```
  y entrás a `http://IP:3000`.
- **DNS**: dos registros **A** apuntando a la IP del VPS:
  - `encuestas.tudominio.com` → Encuestum
  - `identidad.tudominio.com` → Lockatus
- Cuenta de **Cloudflare** (para R2).
- Imágenes públicas en GHCR (salen solas con cada release):
  - `ghcr.io/diegoparras/encuestum:v1.1.3`
  - `ghcr.io/diegoparras/lockatus:latest` (o el tag de versión)

> **⚠️ Imágenes públicas.** Para que EasyPanel las pullee sin credenciales, los packages de
> GHCR deben estar en *Public*: `github.com/diegoparras?tab=packages` → package → *Package
> settings* → *Change visibility* → **Public**. Si los dejás privados: EasyPanel →
> **Settings → Registries** → cargá GHCR con un PAT de scope `read:packages`.

---

## 1. Crear el proyecto

EasyPanel → **Create Project** → nombre `escriba`. Todos los servicios (bases + Lockatus +
Encuestum) viven adentro y se hablan por la **red interna** del proyecto.

---

## 2. Bases de datos (Postgres ×2)

Una base para cada app (aisladas):

1. **Create → Postgres** → nombre `encuestum-db`. Anotá usuario/clave/DB. Host interno:
   algo como `escriba_encuestum-db`, puerto `5432`.
2. **Create → Postgres** → nombre `lockatus-db`. Ídem.

Armá las URLs de conexión (las usás en los pasos 3 y 5):
```
postgresql://USUARIO:CLAVE@escriba_encuestum-db:5432/DBNAME
```

> No expongas ningún puerto de Postgres al exterior; se accede solo por la red interna.

---

## 3. Deploy de Lockatus (el hub de identidad)

Primero el hub, porque Encuestum federado necesita que exista.

### 3.1 Crear la App

Dentro del proyecto → **Create → App** → nombre `lockatus`:

1. **Source → Docker Image**: `ghcr.io/diegoparras/lockatus:latest`
2. **Domains**: `identidad.tudominio.com` → mapeado al **puerto 8080** del contenedor (ahí
   escucha el server). EasyPanel emite el certificado Let's Encrypt solo.
3. **Environment**:

```env
# Base (la lockatus-db del paso 2):
POSTGRES_USER=USUARIO
POSTGRES_PASSWORD=CLAVE
POSTGRES_DB=DBNAME
# host interno de la base:
POSTGRES_HOST=escriba_lockatus-db

# Primer superadmin del hub:
LOCKATUS_ADMIN_EMAIL=vos@tudominio.com
# Dejalo VACÍO: en el primer arranque se genera una contraseña fuerte
# y se imprime UNA sola vez en los logs.
LOCKATUS_ADMIN_PASS=

# Clave maestra (OBLIGATORIA) — cifra los secretos TOTP y firma la sesión del hub.
# Generala con: openssl rand -hex 32
# ⚠️ GUARDALA: si la perdés hay que re-enrolar todos los 2FA.
LOCKATUS_SECRET=<hex de 64 caracteres>

# Issuer OIDC: la URL pública por la que las apps llegan al hub (va en los tokens):
LOCKATUS_ISSUER=https://identidad.tudominio.com

# Detrás del TLS de EasyPanel:
LOCKATUS_SECURE_COOKIE=1
```

4. **Deploy.**

### 3.2 Primer arranque del hub

1. Mirá los **logs** de la App: ahí se imprime **una única vez** la contraseña generada del
   admin. Copiala.
2. Entrá a `https://identidad.tudominio.com`, logueate con `LOCKATUS_ADMIN_EMAIL` + esa
   contraseña, **cambiala** desde el panel y **enrolá tu 2FA (TOTP)**.
3. Verificá que responda el discovery OIDC:
   `https://identidad.tudominio.com/.well-known/openid-configuration` y
   `https://identidad.tudominio.com/jwks.json`.

> La clave de firma RS256 se genera sola al primer arranque y queda cifrada en la base.
> **Backup del Postgres de Lockatus = padrón de usuarios + clave de firma.**

---

## 4. Cloudflare R2 (almacenamiento de videos/archivos)

Con R2 los videos que graban los respondientes suben **directo del navegador al bucket** con
URL prefirmada (el server no los bufferea) y el egress es **gratis**. El bucket queda
**PRIVADO**: la app sirve los archivos same-origin (`/assets/…`), su ruta nunca llega al
navegador, y los archivos de respuesta solo los ven miembros de la organización.

1. **Bucket**: dashboard de Cloudflare → **R2** → *Create bucket* → nombre `encuestum`.
2. **Credenciales**: R2 → *Manage R2 API Tokens* → creá un token con permiso
   **Object Read & Write** sobre ese bucket. Anotá:
   - `Access Key ID`
   - `Secret Access Key`
   - Tu **Account ID** (para el endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)
3. **NO habilites acceso público** (*Public access* queda en *Disallowed*, sin dominio
   `r2.dev` ni custom domain). La app es la única que lee el bucket.
4. **CORS** (imprescindible para que el navegador pueda hacer el PUT de la subida directa):
   bucket → *Settings* → *CORS policy*:
   ```json
   [
     {
       "AllowedOrigins": ["https://encuestas.tudominio.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   > Si después activás subdominios por organización, sumá esos orígenes acá.

Las variables van en el paso siguiente, junto con el resto.

---

## 5. Deploy de Encuestum

### 5.1 Crear la App

Dentro del proyecto → **Create → App** → nombre `encuestum`:

1. **Source → Docker Image**: `ghcr.io/diegoparras/encuestum:v1.1.3`
   > Fijá el **tag de versión** (no `:latest`): controlás cuándo actualizás y podés volver
   > atrás con precisión.
2. **Domains**: `encuestas.tudominio.com` → **puerto 80** del contenedor (imagen all-in-one:
   nginx + Next.js + FastAPI adentro; el frontend habla same-origin con la API, no hay que
   configurar URL de API).
3. **Volumes**: no hace falta ninguno (Postgres externo + R2).
4. **Environment** → el bloque completo de abajo.
5. **Deploy.** Al arrancar corre las migraciones y crea el esquema solo.

### 5.2 Variables de entorno (bloque completo)

```env
# ── Base de datos (Postgres del paso 2) ──
DATABASE_URL=postgresql://USUARIO:CLAVE@escriba_encuestum-db:5432/DBNAME

# ── Sesiones (OBLIGATORIA — estable y secreta: openssl rand -hex 32) ──
ENCUESTUM_SESSION_SECRET=<hex de 64 caracteres>

# ── URL pública (los links de los emails apuntan acá) ──
ENCUESTUM_PUBLIC_URL=https://encuestas.tudominio.com
ENCUESTUM_COOKIE_SECURE=true

# ── Detrás del proxy de EasyPanel ──
ENCUESTUM_TRUST_PROXY=true
ENCUESTUM_ENABLE_HSTS=true

# ── Almacenamiento: Cloudflare R2 (paso 4, bucket privado) ──
ENCUESTUM_STORAGE=s3
ENCUESTUM_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
ENCUESTUM_S3_BUCKET=encuestum
ENCUESTUM_S3_ACCESS_KEY_ID=<access-key>
ENCUESTUM_S3_SECRET_ACCESS_KEY=<secret>
ENCUESTUM_S3_REGION=auto

# ── Federación Lockatus (SSO OIDC de la Suite) ──
AUTH_MODE=federado
LOCKATUS_ISSUER=https://identidad.tudominio.com
LOCKATUS_CLIENT_ID=encuestum
LOCKATUS_REDIRECT_URI=https://encuestas.tudominio.com/api/v1/auth/sso/callback
LOCKATUS_ADMIN_ROLE=admin   # rol del hub que otorga super-admin de plataforma
```

Notas clave:

- **`ENCUESTUM_SESSION_SECRET`**: si no la fijás, se genera una efímera y las sesiones se
  caen en cada reinicio. Además se reusa para firmar la cookie de transacción del flujo OIDC.
- **`LOCKATUS_REDIRECT_URI`** apunta al **backend** (`/api/v1/auth/sso/callback`) y debe
  coincidir **EXACTO** con lo que registres en el hub (paso 6).
- En `federado` el alta local (`/register`) queda deshabilitada: las identidades las pone
  el hub.

> 💡 Si preferís arrancar tranquilo: deployá primero con `AUTH_MODE=local` (login propio),
> verificá que todo ande, y recién ahí cambiás a `federado` + Redeploy. El flag es reversible.

---

## 6. Declarar Encuestum en el hub (matriz de accesos)

Sin este paso, el SSO devuelve `access_denied`. En Lockatus (logueado como admin, desde el
panel o su API admin):

1. **Declarar la app** con su catálogo de roles y su redirect URI:
   ```
   PUT /api/admin/apps/encuestum
   {
     "name": "Encuestum",
     "roles": ["admin", "member"],
     "redirect_uris": ["https://encuestas.tudominio.com/api/v1/auth/sso/callback"]
   }
   ```
2. **Asignar roles** a los usuarios en la **matriz de accesos** del hub (pantalla de accesos
   del admin, o `PUT /api/admin/users/<id>/role { "app": "encuestum", "role": "admin" }`).
   Quien no tenga rol para `encuestum` recibe `access_denied` y ni llega al callback.
   - Asignate a vos el rol **`admin`**: con `LOCKATUS_ADMIN_ROLE=admin` eso te promueve a
     **super-admin de plataforma** en Encuestum (panel `/admin`, todas las orgs y uso).

Cómo funciona el mapeo:

- **Lockatus pone la identidad** (login + 2FA, email verificado por el hub); el flujo es
  OIDC Authorization Code + PKCE con JWT RS256 verificados offline contra el JWKS.
- En el **primer login federado**, Encuestum hace *find-or-create* del usuario por email y
  le crea su **organización por defecto** como `owner`.
- Las **orgs y roles internos** (owner/admin/member) se siguen manejando con las
  invitaciones de Encuestum; el hub solo dicta quién entra y quién es super-admin.

---

## 7. Primer arranque y verificación

1. Entrá a `https://encuestas.tudominio.com` → tenés que ver el botón
   **"Entrar con la Suite Escriba"** (en vez del formulario de login).
2. Clic → te lleva a Lockatus → login + 2FA → volvés logueado a `/surveys`. Se creó tu
   usuario y tu organización.
3. **Probá R2**: creá una encuesta con una pregunta de video, respondela y grabá un video.
   Debe subir directo al bucket y reproducirse desde `/assets/…` de tu propio dominio
   (la ruta del bucket no aparece por ningún lado).
4. Si te asignaste el rol `admin` en el hub, verificá que veas el panel **/admin** de
   Encuestum.

---

## 8. Extras opcionales (Redeploy después de cambiar variables)

```env
# Emails reales (sin SMTP los enlaces se loguean en el log):
ENCUESTUM_SMTP_HOST=smtp.tu-proveedor.com
ENCUESTUM_SMTP_PORT=587
ENCUESTUM_SMTP_USER=...
ENCUESTUM_SMTP_PASSWORD=...
ENCUESTUM_SMTP_TLS=true
ENCUESTUM_EMAIL_FROM=Encuestum <no-reply@tudominio.com>

# IA (generar preguntas / corregir respuestas abiertas — bring-your-own-key):
ENCUESTUM_LLM_API_KEY=<tu-key>

# Subdominio propio por organización (requiere DNS+TLS wildcard, ver SUBDOMINIOS.md):
ENCUESTUM_BASE_DOMAIN=tudominio.com
```

El captcha anti-bot (proof-of-work, sin terceros) ya viene activo como capacidad
(`ENCUESTUM_CAPTCHA_ENABLED=true` es el default); se prende **por encuesta** en el panel de
Acceso. Ver [SEGURIDAD.md](SEGURIDAD.md).

---

## 9. Actualizar / Backups

- **Actualizar**: en la App → cambiá la Image al tag nuevo (`vX.Y.Z`) → Deploy. Las
  migraciones corren solas (idempotentes). Volver atrás = tag anterior + Deploy.
- **Backups**:
  - Postgres de **Encuestum** (encuestas, respuestas, usuarios) y de **Lockatus** (padrón +
    clave de firma): usá el backup del servicio Postgres de EasyPanel o `pg_dump` programado.
  - Archivos: ya están en R2 (durables).
  - Guardá aparte `LOCKATUS_SECRET` y `ENCUESTUM_SESSION_SECRET`.

---

## 10. Troubleshooting rápido

| Síntoma | Fix |
|---|---|
| App no levanta / 502 | Logs de la App: casi siempre `DATABASE_URL` mal armado o Postgres no *ready*. |
| "Sesión inválida" tras reinicio | Falta `ENCUESTUM_SESSION_SECRET` estable. |
| `access_denied` al entrar por SSO | El usuario no tiene rol para `encuestum` en la matriz del hub. |
| Error en el callback OIDC | `LOCKATUS_REDIRECT_URI` no coincide **exacto** con el registrado en el hub, o `LOCKATUS_ISSUER` no es la URL pública real. |
| "No se pudo subir el video" | CORS del bucket: falta tu dominio en `AllowedOrigins` o falta el método `PUT`. |
| El video sube pero no se ve | Logs del backend (credenciales/endpoint del bucket). Un **403** en `/assets/responses/…` es el control de acceso: iniciá sesión con un miembro de la org. |
| EasyPanel no pullea la imagen | Package GHCR privado → hacelo público o cargá el Registry con PAT. |

---

## 11. Checklist de producción

- [ ] `ENCUESTUM_SESSION_SECRET` y `LOCKATUS_SECRET` estables y guardados aparte.
- [ ] Dominios con **HTTPS** + `ENCUESTUM_COOKIE_SECURE=true` + `LOCKATUS_SECURE_COOKIE=1`
      + `ENCUESTUM_ENABLE_HSTS=true`.
- [ ] `DATABASE_URL` a Postgres (una base por app, sin puertos expuestos).
- [ ] `ENCUESTUM_TRUST_PROXY=true` (detrás del proxy de EasyPanel).
- [ ] R2 **privado** (sin acceso público) con **CORS** que permita `PUT` desde tu dominio.
- [ ] App `encuestum` declarada en el hub con el `redirect_uri` exacto + roles asignados.
- [ ] Contraseña de admin del hub cambiada + **2FA enrolado**.
- [ ] SMTP para emails reales.
- [ ] Backups de los dos Postgres.
- [ ] Imágenes **fijadas por tag** (`vX.Y.Z`), no `:latest`.

Más profundidad: [Deploy base](DEPLOY_EASYPANEL.md) ·
[Almacenamiento externo](ALMACENAMIENTO_EXTERNO.md) · [Lockatus / SSO](LOCKATUS.md) ·
[Seguridad](SEGURIDAD.md) · [Subdominios](SUBDOMINIOS.md), y en el repo de Lockatus:
`DEPLOY.md` y `docs/AGREGAR-APP.md`.
