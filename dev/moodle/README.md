# Entorno de pruebas: Moodle + Encuestum

Levanta un Moodle y un Encuestum configurados para hablarse por HTTPS entre sí
(no solo con el navegador), para desarrollar y probar la integración LTI 1.3
contra un LMS real (hasta ahora todo se probó contra un JWKS simulado en los
tests). Ver "Cómo se hablan Moodle y Encuestum por dentro" más abajo para el
detalle de qué hace falta para que eso funcione y qué de esto sigue sin
confirmarse contra un daemon de Docker real.

## Arrancar

```powershell
.\up.ps1
```

- Moodle: <https://moodle.lvh.me> (usuario `admin`)
- Encuestum: <https://encuestum.lvh.me>

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

Caddy emite los certificados con su CA interna, generada **de cero la primera
vez que arranca** (`tls internal` en el `Caddyfile`). `up.ps1` la extrae sola
a `caddy-root.crt` en esta carpeta antes de levantar el resto — no hay que
correr nada a mano para eso (ver la sección de abajo). Lo único manual que
puede quedar es tu propio navegador:

```powershell
Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Si preferís no tocar el almacén de certificados, configurá la herramienta externa
en Moodle con **Contenedor de lanzamiento: Ventana nueva**. Ahí las cookies dejan
de ser de terceros y el flujo tolera certificados no confiados (con la
advertencia del navegador de por medio).

## Por qué hace falta confiar en la CA de Caddy (y no solo el navegador)

Esto es un artefacto de usar TLS local autofirmado, no algo que un
despliegue real necesite. Con un certificado de una CA pública de verdad (el
caso normal en producción: Let's Encrypt, o lo que sea que emita el dominio
público donde vive tu Moodle real), **nada de esta sección aplica** — ni el
paso de extracción, ni el de "sumar la CA" en cada contenedor. Todo esto
existe únicamente porque `tls internal` fabrica una CA que **nadie conoce
todavía** — ni tu navegador, ni los propios contenedores.

Importar la CA en tu navegador (arriba) resuelve la advertencia de
certificado *para vos*, mirando la página. Pero eso no alcanza: Moodle y
Encuestum también se hablan entre sí por HTTPS — Moodle pidiendo el `jwks_uri`
de Encuestum para AGS, Encuestum pidiendo `openid_configuration`,
`registration_endpoint` y `jwks_uri` de Moodle durante el registro dinámico
— y esas llamadas **servidor-a-servidor** pasan por el mismo Caddy con el
mismo certificado autofirmado. Sin que cada contenedor confíe también en esa
CA, esas llamadas fallan la verificación TLS y tanto el registro dinámico
(paso 3 de "Probar la integración sin el plugin", más abajo) como cualquier
envío de nota por AGS (paso 5) rompen — con un error de certificado en los
logs de uno de los dos contenedores, no con un mensaje que de entrada apunte
a la causa (por eso cada paso de la guía de abajo dice ahora dónde mirar).

Por eso `docker-compose.yml` monta `caddy-root.crt` de solo lectura en
`moodle` y en `encuestum`, y cada uno la suma a su propio almacén de
confianza **antes** de arrancar su aplicación (ver los comentarios de
`entrypoint`/`command` de cada servicio ahí). Los dos mecanismos son
distintos porque cada uno valida TLS de una forma distinta:

- **Moodle** (PHP/curl) valida contra el almacén de certificados del sistema
  operativo. Alcanza con `update-ca-certificates` después de que el
  `Dockerfile` de la imagen instala `ca-certificates` (confirmado leyendo su
  Dockerfile público — ver el comentario en `docker-compose.yml`).
- **Encuestum** (Python/`httpx`) **no lee el almacén del sistema en
  absoluto**. Con `verify=True` (el default; nada en el código pasa otra
  cosa), `httpx` arma su propio contexto TLS con `cafile=certifi.where()` —
  el bundle que trae el paquete `certifi`, ignorando `/etc/ssl/certs` por
  completo. Esto se confirmó leyendo el código fuente instalado de `httpx`
  (`_config.py`, función `create_ssl_context`), no de memoria — ver el
  comentario largo en el servicio `encuestum` de `docker-compose.yml` para el
  detalle y por qué se descartó la alternativa de `SSL_CERT_FILE`.

## Cómo se hablan Moodle y Encuestum por dentro

Esto describe lo que la configuración hace, no algo que se haya visto correr
contra un daemon de Docker real — sigue sin ejecutarse, igual que el resto de
este entorno (ver `.superpowers/sdd/task-8-report.md` en la raíz del repo
para el detalle de qué se verificó y qué no).

Caddy es el único punto de entrada TLS y está declarado como alias de red de
**ambos** hostnames (`moodle.lvh.me` y `encuestum.lvh.me`). Eso significa
que cuando el contenedor de Encuestum necesita el JWKS de Moodle, o Moodle
necesita pedir el JWKS de Encuestum para AGS, esas llamadas *también* resuelven
a Caddy — no hay una ruta interna en HTTP plano paralela a la pública. Con la
CA de Caddy sumada al almacén de confianza de cada contenedor (sección
anterior), esas llamadas deberían viajar por HTTPS y verificar contra el mismo
certificado que ve el navegador, sin el `-k`/`-SkipCertificateCheck` que sí
hace falta al pegarle a mano desde fuera de los contenedores. "Deberían": es
el comportamiento esperado de la configuración, no algo confirmado contra un
Moodle y un Encuestum corriendo — no hay daemon de Docker en el entorno donde
se escribió esto.

Como `moodle.lvh.me`/`encuestum.lvh.me` resuelven, desde adentro de la
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

1. En Encuestum (<https://encuestum.lvh.me>), registrate, creá una
   organización y una encuesta publicada. Si querés probar que la nota vuelve
   a Moodle, activá la evaluación con IA y agregá al menos una pregunta que
   califique.

2. Pedí la URL de registro dinámico. **No es una URL fija con un `org_id` en
   la query** (eso era un IDOR — cualquiera que adivinara el UUID de otra
   organización podría registrar ahí su propio Moodle). Es un token firmado de
   un solo destino, de 30 minutos de validez, que sólo un admin de tu
   organización puede pedir, ya logueado en Encuestum:

   - Abrí <https://encuestum.lvh.me> con sesión iniciada, abrí la consola
     del navegador (F12) y corré:

     ```js
     fetch('/api/v1/lti/registration-url', { method: 'POST' })
       .then(r => r.json()).then(console.log)
     ```

   - Copiá el campo `url` de la respuesta. Tiene esta forma:

     ```
     https://encuestum.lvh.me/lti/register?enc=<token>
     ```

3. En Moodle: *Administración del sitio → Plugins → Módulos de actividad →
   Herramienta externa → Gestionar herramientas*. Pegá esa URL completa (con
   el `enc=...`) en el campo de registro dinámico y confirmá. Moodle hace el
   registro solo, contra el `enc` que generaste — si tarda más de 30 minutos
   en usarlo, pedí uno nuevo.

   **Si el registro falla con un error de certificado:** el registro
   dinámico (`dynamic_registration()` en `backend/app/routers/lti.py`) es
   Encuestum quien pide `openid_configuration` a Moodle, así que el error
   sale del lado de Encuestum. `docker compose logs encuestum` — buscá un
   502 con el detalle "No se pudo leer la configuración de la plataforma:
   ..." seguido de algo como `[SSL: CERTIFICATE_VERIFY_FAILED] unable to get
   local issuer certificate` (la forma en que Python/`httpx` reporta un CA no
   confiable). Eso apunta a que la CA de Caddy no llegó a sumarse al bundle
   de `certifi` dentro del contenedor de Encuestum. Ver "Por qué hace falta
   confiar en la CA de Caddy" más arriba — confirmá que `caddy-root.crt`
   existe en esta carpeta y que se corrió `up.ps1` completo (no un
   `docker compose up` suelto que se salte la fase 1).

4. En un curso: *Agregar una actividad → Herramienta externa*, elegí Encuestum,
   y usá **Seleccionar contenido** para elegir la encuesta desde el selector de
   deep linking.

5. Entrá como alumno (o con rol de estudiante) y respondé. Si la encuesta tiene
   evaluación con IA, la nota debería aparecer en el libro de calificaciones
   del curso al terminar de responder.

   **Si la nota no llega:** AGS tiene tráfico en las dos direcciones, así
   que un error de certificado puede aparecer en cualquiera de los dos
   contenedores — revisá ambos:
   - `docker compose logs encuestum` (`get_access_token` en
     `backend/app/lti/ags.py`: Encuestum pidiéndole un token a Moodle) —
     mismo tipo de error de `httpx`/SSL que en el paso 3.
   - `docker compose logs moodle` (Moodle validando la firma del
     `client_assertion` de Encuestum, para lo cual pide el `jwks_uri` de
     Encuestum) — ahí el error es del lado de PHP/curl, algo como `cURL
     error 60: SSL certificate problem: unable to get local issuer
     certificate`.
   En ambos casos la causa es la misma (la CA de Caddy no llegó a sumarse al
   almacén de confianza de ese contenedor) y el arreglo también.

## Apagar

```powershell
docker compose down          # conserva los datos
docker compose down -v       # borra todo, incluida la CA de Caddy
```

`down -v` borra el volumen `caddy_data`, así que la próxima vez que se corra
`up.ps1` Caddy genera una CA **nueva** — distinta a la que quedó en
`caddy-root.crt`. `up.ps1` la vuelve a extraer sola en cada corrida, así que
no hay nada manual que hacer, pero si alguna vez se corre `docker compose up`
directo (sin pasar por `up.ps1`) después de un `down -v`, el archivo viejo
queda desactualizado — confiando en una CA que ya no existe.

## Sobre la imagen de Moodle

Este compose usa `bitnamilegacy/moodle:5.0.2`. `bitnami/moodle` (sin el sufijo
`legacy`) dejó de tener tags gratuitos en Docker Hub — pasó a "Bitnami Secure
Images", un catálogo de pago. `bitnamilegacy/moodle` es el espejo gratuito,
pero está **congelado**: no recibe actualizaciones de seguridad. Sirve para
probar la integración LTI; no lo uses como base de un Moodle real sin
revisarlo primero.
