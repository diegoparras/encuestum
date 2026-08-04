# Encuestum ⇄ Moodle: integración LTI 1.3 Advantage

**Fecha:** 2026-08-03
**Estado:** diseño aprobado, pendiente de implementación

## Objetivo

Que un docente pueda agregar una encuesta o examen de Encuestum como actividad de un
curso de Moodle: los alumnos entran sin loguearse aparte, y la nota que produce la
corrección con IA cae sola en el libro de calificaciones. El resultado se publica como
plugin en el **Moodle Marketplace**.

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Profundidad | Actividad con nota (LTI 1.3 Advantage) | Es lo que espera una institución y lo que justifica un plugin publicado |
| Tenencia | Cada escuela self-hostea su Encuestum | Coherente con el ADN del proyecto; un Moodle ↔ un Encuestum |
| Tipo de plugin | `mod_encuestum` (actividad propia) | Mejor experiencia docente y mejor presencia en el Marketplace |
| Protocolo | LTI 1.3 / LTI Advantage | Estándar 1EdTech; evita un plugin propietario por cada LMS |

### Riesgo asumido conscientemente

`mod_encuestum` obliga a implementar el **lado plataforma** de LTI 1.3 dentro del plugin
PHP. Moodle core ya lo hace en `mod_lti`, pero no expone una API pública reutilizable, así
que hay que escribir el `authorize`, el JWKS, el endpoint de token y los servicios AGS. Es
aproximadamente el 60% del trabajo PHP. Existe precedente aprobado en el directorio
(`mod_kialo` hace exactamente esto), o sea que es viable. La alternativa descartada era un
`local_encuestum` que solo registrara la herramienta y dejara el trabajo a `mod_lti`: una
tarde de trabajo, pero la marca queda escondida detrás de "Herramienta externa".

## Arquitectura

Tres piezas, dos repositorios.

| Pieza | Ubicación | Rol |
|---|---|---|
| LTI Tool | este repo: `backend/app/routers/lti.py` + modelos | Encuestum como *herramienta* LTI 1.3 |
| `mod_encuestum` | repo nuevo `moodle-mod_encuestum` (GPLv3) | Actividad de Moodle; actúa como *plataforma* LTI |
| Entorno de pruebas | este repo: `dev/moodle/` | Docker: Moodle + MariaDB + Encuestum + Postgres + proxy TLS |

### Flujo completo

1. **Instalación.** El admin de Moodle instala el plugin, pega la URL de su Encuestum y
   aprieta "Conectar". Se usa **Dynamic Registration** (OIDC Dynamic Client Registration +
   LTI Tool Configuration): ambas partes se auto-configuran e intercambian `client_id`,
   `deployment_id` y URLs de JWKS. Sin copiar y pegar seis campos a mano.
2. **Docente.** *Agregar actividad → Encuestum* → "Elegir encuesta" abre un selector
   servido por Encuestum (**Deep Linking**), autenticado por el propio lanzamiento. Elige
   una encuesta o examen existente, o salta al editor de Encuestum a crear uno.
3. **Alumno.** Clic en la actividad → OIDC third-party initiated login → `id_token` firmado
   por el plugin → Encuestum lo valida contra el JWKS del plugin → identifica al
   respondiente por `(issuer, deployment_id, sub)` → sirve la encuesta con el runtime
   SurveyJS de siempre, **salteando `access_mode`** (la identidad ya la puso Moodle).
4. **Nota.** Al enviar y corregir con IA, Encuestum pide un token `client_credentials` al
   plugin (con `client_assertion` firmado con su clave privada), crea el *line item* si
   falta y hace `POST` del score → la nota aparece en el libro de calificaciones.

## Lado Encuestum (Python / FastAPI)

### Modelos nuevos

- `LtiPlatform` — issuer, `client_id`, `deployment_ids`, `auth_login_url`,
  `auth_token_url`, `jwks_url`, `org_id`. Una fila por Moodle conectado.
- `LtiResourceLink` — `platform_id`, `resource_link_id`, `context_id`, `survey_id`,
  `lineitem_url`, `max_score`.
- `LtiUser` — `platform_id`, `sub`, email, nombre, roles.

En `SurveyResponse` se agregan `lti_link_id` y `lti_sub`, para idempotencia y para
reenviar la nota si se recorrige una respuesta.

### Endpoints (`/lti/`)

| Ruta | Método | Función |
|---|---|---|
| `/lti/jwks.json` | GET | Clave pública del tool (par RSA generado al arrancar, guardado cifrado) |
| `/lti/register` | GET/POST | Dynamic Registration; token de un solo uso emitido por el admin |
| `/lti/login` | GET/POST | OIDC third-party initiated login |
| `/lti/launch` | POST | Resource link launch y deep linking launch |
| `/lti/select` | GET | Selector de encuestas (Next.js) |
| `/lti/select/return` | POST | Firma y devuelve la `DeepLinkingResponse` |

### Seguridad

Validación de `iss`, `aud`, `nonce`, `exp` e `iat`; nonce de un solo uso en Redis (ya
disponible en el proyecto); `deployment_id` contra allowlist; cookie de `state` con
`SameSite=None; Secure`. Se reutiliza el patrón de verificación JWKS que ya existe en
`backend/app/lockatus_client.py`. Todo detrás de `LTI_ENABLED` (default apagado: quien no
use Moodle no ve ningún cambio).

## Lado Moodle (PHP, GPLv3)

Repositorio separado `moodle-mod_encuestum`, con el plugin en la raíz — el Marketplace
espera un repositorio por plugin, con nombre `moodle-{tipo}_{nombre}`.

El lado plataforma se implementa con `\Firebase\JWT\JWT`, que ya viene en Moodle core: sin
librerías vendored, que el revisor penaliza.

### Ajustes por actividad

Encuesta seleccionada (vía deep link), nota máxima, intentos permitidos, contenedor
(embebido o ventana nueva) y un toggle **"respuestas anónimas"** que envía un `sub`
pairwise, no crea line item y desactiva el passback — necesario para NPS y encuestas de
clima, donde identificar al alumno rompe el instrumento.

### Obligatorio para aprobación, desde el día uno

- `classes/privacy/provider.php` declarando que se envían nombre, email y rol a un servicio
  externo (`add_external_location_link`).
- Backup / restore (`backup/moodle2/`).
- Strings en inglés como idioma base; español como traducción.
- Boilerplate GPLv3 en cada archivo.
- CI con `moodle-plugin-ci`: codechecker, phpdoc, phpunit, behat, mustache lint, grunt.
- Compatibilidad MySQL y PostgreSQL.
- Rastreador de issues público (GitHub Issues).

## Entorno Docker (`dev/moodle/`)

Compose con `mariadb:11` + Moodle 5.x + Encuestum + `postgres:16`, con el plugin
bind-mounteado en `mod/encuestum` para editar y recargar sin reconstruir.

Un **Caddy con `tls internal`** publica `https://moodle.localhost` y
`https://encuestum.localhost`. Es necesario: sin HTTPS los navegadores bloquean las cookies
del iframe (`SameSite=None; Secure`) y el lanzamiento embebido no funciona. Hay que
instalar la CA de Caddy una vez; el fallback documentado es lanzar en ventana nueva.

Un script `dev/moodle/up.ps1` levanta todo, espera a que Moodle termine de instalarse, y
deja un curso demo con un docente y dos alumnos cargados.

## Fases

Cada fase es entregable por sí sola.

### Fase 1 — LTI Tool en Encuestum + entorno Docker

Se prueba de punta a punta con la **"Herramienta externa" nativa de Moodle**, sin escribir
una línea de PHP. Al terminar esta fase la integración ya funciona: un docente puede
configurar Encuestum como herramienta externa y las notas llegan al libro de
calificaciones. Todo lo demás es experiencia de usuario y distribución.

### Fase 2 — `mod_encuestum`

La actividad nativa: formulario, vista, deep linking y AGS del lado plataforma, privacy
API, backup/restore.

### Fase 3 — Empaquetado, CI y documentación

`moodle-plugin-ci` en GitHub Actions contra las versiones de Moodle mantenidas, README,
strings en inglés, capturas de pantalla, ZIP de release.

### Fase 4 — Publicación en el Moodle Marketplace

Guía paso a paso para que la haga el dueño del proyecto. Ver abajo.

## Fase 4: cómo publicarlo en el Marketplace

### Qué cambió (importante)

El histórico **Moodle Plugins Directory** (`moodle.org/plugins`) fue reemplazado por el
**Moodle Marketplace** (`marketplace.moodle.com`), que abrió el 20 de julio de 2026. El
directorio viejo quedó en solo lectura: **ya no se envían plugins ahí**. Los plugins
gratuitos que existían se migraron automáticamente con sus archivos y metadatos. El
Marketplace acepta tanto plugins gratuitos como pagos.

### Pasos

1. **Cuenta y alta como proveedor.** Registrarse en el portal de proveedores del
   Marketplace y aceptar los *Provider terms*. Esto lo tiene que hacer una persona: no se
   pueden crear cuentas ni aceptar términos en nombre de otro.
2. **Repositorio público.** `moodle-mod_encuestum` en GitHub, licencia GPLv3, Issues
   habilitados, README con instalación y configuración, y capturas de pantalla.
3. **Preparar la ficha.** Nombre, descripción breve y descripción larga en inglés, tipo de
   plugin (activity module), versiones de Moodle soportadas, capturas, y — como Encuestum
   es un servicio externo — la declaración de que requiere una instancia propia.
4. **Subir la versión.** Se sube el ZIP del plugin (no se sincroniza solo desde GitHub: las
   versiones nuevas se publican explícitamente).
5. **Validación automática.** El Marketplace corre pruebas automáticas sobre el ZIP.
   Conviene que `moodle-plugin-ci` ya esté verde antes de subir: es prácticamente el mismo
   conjunto de comprobaciones.
6. **Revisión humana.** Se abre un ticket de Jira dedicado donde el revisor deja
   observaciones. Tarda varias semanas. **Casi todos los plugins vuelven como "necesita más
   trabajo" en la primera vuelta**: hay que presupuestar al menos una ronda de correcciones.
7. **Aprobación.** Al aprobarse, las cadenas de idioma se registran en AMOS para que la
   comunidad las traduzca.

### Bloqueadores de aprobación conocidos

No se aprueba un plugin que: no tenga rastreador de issues público, no funcione en MySQL y
PostgreSQL a la vez, colisione en el namespace frankenstyle, tenga fallas de seguridad, no
implemente la Privacy API (obligatoria cuando hay integración externa, que es exactamente
nuestro caso), no implemente Backup/Restore (obligatoria en módulos de actividad), o entre
en conflicto con productos comerciales de Moodle.

### Pendiente de confirmar

La documentación detallada para proveedores está detrás del login de Confluence de Moodle,
así que los pasos 1, 3 y 4 hay que confirmarlos contra el portal real al momento de
publicar:

- Marketplace: <https://marketplace.moodle.com/>
- Guía de listado: <https://moodle.atlassian.net/wiki/external/MzFlM2RkYjM3ZDVhNDgyMGJmYjA2ZjIyMzQ1NDRlYmY>
- Documentación de proveedores: <https://moodle.atlassian.net/wiki/external/YTI4MmY4MWU2MDQyNDk5MTllZWY4YTBiNjA5ZDRjNWY>
- Términos de proveedor: <https://moodle.atlassian.net/wiki/external/NzZlYWExYTIzZmU5NDJiYzgwODJjNmU1MjhiNDQ0YjQ>
- Soporte: <https://moodle.atlassian.net/servicedesk/customer/portal/166>
- Guías de contribución: <https://moodledev.io/general/community/plugincontribution/checklist>

### Licencia

Todo plugin de Moodle debe ser **GPL v3 o posterior**. Encuestum es MIT, que es compatible
con GPL: el código MIT puede incorporarse a un proyecto GPL. El plugin vive en su propio
repositorio bajo GPLv3 y Encuestum sigue siendo MIT. No hay conflicto.

## Fuera de alcance (YAGNI)

- NRPS (Names and Role Provisioning: sincronización de listas de curso).
- LTI 1.1 legacy.
- Plugin de bloque.
- Crear encuestas desde dentro del iframe de Moodle sin pasar por el editor de Encuestum.

## Pruebas

- **Python:** pytest sobre validación de JWT, replay de nonce, obtención del token AGS,
  firma de la `DeepLinkingResponse`, y mapeo de score.
- **PHP:** phpunit y behat, exigidos por `moodle-plugin-ci`.
- **De punta a punta:** manual sobre el entorno Docker, con el curso demo.
