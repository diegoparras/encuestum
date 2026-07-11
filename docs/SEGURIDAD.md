# Seguridad

Resumen de los mecanismos de seguridad de Encuestum y cómo configurarlos. Todo es
self-hosted: no hay telemetría ni servicios de terceros salvo los que vos conectes
(tu SMTP, tu proveedor de IA, tu bucket).

---

## 1. Anti-bot: captcha proof-of-work

Protege el **envío de respuestas** en encuestas **públicas** contra el spam de bots,
sin depender de terceros ni molestar a las personas.

**Cómo funciona (estilo Altcha):** el server firma un desafío `sha256(salt + n)`; el
navegador encuentra `n` por fuerza bruta (invisible, ~medio segundo) y lo manda con el
submit. El server verifica el hash, la **firma HMAC** (para que no se pueda falsificar),
la **expiración** y que **no se haya usado antes** (anti-replay). Nada sale de tu instancia,
no hay keys que configurar, no hay puzzles.

**Activarlo:** es **por encuesta**. En el builder → panel de **Acceso** (modo *Público*) →
toggle **"Protección anti-bot"**. Solo aplica a esa encuesta; el resto sigue igual.

**Variables (opcionales):**

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_CAPTCHA_ENABLED` | `true` | Kill-switch global. En `false`, ninguna encuesta exige el desafío. |
| `ENCUESTUM_CAPTCHA_DIFFICULTY` | `120000` | Tamaño del espacio de búsqueda. Más alto = más caro para bots, más lento para todos. |
| `ENCUESTUM_CAPTCHA_TTL_SECONDS` | `600` | Vida del desafío. |

> El estado anti-replay es **en memoria** (bien para una sola instancia). Con varias
> instancias detrás de un balanceador, un desafío resuelto podría reusarse en otra
> instancia dentro de la ventana de TTL; para multi-instancia estricto conviene un
> store compartido (Redis) — hoy no está implementado para el captcha.

Además del captcha, cada endpoint público tiene **rate-limit** y las encuestas anónimas
llevan **honeypot**; el captcha es la capa extra para exposición 100 % abierta.

---

## 2. Rate limiting

Frena fuerza bruta y abuso. Se aplica a los endpoints sensibles (login, acceso a
encuesta, submit, reset, verificación, subida de archivos, grade-question, tracking).

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_RATE_LIMIT_ENABLED` | `true` | Prende/apaga el limiter. |
| `ENCUESTUM_REDIS_URL` | — | Si lo definís, el limiter usa Redis. **Necesario si corrés más de una instancia** (si no, cada instancia cuenta por separado). |

---

## 3. Detrás de un proxy (IP real) — `TRUST_PROXY`

El rate-limit necesita la IP del cliente. Por defecto **no** confía en `X-Forwarded-For`
(un cliente podría spoofear su IP para evadir el límite).

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_TRUST_PROXY` | `false` | Ponelo en `true` **solo** si Encuestum está detrás de un proxy tuyo (nginx, Traefik, el proxy de EasyPanel) que setea `X-Forwarded-For`. Se toma el hop de más a la derecha. |

> Regla: expuesto **directo** a internet → `false`. Detrás de un **proxy que controlás** →
> `true` (si no, todos comparten la IP del proxy y el rate-limit no discrimina).

---

## 4. Anti-SSRF (salidas a la red)

Encuestum hace requests salientes en dos casos: **webhooks** (entrega de respuestas) y la
**base URL del proveedor de IA**. El guard bloquea destinos hacia IPs **privadas /
loopback / link-local / metadata** para evitar SSRF (que alguien apunte un webhook a
`http://169.254.169.254/…` o a tu red interna).

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND` | `false` | Permite salidas a IPs internas. **Dejalo en `false` en multi-tenant.** Solo activalo en self-host de un solo tenant que usa un LLM local (ej. Ollama en `localhost`). |

---

## 5. Sesiones y cookies

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_SESSION_SECRET` | *(efímero)* | **Firma las cookies de sesión. OBLIGATORIO en producción.** Si cambia o no se setea, se invalidan todas las sesiones en cada reinicio. Generá uno estable: `openssl rand -hex 32`. |
| `ENCUESTUM_COOKIE_SECURE` | `true` | Cookies solo por HTTPS. Dejalo `true` en producción; `false` solo para probar en `http://localhost`. |
| `ENCUESTUM_COOKIE_SAMESITE` | `lax` | Política SameSite de la cookie. |
| `ENCUESTUM_SESSION_TTL_DAYS` | `30` | Duración de la sesión. |

- Passwords con **bcrypt**. Sesión por **JWT firmado** en cookie **HttpOnly**.
- Si arranca sin `SESSION_SECRET`, el server **loguea una advertencia** (usa uno efímero).

---

## 6. HSTS y headers de seguridad

En cada respuesta se setean: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
(no embebible en iframes de terceros), `Referrer-Policy: no-referrer`, `X-XSS-Protection: 0`.

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_ENABLE_HSTS` | `true` | Manda `Strict-Transport-Security` (solo bajo HTTPS). |

También hay un **tope de cuerpo** de 2 MB para JSON/formularios (las subidas de archivos
van por presigned, exentas del tope).

---

## 7. Registro y verificación de email

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_ALLOW_REGISTRATION` | `true` | Auto-registro público. Ponelo en `false` para cerrar el alta de cuentas. |
| `ENCUESTUM_REQUIRE_EMAIL_VERIFICATION` | `false` | Exige email verificado antes de ingresar. Requiere SMTP configurado (si no, nadie podría verificar). |

---

## 8. Super-admin de la plataforma

| Variable | Default | Descripción |
|---|---|---|
| `ENCUESTUM_SUPERADMIN_EMAIL` | — | Este email tiene acceso al panel `/admin` (todas las organizaciones, usuarios y uso). |

> Por seguridad, el acceso por email de super-admin **exige que ese email esté verificado**
> (no alcanza con coincidir el string). También podés marcar `is_superadmin` en un usuario.

---

## 9. Control de acceso a las encuestas

Cada encuesta define **quién puede responder** (panel de Acceso):

- **Pública** — cualquiera con el link (sumale el **captcha** anti-bot si es 100 % abierta).
- **Con clave (PIN)** — una contraseña compartida.
- **Lista de emails admitidos** — cada persona con su **código único** y **link mágico** por email.

Y **quién ve el resultado de la corrección** (`results_mode`): `immediate`, `on_release`
(el dueño publica cuando quiere), o `never`. Los endpoints de resultado/corrección están
**gateados** por el token de acceso cuando la encuesta es privada.

---

## 10. Aislamiento multi-tenant

Todo está scopeado por **organización**: encuestas, respuestas, miembros, proveedores de
IA y uso. Las operaciones administrativas (borrar encuesta/respuesta, exportar, invitados,
publicar resultados) exigen rol **admin/owner** de esa organización. Las claves de
corrección y rúbricas (`evaluation`) **nunca** se exponen al respondiente (server-side only).

---

## Checklist de producción

- [ ] `ENCUESTUM_SESSION_SECRET` estable (`openssl rand -hex 32`).
- [ ] `ENCUESTUM_COOKIE_SECURE=true` y servís por **HTTPS** (TLS lo pone EasyPanel/tu proxy).
- [ ] `ENCUESTUM_ENABLE_HSTS=true`.
- [ ] `ENCUESTUM_TRUST_PROXY=true` **solo** si estás detrás de un proxy propio.
- [ ] `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND=false` (salvo LLM local single-tenant).
- [ ] `ENCUESTUM_SUPERADMIN_EMAIL` seteado (y ese email verificado).
- [ ] `ENCUESTUM_REDIS_URL` si corrés más de una instancia (rate-limit compartido).
- [ ] Activá el **captcha anti-bot** en las encuestas públicas y abiertas.
- [ ] Storage externo (R2/S3) con bucket de **lectura pública** + CORS acotada a tu dominio (ver [Almacenamiento externo](ALMACENAMIENTO_EXTERNO.md)).
- [ ] SMTP configurado si querés verificación de email / invitaciones reales.

Reporte de vulnerabilidades: ver la política de seguridad del repo (si corresponde) o abrí
un issue privado. Ver también: [Almacenamiento externo](ALMACENAMIENTO_EXTERNO.md) ·
[Federación con Lockatus](LOCKATUS.md).
