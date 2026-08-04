# Entorno de pruebas: Moodle + Encuestum

Levanta un Moodle y un Encuestum que se hablan por HTTPS, para desarrollar y
probar la integración LTI 1.3 contra un LMS real (hasta ahora todo se probó
contra un JWKS simulado en los tests).

## Arrancar

```powershell
.\up.ps1
```

- Moodle: <https://moodle.localhost> (usuario `admin`)
- Encuestum: <https://encuestum.localhost>

La primera vez Moodle tarda varios minutos en instalarse (bajando/inicializando
la base). `up.ps1` espera a que ambos respondan antes de darse por terminado.

Si querés cambiar la contraseña del admin de Moodle, copiá `.env.example` a
`.env` en esta carpeta y editala ahí.

## Por qué HTTPS

El lanzamiento LTI ocurre dentro de un iframe: Encuestum se muestra embebido en
una página de Moodle. Las cookies que viajan en ese contexto necesitan
`SameSite=None; Secure`, y `Secure` exige HTTPS. Sobre HTTP plano el navegador
descarta la cookie y el alumno ve un error de sesión.

Además, el registro dinámico de LTI (el asistente que usa Moodle para darse de
alta como plataforma) **exige que el sitio esté servido por HTTPS, sin
excepción** — el chequeo corre antes que cualquier lógica de "esto es una IP
privada, dejalo pasar". Un Moodle en HTTP plano nunca completa el registro.

Caddy emite los certificados con su CA interna. Hay que confiar en ella una vez:

```powershell
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt
Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Si preferís no tocar el almacén de certificados, configurá la herramienta externa
en Moodle con **Contenedor de lanzamiento: Ventana nueva**. Ahí las cookies dejan
de ser de terceros y el flujo tolera certificados no confiados (con la
advertencia del navegador de por medio).

## Cómo se hablan Moodle y Encuestum por dentro

Caddy es el único punto de entrada TLS y está declarado como alias de red de
**ambos** hostnames (`moodle.localhost` y `encuestum.localhost`). Eso significa
que cuando el contenedor de Encuestum necesita el JWKS de Moodle, o Moodle
necesita pedir un token en el endpoint de AGS de Encuestum, esas llamadas
*también* resuelven a Caddy y viajan por HTTPS con el mismo certificado que ve
el navegador — no hay una ruta interna en HTTP plano paralela a la pública.

Como `moodle.localhost`/`encuestum.localhost` resuelven, desde adentro de la
red de Docker, a la IP privada del contenedor de Caddy, el guard SSRF del
backend (pensado para bloquear que un tenant use la app para pegarle a la red
interna de quien la self-hostea) bloquearía esas llamadas por defecto. Por eso
`docker-compose.yml` prende `ENCUESTUM_ALLOW_PRIVATE_OUTBOUND=true` — **solo
tiene sentido en un entorno de desarrollo como este**, donde el propio LMS de
prueba vive en la red privada de Docker; en producción el LMS real está en un
dominio público de verdad y esta variable debe quedar apagada.

## Probar la integración sin el plugin

Hasta que exista `mod_encuestum` (Fase 2), se prueba con la herramienta externa
que ya trae Moodle.

1. En Encuestum (<https://encuestum.localhost>), registrate, creá una
   organización y una encuesta publicada. Si querés probar que la nota vuelve
   a Moodle, activá la evaluación con IA y agregá al menos una pregunta que
   califique.

2. Pedí la URL de registro dinámico. **No es una URL fija con un `org_id` en
   la query** (eso era un IDOR — cualquiera que adivinara el UUID de otra
   organización podría registrar ahí su propio Moodle). Es un token firmado de
   un solo destino, de 30 minutos de validez, que sólo un admin de tu
   organización puede pedir, ya logueado en Encuestum:

   - Abrí <https://encuestum.localhost> con sesión iniciada, abrí la consola
     del navegador (F12) y corré:

     ```js
     fetch('/api/v1/lti/registration-url', { method: 'POST' })
       .then(r => r.json()).then(console.log)
     ```

   - Copiá el campo `url` de la respuesta. Tiene esta forma:

     ```
     https://encuestum.localhost/lti/register?enc=<token>
     ```

3. En Moodle: *Administración del sitio → Plugins → Módulos de actividad →
   Herramienta externa → Gestionar herramientas*. Pegá esa URL completa (con
   el `enc=...`) en el campo de registro dinámico y confirmá. Moodle hace el
   registro solo, contra el `enc` que generaste — si tarda más de 30 minutos
   en usarlo, pedí uno nuevo.

4. En un curso: *Agregar una actividad → Herramienta externa*, elegí Encuestum,
   y usá **Seleccionar contenido** para elegir la encuesta desde el selector de
   deep linking.

5. Entrá como alumno (o con rol de estudiante) y respondé. Si la encuesta tiene
   evaluación con IA, la nota debería aparecer en el libro de calificaciones
   del curso al terminar de responder.

## Apagar

```powershell
docker compose down          # conserva los datos
docker compose down -v       # borra todo y empieza de cero
```

## Sobre la imagen de Moodle

Este compose usa `bitnamilegacy/moodle:5.0.2`. `bitnami/moodle` (sin el sufijo
`legacy`) dejó de tener tags gratuitos en Docker Hub — pasó a "Bitnami Secure
Images", un catálogo de pago. `bitnamilegacy/moodle` es el espejo gratuito,
pero está **congelado**: no recibe actualizaciones de seguridad. Sirve para
probar la integración LTI; no lo uses como base de un Moodle real sin
revisarlo primero.
