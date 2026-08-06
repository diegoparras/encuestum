# Panel de conexión con Moodle, y dos huecos que tapa

**Fecha:** 2026-08-06
**Estado:** diseño aprobado, pendiente de implementación

## Objetivo

Que ni el admin de Moodle ni el de Encuestum tengan que adivinar. El de Moodle ya ve las
encuestas disponibles cuando arma la actividad; el de Encuestum hoy está completamente a
ciegas y ni siquiera puede conectar un LMS sin que alguien corra comandos.

## Punto de partida

La integración LTI funciona de punta a punta contra Moodle 5.0.2 real: registro dinámico,
deep linking, lanzamiento identificado y nota en el libro de calificaciones. Lo que falta
no es mecánica, es **visibilidad y operación**.

Dos cosas que este diseño incorpora vinieron de una implementación paralela que hizo otro
agente en el VPS. La suya es un subconjunto de la nuestra —sin notas, sin persistir la
identidad de la plataforma, con el estado OIDC en una tabla en vez de una cookie firmada—
pero tenía dos ideas que nosotros no teníamos, y las dos tapan huecos reales.

---

## Parte 1 — Panel de Integraciones en Encuestum

Vive en la página de **Integraciones** que ya existe, debajo de los webhooks. No se agrega
entrada de navegación: es donde alguien ya va a buscar cómo conectar Encuestum con otra
cosa.

Permiso: **admin de organización**. Las plataformas están atadas a la organización por
`org_id`, así que el aislamiento sale del modelo de datos y no de un chequeo que haya que
acordarse de escribir.

### Tres estados

**LTI apagado en el servidor.** La sección aparece igual y explica que hay que definir
`LTI_ENABLED`. Sin esto la sección se vería rota sin decir por qué: hoy todo `/lti/*`
responde 404 con la bandera apagada.

**Sin conectar.** Un botón *Conectar un Moodle* que genera el link de registro, lo muestra
con botón de copiar, avisa que vale 30 minutos y dice exactamente dónde pegarlo en Moodle.

**Conectado.** La lista de plataformas con su dominio y desde cuándo. Cada fila se
despliega y muestra, por cada encuesta vinculada: en qué curso, en qué actividad, y
**cuántas respuestas llegaron por ahí**.

Esa última columna es la que contesta la pregunta que más se va a hacer: *"¿por qué no me
llega la nota?"*. Cero respuestas → el problema está en Moodle. Con respuestas pero sin
nota → el problema es nuestro. Hoy eso se averigua mirando la base de datos.

### Desconectar

Modal que dice **cuántas actividades y cuántas respuestas afecta**, con los números reales
de esa plataforma, y exige escribir `aceptar` para habilitar el botón.

Desconectar rompe todo lo que ese Moodle tenga andando: los alumnos dejan de entrar y las
notas dejan de llegar. Las respuestas ya recibidas **no se borran** —
`SurveyResponse.lti_link_id` está declarado `ondelete="SET NULL"` — así que quedan
huérfanas pero intactas. Los datos de los alumnos no se pierden por desconectar un LMS.

### Endpoints

| Endpoint | Qué hace |
|---|---|
| `GET /api/v1/lti/platforms` | Plataformas de la organización activa, con contadores |
| `GET /api/v1/lti/platforms/{id}/links` | Detalle: encuesta, curso, actividad, respuestas |
| `DELETE /api/v1/lti/platforms/{id}` | Desconectar |
| `GET /api/v1/auth/config` | Se le agrega `lti_enabled` |

`POST /api/v1/lti/registration-url` ya existe y no se toca.

### Un dato que hoy se descarta

`LtiResourceLink` guarda `context_id` (el identificador del curso) pero no su título.
Moodle manda el título en el claim de contexto de cada lanzamiento y lo estamos tirando.

Sin él, el panel solo puede mostrar `context_id = "27"`, que no le dice nada a nadie. Se
agrega la columna `context_title` y se puebla en el lanzamiento, junto a los endpoints de
AGS que ya se refrescan ahí.

---

## Parte 2 — Selector al primer lanzamiento

**El hueco:** el plugin pone "Encuestum" en el selector de actividades de Moodle. Un
docente lo elige, Moodle lo lleva al formulario de la actividad, y si **guarda sin tocar
"Seleccionar contenido"**, la actividad queda sin encuesta asignada. Los alumnos entran y
reciben un 404: *"Esta actividad todavía no tiene una encuesta asignada."*

Nuestro deep linking funciona, pero solo si el docente usa ese botón, y nada lo obliga.
Cuanto más fácil hicimos agregar la actividad, más probable se volvió este caso.

**La solución:** en `_resource_link_redirect`, cuando no hay encuesta asignada, mirar el
rol del claim de roles del lanzamiento:

- **Docente** (`Instructor` o `ContentDeveloper` en el claim de roles): en vez del 404,
  redirigir al selector que ya existe, con un token que ate esa selección a *ese*
  `resource_link_id`. Al elegir, se crea el `LtiResourceLink` y se lo lleva a la encuesta.
- **Alumno**: el 404 de siempre, con el texto actual. Un alumno no puede arreglar esto y
  ofrecerle un selector sería peor.

El selector es el mismo `/lti-select` del deep linking. Cambia solo de dónde viene y qué
hace al confirmar: en deep linking devuelve un content item firmado a Moodle; acá crea el
vínculo directamente y redirige. Se distingue por el propósito del token.

**Lo que NO cambia:** el deep linking sigue siendo el camino recomendado, porque es el
único momento en que Moodle puede crear el ítem del libro de calificaciones con la escala
correcta. Una actividad vinculada por este atajo va a necesitar que Moodle cree el line
item al publicar la primera nota — que es lo que `ensure_lineitem()` ya hace.

---

## Parte 3 — `frame-ancestors` acotado a los Moodles registrados

**El problema:** hoy, con LTI encendido, `start.sh` genera una regla de nginx que sirve
`/s/` y `/lti-select` con `Content-Security-Policy: frame-ancestors *`. **Cualquier sitio
de internet puede embeber tus encuestas.** La revisión final lo marcó como concesión
aceptada; no hace falta que lo siga siendo.

**La solución que se descartó, y por qué.** La idea original era armar la lista con los
`issuer` de las plataformas registradas, para que se actualice sola. Al ir a implementarlo
apareció el costo: la cabecera hay que ponerla en `/s/`, y `frontend/proxy.ts` —el
middleware de Next— **excluye `/s/` a propósito**, porque es la ruta pública y la más
transitada de todo el producto. Meterla ahí agrega una consulta en cada carga de encuesta,
cacheada o no, para todos los respondientes, usen o no un LMS.

Y el riesgo que mitiga es chico: una encuesta pública ya es respondible por cualquiera con
el link. Que además se pueda embeber no habilita nada nuevo salvo *clickjacking* sobre un
formulario que de todas formas es abierto.

**La solución que se adopta.** Una variable de entorno: `LTI_FRAME_ANCESTORS`, que
`start.sh` usa al generar la regla de nginx. Sin definir, se comporta como hoy (`*`).
Definida, se emite la lista tal cual:

```
LTI_FRAME_ANCESTORS="https://moodle.escuela.edu https://aula.otrocolegio.org"
```

Cuesta una línea en `start.sh`, no toca la ruta caliente, y le da salida a quien quiera
cerrar el cerco. El precio es que hay que editarla al conectar un colegio nuevo — pero eso
pasa una vez por institución, no todos los días.

---

## Parte 4 — Encuestas anónimas

Es lo único que falta configurar de verdad, y está anotado como pendiente desde el diseño
original. Un instrumento de clima o un NPS pierde sentido si el alumno sabe que su
respuesta queda con nombre y apellido.

Un interruptor por vínculo, en el selector: **"respuestas anónimas"**. Cuando está
activado, la respuesta no se atribuye —no se guarda `lti_sub` ni el email— y **no se
publica nota**. Las dos cosas van juntas: publicar una nota por alumno es, por definición,
identificarlo.

Se guarda en `LtiResourceLink` como `anonymous`, y `_deliver()` en `ags.py` corta antes de
pedir el token si está activo.

Lo que **no** se hace: un modo anónimo global por encuesta. La misma encuesta puede usarse
identificada en un curso y anónima en otro; la decisión es del vínculo, no del instrumento.

## Parte 5 — El selector, más usable

Hoy el picker muestra título y si es examen. Con veinte encuestas eso no alcanza.

Se agrega: buscador por título, cantidad de preguntas, y fecha de última modificación.
Nada más — el resto es adorno.

---

## Fuera de alcance

- **Prevenir la doble conexión.** El plugin ya la detecta y avisa; impedirla necesita otra
  decisión de diseño.
- **`LTI_ENABLED` y `ENCUESTUM_PUBLIC_URL` desde la interfaz.** Siguen siendo
  infraestructura. La primera está acoplada al arranque del contenedor; la segunda, si
  cambia después de que un Moodle se registró, obliga a registrarlo de nuevo desde cero.
- **Editar la encuesta vinculada desde el panel de Encuestum.** Se cambia desde Moodle,
  que es donde vive la actividad.
- **La escala de la nota, cuándo enviarla y la nota de aprobación.** No son configurables y
  no deben serlo: la escala la define Moodle en el ítem del libro de calificaciones y AGS
  rechaza una nota que no coincida; el envío tiene que ocurrir siempre, tanto al responder
  como al recorregir; y la nota de aprobación ya existe en la evaluación de la encuesta y
  en los ajustes de la actividad en Moodle.

## Lo que se descartó de la implementación paralela, y por qué

- **Tabla `lti_states`**: guardar `state` y `nonce` en base necesita limpieza periódica y
  una consulta por lanzamiento. Nuestra cookie firmada no guarda nada y se valida sola.
- **`allowinstructorcustom=1` en Moodle**: innecesario con deep linking, y afloja Moodle
  permitiendo que cualquier instructor inyecte parámetros custom.
- **Su lista fija de dominios en nginx**: la idea es buena, la implementación obliga a
  editar el servidor por cada colegio nuevo. Se toma la idea, no la forma.

## Pruebas

- **Python**: los endpoints nuevos (aislamiento entre organizaciones en el listado, que
  desconectar no borre respuestas, que el selector al primer lanzamiento distinga docente
  de alumno, que `frame-ancestors` liste solo plataformas registradas).
- **Frontend**: que el modal no habilite el botón hasta que se escriba `aceptar`.
- **De punta a punta**: sobre el entorno Docker, agregar una actividad **sin** usar
  "Seleccionar contenido" y confirmar que un docente ve el selector y un alumno el 404; y
  que una actividad marcada como anónima no atribuye la respuesta ni publica nota.
