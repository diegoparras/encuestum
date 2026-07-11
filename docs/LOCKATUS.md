# Federación con Lockatus (SSO de la Suite Escriba)

> **Estado: NO implementado todavía.** Encuestum hoy usa **cuentas locales** (registro +
> login propio con bcrypt/JWT). Este documento describe **qué es** la federación, **cómo se
> haría** siguiendo el patrón probado de la suite, y **qué falta construir**. Cuando el
> cliente OIDC esté vendorizado en Encuestum, esta guía pasa a ser el manual de uso.

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

## Lo que habría que construir en Encuestum

Siguiendo la guía [`AGREGAR-APP.md`](https://github.com/diegoparras/lockatus) del hub y los
clientes de referencia en Python (**Anonimal**: `app/lockatus_client.py`, con `cryptography`;
**Fisherboy**), el trabajo es:

1. **Cliente OIDC** (`backend/app/lockatus_client.py`): `begin_login()` (arma PKCE+state+nonce,
   cookie de transacción firmada, URL de `/authorize`) y `handle_callback()` (canjea el `code`
   en `/token`, verifica los JWT RS256 contra el JWKS cacheado). Sin dependencias pesadas
   (verificación RS256 con `cryptography`).
2. **Rutas** en `auth.py` cuando `AUTH_MODE=federado`:
   - `GET /api/v1/auth/login` → `begin_login()` → 302 al hub.
   - `GET /api/v1/auth/callback` → `handle_callback()` → **find-or-create** del usuario por
     email → **mapea el rol** del hub al modelo de Encuestum → **siembra la cookie de sesión**
     existente (el resto del gating por rol no cambia).
   - `logout` → limpia la cookie (y opcionalmente el `end_session` del hub).
3. **Frontend**: cuando `AUTH_MODE=federado`, la pantalla de login muestra **"Entrar con la
   Suite Escriba"** (un botón que va a `/api/v1/auth/login`) en vez del formulario local.
4. **Decisión de diseño — orgs/roles**: Encuestum es **multi-tenant** (organizaciones + roles
   `owner/admin/member`), mientras que Lockatus da **un rol por app**. Hay que decidir el mapeo:
   - *Opción simple*: el rol del hub (`admin`/`member`/…) mapea al rol dentro de una
     **organización por defecto** (todos los usuarios federados caen en la misma org).
   - *Opción multi-org*: mantener el modelo de invitaciones de Encuestum para las orgs, y usar
     Lockatus **solo para la identidad** (quién sos), no para el rol por org.
   Esta decisión es la única parte "no mecánica" (el resto es copiar el patrón de la suite).

---

## Configuración (cuando esté implementado)

**En el hub** (declarar la app) — endpoint admin de Lockatus:

```
PUT /api/admin/apps/encuestum
{ "name": "Encuestum",
  "roles": ["admin", "member"],
  "redirect_uris": ["https://encuestas.tudominio.com/api/v1/auth/callback"] }
```

Después: registrar el/los `redirect_uri` exactos y **asignar roles** a los usuarios en la
matriz de accesos del hub (sin rol para `encuestum`, el usuario recibe `access_denied`).

**En Encuestum** (variables):

```
AUTH_MODE=federado
LOCKATUS_ISSUER=https://identidad.tudominio.com        # URL pública del hub
LOCKATUS_CLIENT_ID=encuestum
LOCKATUS_REDIRECT_URI=https://encuestas.tudominio.com/api/v1/auth/callback
```

Con `AUTH_MODE=local` (default) no cambia nada: sigue el login propio.

---

## ¿Lo construimos?

El patrón está **probado** en 4+ apps de la suite y hay clientes Python de referencia, así que
es un trabajo acotado y de bajo riesgo (salvo la decisión de mapeo orgs/roles del punto 4).
Si querés, se implementa el cliente + las rutas + el botón de login y esta guía pasa a ser el
manual real.

Ver también: [Seguridad](SEGURIDAD.md) · [Deploy en EasyPanel](DEPLOY_EASYPANEL.md).
