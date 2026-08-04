# Conectar Moodle con Encuestum (LTI 1.3)

> **Estado: back-end implementado (Fase 1).** Encuestum expone un tool LTI 1.3
> Advantage completo (Dynamic Registration, deep linking y AGS para devolver
> notas). Lo que falta para una experiencia pulida (Fase 2) es un plugin
> `mod_encuestum` propio en Moodle; hasta entonces se conecta con la
> herramienta externa genérica que Moodle ya trae.

Esta guía es para quien se autohostea Encuestum y quiere conectar su propio
Moodle (no para el entorno de desarrollo local — ese está en
[`dev/moodle/README.md`](../dev/moodle/README.md), que además explica cómo
levantar un Moodle de prueba con Docker si no tenés uno).

## Requisitos

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

## 1. Preparar una encuesta

En Encuestum, creá una organización y publicá una encuesta. Si querés que la
nota vuelva al libro de calificaciones de Moodle, activá la evaluación con IA
(o cualquier corrección automática) y agregá al menos una pregunta que
califique — sin nota calculable, no hay nada que enviar por AGS.

## 2. Pedir la URL de registro dinámico

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

## 3. Registrar la herramienta en Moodle

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

## 4. Agregar la actividad en un curso

En un curso: *Agregar una actividad → Herramienta externa*, elegí Encuestum de
la lista, y usá **Seleccionar contenido** — eso abre el selector de deep
linking de Encuestum (embebido en un iframe) donde el docente elige la
encuesta. Moodle guarda la actividad apuntando a esa encuesta puntual.

## 5. Responder y verificar la nota

Un alumno entra a la actividad y responde la encuesta dentro del iframe de
Moodle. Si la encuesta califica, la nota debería aparecer en el libro de
calificaciones del curso al terminar — Encuestum se la manda a Moodle por AGS
(Assignment and Grade Services), usando el token de acceso que pidió con el
line item que Moodle le dio en el lanzamiento.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| El registro dinámico falla con un error de Moodle sobre HTTPS | Tu Moodle no está servido por HTTPS, o tiene un certificado que el registro rechaza. |
| El registro "se completa" pero el lanzamiento da error de plataforma no encontrada | `ENCUESTUM_PUBLIC_URL` no coincide con el dominio con el que Moodle en verdad llegó a Encuestum (por ejemplo, quedó en `http://` o con un puerto de más). |
| El alumno ve un error de sesión al abrir la actividad | Encuestum no está en HTTPS de verdad (las cookies del flujo LTI son `SameSite=None; Secure`, se descartan sobre HTTP), o Moodle está cargando la actividad en un contexto que bloquea cookies de terceros. Probá con **Contenedor de lanzamiento: Ventana nueva** en la configuración de la herramienta. |
| El selector de deep linking no lista ninguna encuesta | No hay encuestas **publicadas** en la organización que registró la plataforma. |
| La nota no llega al libro de calificaciones | La encuesta no tiene evaluación automática configurada (nada que calificar), o el token de AGS venció — revisá los logs del backend de Encuestum. |
