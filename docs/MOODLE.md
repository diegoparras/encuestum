# Conectar Moodle con Encuestum

Esta guía es para quien se autohostea Encuestum y quiere conectar su propio
Moodle (no para el entorno de desarrollo local — ese está en
[`dev/moodle/README.md`](../dev/moodle/README.md), que además explica cómo
levantar un Moodle de prueba con Docker si no tenés uno).

## Cuál de los dos plugins

Hay **dos** caminos, y no hacen lo mismo. Los dos están más abajo: primero el de
LTI, que es el que hoy conviene, y después el del módulo nativo.

|  | `local_encuestum` (LTI 1.3) | `mod_encuestum` (módulo nativo) |
|---|---|---|
| **Estado** | En producción, probado de punta a punta | **Alpha** (`MATURITY_ALPHA`, 0.3.0) |
| Mecánica | La hace `mod_lti`, que Moodle ya trae | Propia: token RS256 firmado por Moodle |
| Vuelta de la nota | AGS (OAuth2 + line items) | Servicio web del propio módulo → `grade_update()` |
| Copia de seguridad y restauración del curso | No arrastra la configuración | **Todavía no** (`FEATURE_BACKUP_MOODLE2` en `false`: el backup omite la actividad) |
| Finalización de actividad | Sólo "ver" | Por nota, por entrega, por aprobado |
| Grupos y agrupamientos | No | Sí |
| Restricciones de acceso por nota de otra actividad | Limitado | Nativo |
| Depende de que `mod_lti` esté habilitado | Sí | No |
| Vista previa del docente sin ser alumno | No | Sí |
| Bandera del backend | `LTI_ENABLED` | `MOD_ENABLED` |

En resumen: **si querés algo que funcione hoy y sobreviva a un backup del curso,
usá `local_encuestum`.** El módulo nativo es lo que se va a recomendar cuando
salga de alpha —se siente parte de Moodle y no depende de `mod_lti`— pero hasta
que implemente backup/restore, un curso que se copie o se restaure pierde las
actividades de Encuestum sin decir nada.

Los dos pueden convivir: son dos puertas distintas y prender una no apaga la
otra. Encender `MOD_ENABLED` no toca nada de LTI.

> **Problema conocido con los dos instalados a la vez: "Encuestum" aparece dos
> veces en el selector de actividades.** Una entrada es la herramienta externa
> preconfigurada que crea `local_encuestum` (`lti_type_*`) y la otra es el módulo
> nativo, y las dos se llaman igual y usan el mismo ícono: el docente no tiene
> con qué distinguirlas. Está confirmado contra Moodle 5.0.2. Es una decisión de
> diseño pendiente (quién de los dos cede el nombre) y **no está arreglado**.
> Mientras tanto, lo práctico es instalar uno solo de los dos, o renombrar la
> herramienta externa de `local_encuestum` desde *Administración del sitio →
> Plugins → Herramienta externa → Gestionar herramientas*.

## Conectar por LTI 1.3 (`local_encuestum`)

> **Estado: back-end implementado (Fase 1).** Encuestum expone un tool LTI 1.3
> Advantage completo (Dynamic Registration, deep linking y AGS para devolver
> notas).

### Requisitos

- Tu instancia de Encuestum servida por **HTTPS**, en un dominio real (no
  `localhost`). El registro dinámico de LTI lo exige sin excepción.
- `ENCUESTUM_PUBLIC_URL` apuntando a ese dominio exacto — es la base con la
  que Encuestum arma las URLs que Moodle guarda al registrarse
  (`initiate_login_uri`, `redirect_uris`, `jwks_uri`, `target_link_uri`). Si
  está mal, el registro se completa "bien" y el lanzamiento nunca funciona.
- `LTI_ENABLED=true`. Ver la tabla de variables en el `README.md` principal
  (sección de configuración) para `LTI_PRIVATE_KEY` y `LTI_KEY_ID`, opcionales.
- Un Moodle con permisos de administrador del sitio.

Si tu Moodle vive en la misma red privada que Encuestum (por ejemplo, los dos
en Docker en el mismo host), además necesitás `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND=true`
— si no, el guard SSRF del backend bloquea las llamadas al JWKS y al token
endpoint de tu Moodle. Con un Moodle en un dominio público de verdad no hace
falta.

### 1. Preparar una encuesta

En Encuestum, creá una organización y publicá una encuesta. Si querés que la
nota vuelva al libro de calificaciones de Moodle, activá la evaluación con IA
(o cualquier corrección automática) y agregá al menos una pregunta que
califique — sin nota calculable, no hay nada que enviar por AGS.

### 2. Pedir la URL de registro dinámico

**No es una URL fija con un `org_id` en la query.** Esa forma existió en un
diseño temprano y se descartó por ser un IDOR: cualquiera que adivinara el
UUID de otra organización podría registrar ahí su propio Moodle y, desde el
selector de deep linking, leer su contenido.

En cambio, un admin de la organización — con sesión iniciada en Encuestum —
pide un token de propósito único, de **30 minutos de validez**, llamando:

```
POST /api/v1/lti/registration-url
```

(sin cuerpo; requiere la cookie de sesión y rol de admin de la organización).
La forma más simple de llamarlo es desde la consola del navegador (F12) estando
logueado en tu Encuestum:

```js
fetch('/api/v1/lti/registration-url', { method: 'POST' })
  .then(r => r.json()).then(console.log)
```

La respuesta trae `{"url": "https://tu-encuestum.com/lti/register?enc=<token>"}`.
Copiá esa URL completa — es lo único que necesitás pegar en Moodle. Si pasan
los 30 minutos sin usarla, pedí una nueva.

### 3. Registrar la herramienta en Moodle

En Moodle: *Administración del sitio → Plugins → Módulos de actividad →
Herramienta externa → Gestionar herramientas*. Pegá la URL del paso anterior
en el campo de **registro dinámico** y confirmá. Moodle:

1. Llama a esa URL (anónimamente, sin sesión de Encuestum — la autoridad la
   trae el `enc` del token, no una cookie).
2. Encuestum valida el token, arma su `openid_configuration` y se lo devuelve.
3. Moodle sigue el estándar de Dynamic Registration: llama al
   `registration_endpoint` que Moodle mismo expone, con el `client_id` y las
   claves que le corresponden.
4. Encuestum guarda la plataforma (issuer, client_id, URLs de login/token,
   JWKS) en su base.

Si algo falla acá, es casi siempre uno de estos tres motivos: Moodle no está
en HTTPS, `ENCUESTUM_PUBLIC_URL` no coincide con el dominio real, o el token
`enc` venció.

### 4. Agregar la actividad en un curso

En un curso: *Agregar una actividad → Herramienta externa*, elegí Encuestum de
la lista, y usá **Seleccionar contenido** — eso abre el selector de deep
linking de Encuestum (embebido en un iframe) donde el docente elige la
encuesta. Moodle guarda la actividad apuntando a esa encuesta puntual.

### 5. Responder y verificar la nota

Un alumno entra a la actividad y responde la encuesta dentro del iframe de
Moodle. Si la encuesta califica, la nota debería aparecer en el libro de
calificaciones del curso al terminar — Encuestum se la manda a Moodle por AGS
(Assignment and Grade Services), usando el token de acceso que pidió con el
line item que Moodle le dio en el lanzamiento.

## Conectar por el módulo nativo (`mod_encuestum`)

> **Estado: alpha.** Sirve para probarlo; todavía no para un curso que dependa
> de copias de seguridad (ver la tabla de arriba).

Requisitos: los mismos que LTI (HTTPS de verdad, `ENCUESTUM_PUBLIC_URL` bien
puesto) más `MOD_ENABLED=true` en el backend. Con la bandera apagada la
superficie `/mod/*` **no existe** (404, no 403) y el panel lo dice al primer
intento. No hace falta `mod_lti`.

1. **En Encuestum**, como admin de la organización: *Integraciones → Moodle y
   otros LMS → pestaña "Módulo nativo" → generar el link*. El link vale 30
   minutos y se puede volver a pedir; no es de un solo uso.
2. **En Moodle**, como administrador del sitio: *Administración del sitio →
   Plugins → Módulos de actividad → Encuestum → Conectar*, pegar el link y
   confirmar. En ese paso Moodle genera un par de claves RSA (sólo manda la
   pública), enciende los servicios web y el protocolo REST si estaban
   apagados, y crea una cuenta de servicio dedicada cuyo único permiso es
   recibir las notas de este módulo. **Nunca se entrega un token de
   administrador.**
3. **En un curso**, el docente agrega la actividad *Encuestum* y elige la
   encuesta de un desplegable que sale de las encuestas **publicadas** de esa
   organización (los borradores no aparecen, y las de otras organizaciones
   tampoco).
4. El alumno abre la actividad y responde embebido. Si la encuesta califica, la
   nota vuelve al libro de calificaciones.

Dos cosas que conviene saber antes de configurar una actividad:

- **Anónima y con nota son excluyentes.** Marcar la actividad como anónima hace
  que Moodle no mande ni el nombre ni el email, que Encuestum no guarde a quién
  pertenece la respuesta y que **no se publique ninguna nota**. No es un efecto
  secundario: publicar una nota por alumno es identificarlo. El propio servicio
  web rechaza una nota dirigida a una actividad anónima aunque llegue.
- **Reconectar rota el par de claves.** Es la forma soportada de recuperarse de
  una clave comprometida, pero cualquier encuesta que un alumno tenga abierta en
  ese momento deja de funcionar hasta que vuelva a entrar a la actividad.

Un Moodle no se puede conectar a dos organizaciones de Encuestum: si el sitio ya
está registrado bajo otra, la conexión falla con **409** y no se toca nada. Es
deliberado —sin eso, el Moodle de una escuela pasaría a lanzar contra los datos
de otra con sólo registrarse segundo.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| El registro dinámico falla con un error de Moodle sobre HTTPS | Tu Moodle no está servido por HTTPS, o tiene un certificado que el registro rechaza. |
| El registro "se completa" pero el lanzamiento da error de plataforma no encontrada | `ENCUESTUM_PUBLIC_URL` no coincide con el dominio con el que Moodle en verdad llegó a Encuestum (por ejemplo, quedó en `http://` o con un puerto de más). |
| El alumno ve un error de sesión al abrir la actividad | Encuestum no está en HTTPS de verdad (las cookies del flujo LTI son `SameSite=None; Secure`, se descartan sobre HTTP), o Moodle está cargando la actividad en un contexto que bloquea cookies de terceros. Probá con **Contenedor de lanzamiento: Ventana nueva** en la configuración de la herramienta. |
| El selector de deep linking no lista ninguna encuesta | No hay encuestas **publicadas** en la organización que registró la plataforma. |
| La nota no llega al libro de calificaciones | La encuesta no tiene evaluación automática configurada (nada que calificar), o el token de AGS venció — revisá los logs del backend de Encuestum. |
| **(módulo nativo)** "Encuestum" aparece dos veces en el selector de actividades | Están instalados los dos plugins. Problema conocido y sin arreglar: ver el recuadro de "Cuál de los dos plugins". |
| **(módulo nativo)** El botón de conectar da 404 / el panel dice que el módulo está apagado | Falta `MOD_ENABLED=true` en el backend de Encuestum. |
| **(módulo nativo)** Moodle dice que el sitio ya está conectado a otra organización | Es el 409 a propósito. Hay que desconectar el sitio de la otra organización primero. |
| **(módulo nativo)** El desplegable de encuestas está vacío o el formulario cae al campo de texto | El sitio no está conectado, o Encuestum no contestó a tiempo. El formulario sigue guardándose a propósito: una caída de Encuestum no debe bloquear la edición del curso. |
| **(módulo nativo)** La actividad es anónima y no aparece ninguna nota | Es lo esperado. Anónima y calificada son excluyentes. |
