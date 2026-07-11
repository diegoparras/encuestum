# Federación con Lockatus (SSO de la Suite Escriba)

> **Estado: IMPLEMENTADO.** Se activa con `AUTH_MODE=federado` (default `local` = login
> propio, sin cambios). En federado, Encuestum delega el login en **Lockatus** (OIDC
> Authorization Code + PKCE): el "quién sos" lo pone el hub y Encuestum hace *find-or-create*
> del usuario por email + su organización por defecto.

[Lockatus](https://github.com/diegoparras/lockatus) es el **hub de identidad** de la Suite
Escriba: el padrón de personas y el portero común. Da **login unificado** con **2FA (TOTP)**,
**OIDC** (Authorization Code + PKCE), **roles por app** y auditoría. Las apps de la familia
(Escriba, Fisherboy, Anonimal, Fulgoria, Selega, Trustux) ya federan contra él.

Federar Encuestum significaría: en vez de que cada persona se cree una cuenta local, entra con
su **cuenta de la suite** (una sola identidad para todas las apps), y su **rol** lo decide la
matriz de accesos del hub.

---

## Cómo funciona (OIDC estándar)

```
Encuestum (/login federado)         Lockatus (IdP, :8081)
        │  PKCE(S256)+state+nonce          │
        │─────── redirect a /authorize ───►│  (login + 2FA en el hub)
        │◄────── redirect a /callback?code ┤
        │  POST /token (canjea el code)    │
        │─────────────────────────────────►│
        │◄──── id_token + access_token (RS256)
        │  verifica firma contra /jwks.json (offline)
        │  find-or-create usuario por email + mapea rol
        │  siembra la MISMA cookie de sesión que el login local
```

- El flujo es **OIDC Authorization Code + PKCE**; los JWT son **RS256** y se verifican
  **offline** contra el JWKS del hub (no hay que llamar al hub en cada request).
- La federación va **detrás de un flag** `AUTH_MODE=local|federado` (default `local`, no
  cambia nada). En `federado`, `/login` redirige al hub y aparece un `/callback`.

Endpoints de descubrimiento del hub: `GET /.well-known/openid-configuration` y `GET /jwks.json`.

---

## Cómo está implementado

Sigue el patrón de la suite (clientes de referencia: **Anonimal**, **Fisherboy**), con el
cliente OIDC canónico vendorizado.

1. **Cliente OIDC** — `backend/app/lockatus_client.py`: PKCE, URL de `/authorize`, canje en
   `/token`, y verificación **RS256 offline** contra el JWKS del hub (con `cryptography`).
2. **Rutas** en `backend/app/routers/auth.py` (solo activas en `AUTH_MODE=federado`):
   - `GET /api/v1/auth/config` → el frontend consulta el modo (`{ auth_mode, sso }`).
   - `GET /api/v1/auth/sso/login` → arma PKCE+state+nonce (cookie de transacción firmada) y
     redirige al `/authorize` del hub.
   - `GET /api/v1/auth/sso/callback` → verifica `state`, canjea el `code`, **verifica id_token
     (email, nonce) y access_token (role)**, hace **find-or-create** del usuario por email, y
     **siembra la misma cookie de sesión** que el login local → el resto del gate no cambia.
     Al terminar redirige al frontend (`/surveys`).
   - El **alta local** (`/register`) queda deshabilitada en federado (las identidades vienen del hub).
3. **Frontend** — la pantalla de `/login` consulta `/auth/config` y, en federado, muestra el
   botón **"Entrar con la Suite Escriba"** (en vez del formulario). `/register` redirige a `/login`.

### Mapeo orgs/roles (decisión tomada)

Encuestum es **multi-tenant** (organizaciones + roles `owner/admin/member`); Lockatus da **un rol
por app**. La implementación usa **Lockatus solo para la identidad**:

- **Primer login federado** → se crea el usuario (email ya verificado por el hub) + su
  **organización por defecto** como `owner` (igual que el registro local).
- Las **orgs y roles internos** se siguen manejando con el sistema de invitaciones de Encuestum
  (el hub no dicta a qué orgs pertenecés).
- El **rol del hub** que definas en `LOCKATUS_ADMIN_ROLE` (default `admin`) promueve al usuario a
  **super-admin de plataforma** (`is_superadmin`) — útil para tu cuenta de operador.

> El **gating de acceso** lo hace el hub: si un usuario no tiene rol para `encuestum` en la matriz
> de Lockatus, recibe `access_denied` y ni llega al callback.

---

## Configuración

**1. En el hub** (declarar la app) — endpoint admin de Lockatus:

```
PUT /api/admin/apps/encuestum
{ "name": "Encuestum",
  "roles": ["admin", "member"],
  "redirect_uris": ["https://encuestas.tudominio.com/api/v1/auth/sso/callback"] }
```

Después: registrar el/los `redirect_uri` **exactos** y **asignar roles** a los usuarios en la
matriz de accesos del hub (sin rol para `encuestum`, el usuario recibe `access_denied`).

**2. En Encuestum** (variables):

```
AUTH_MODE=federado
LOCKATUS_ISSUER=https://identidad.tudominio.com                       # URL pública del hub
LOCKATUS_CLIENT_ID=encuestum
LOCKATUS_REDIRECT_URI=https://encuestas.tudominio.com/api/v1/auth/sso/callback
LOCKATUS_ADMIN_ROLE=admin                                            # (opcional) rol del hub → super-admin
```

- El `LOCKATUS_REDIRECT_URI` debe apuntar al **backend** (`/api/v1/auth/sso/callback`) y coincidir
  EXACTO con lo registrado en el hub. En la imagen all-in-one, el backend y el frontend son
  mismo-origen; con front/back en dominios distintos, es la URL de la **API**.
- El `ENCUESTUM_SESSION_SECRET` se reusa para firmar la cookie de transacción del flujo OIDC.
- Con `AUTH_MODE=local` (default) no cambia nada: sigue el login propio.

En dev, con el hub en `http://localhost:8081`:
```
AUTH_MODE=federado
LOCKATUS_ISSUER=http://localhost:8081
LOCKATUS_CLIENT_ID=encuestum
LOCKATUS_REDIRECT_URI=http://localhost:8000/api/v1/auth/sso/callback
```

Ver también: [Seguridad](SEGURIDAD.md) · [Deploy en EasyPanel](DEPLOY_EASYPANEL.md).
