# `mod_encuestum`: una actividad nativa de Moodle

**Fecha:** 2026-08-06
**Estado:** diseño, pendiente de implementación
**Antecede:** `local_encuestum` (en producción, funcionando de punta a punta)

## Por qué existe esto si ya funciona lo otro

`local_encuestum` conecta el sitio en un clic y pone "Encuestum" en el selector de
actividades con su ícono. Toda la mecánica —lanzamiento, identidad del alumno,
deep linking, devolución de notas— la hace el `mod_lti` que Moodle ya trae.
Funciona, está probado contra Moodle 5.0.2 real, y si el plugin falla Moodle no
se rompe.

Lo que **no** da, y es lo que justifica un módulo nativo:

| | `local_encuestum` (hoy) | `mod_encuestum` |
|---|---|---|
| Copia de seguridad y restauración del curso | No arrastra la configuración | Sí |
| Finalización de actividad | Sólo "ver" | Por nota, por entrega, por aprobado |
| Grupos y agrupamientos | No | Sí |
| Restricciones de acceso por nota de otra actividad | Limitado | Nativo |
| Depende de que `mod_lti` esté habilitado | Sí | No |
| Vista previa del docente sin ser alumno | No | Sí |

Ninguna es imprescindible. Juntas son la diferencia entre "se puede usar" y "se
siente parte de Moodle".

## La decisión de arquitectura, y el hecho que la fuerza

**`mod_encuestum` no puede usar AGS.** No es una preferencia: el servicio de
notas de LTI en Moodle tiene el módulo hardcodeado. En
`mod/lti/service/gradebookservices/classes/local/service/gradebookservices.php`,
verificado dentro de la imagen `bitnamilegacy/moodle:5.0.2`:

```php
267:  'itemmodule' => 'lti', 'iteminstance' => $modlti);
341:  } else if (($lineitem->itemtype == 'mod' && $lineitem->itemmodule == 'lti'
736:  $gradeitem = $DB->get_record('grade_items', array('itemmodule' => 'lti', ...));
864:  $gradeitem = $DB->get_record('grade_items', array('itemmodule' => 'lti', ...));
```

Una actividad `mod_encuestum` nunca recibiría `lineitem_url` en su lanzamiento y
la nota no tendría por dónde volver.

**Pero no lo necesita.** AGS existe para que una herramienta *externa* pueda
escribir en el libro de calificaciones sin ser parte de Moodle. Un módulo de
actividad **es** parte de Moodle: escribe la nota con `grade_update()`, como
hacen `mod_quiz` y `mod_assign`. Todo el andamiaje de OAuth2, `client_assertion`,
line items y escalas que costó la fase 1 sobra acá.

Esto invierte la relación: `local_encuestum` es un plugin fino sobre una
mecánica gorda y estándar; `mod_encuestum` es un módulo gordo sobre una mecánica
fina y propia.

## Las dos direcciones

### Entrada: el alumno abre la actividad

No hay LTI. El módulo firma un token corto y redirige (o embebe):

```
GET /mod/launch?t=<JWT>
```

**La firma es asimétrica (RS256), no un secreto compartido.** Moodle genera un
par de claves al conectar y le manda a Encuestum **sólo la pública**. Esto no es
ceremonia: un secreto compartido no se puede guardar hasheado, porque verificar
un HMAC exige la misma clave que lo firmó. O sea que con secreto compartido
Encuestum tendría que guardar, en claro y de forma reversible, una credencial
que alcanza para lanzar como cualquier alumno de cualquier curso. Con firma
asimétrica, un volcado de la base de Encuestum **no sirve para falsificar
nada** — es la misma propiedad que da LTI, y por la misma razón.

El JWT lleva: `survey_id`, identificador estable del alumno, nombre y email (o
nada, si la actividad es anónima), `course_id`, `cmid`, y si el que entra es
docente. Vence en 2 minutos y trae un `jti` de un solo uso: se canjea
inmediatamente por la cookie de sesión de Encuestum, igual que hace hoy
`/lti/launch`.

**El identificador del alumno no es el `id` de Moodle.** Es un HMAC de
`(secreto local de Moodle, user_id)`. Ese secreto **no se comparte**: Encuestum
recibe el `sub` ya calculado y nunca necesita reproducirlo. Resolverlo al revés
—de `sub` a alumno— lo hace Moodle, que sí tiene la clave. Es estable para el
mismo sitio, inútil fuera de él, y no revela cuántos usuarios tiene la
instalación.

### Vuelta: la nota

Encuestum llama a un servicio web de Moodle que expone el propio módulo:

```
mod_encuestum_submit_grade(cmid, sub, grade, max, needs_review)
```

Que valida el token de servicio, resuelve el alumno desde `sub`, y llama a
`grade_update()`. Reusa el mismo disparador que ya existe
(`schedule_score` / `_deliver` en `backend/app/lti/ags.py`) — cambia el
transporte, no el momento.

**La escala la define Moodle**, igual que hoy: el `grade_item` del módulo tiene
su `grademax` y Encuestum reescala antes de enviar. Es el mismo problema que ya
resolvió `get_lineitem_max()`.

## Lo que NO se hace

- **Reemplazar `local_encuestum`.** Conviven. Un sitio que ya conectó por LTI
  sigue andando; el módulo es una segunda puerta, no un reemplazo. Desinstalar
  uno no toca al otro.
- **Renderizar la encuesta con PHP.** La encuesta la sigue sirviendo Encuestum
  en un iframe. Reimplementar SurveyJS del lado de Moodle sería mantener dos
  motores de render que tienen que coincidir.
- **Guardar respuestas en Moodle.** Viven en Encuestum. El módulo guarda el
  vínculo y la nota, nada más.
- **Un modo offline.** Si Encuestum no responde, la actividad no funciona. Es
  inherente y hay que decirlo en la pantalla, no esconderlo.

## Riesgos que hay que tener a la vista

**El riesgo se movió, no desapareció.** Con firma asimétrica, la dirección de
entrada (lanzar como un alumno) queda tan protegida como con LTI. Pero la
dirección de **vuelta** no: para publicar la nota, Encuestum guarda un token de
servicio web de Moodle, que es un *bearer token* y no se puede hashear. Quien lo
robe puede llamar al servicio web con los permisos que tenga ese token.

Consecuencias que hay que respetar, no adornos:

- El token de servicio se emite para un **usuario de servicio dedicado**, con la
  capacidad de publicar notas de este módulo y nada más. Nunca el token de un
  administrador.
- Tiene que poder rotarse desde la interfaz sin reinstalar nada.
- El servicio web exige **HTTPS sin excepción**, y el `wwwroot` guardado se
  revalida con `assert_public_url` en cada envío, no sólo al registrar: pudo
  quedar apuntando a otro lado.

Esto es peor que LTI en esa dirección, donde el token de AGS es de vida corta y
con alcance acotado. Es el precio de no depender de `mod_lti`.

**La revisión del Marketplace es más estricta con los módulos de actividad** que
con los `local_`: piden Privacy API completa (acá sí hay datos personales que
declarar, a diferencia del `null_provider` de hoy), copia de seguridad y
restauración, y tests de Behat. No es un obstáculo, es trabajo que hay que
contar.

**Dos plugins que hacen lo mismo confunden.** Si los dos están instalados, el
selector de actividades muestra "Encuestum" dos veces. Hay que decidir qué
mostrar y documentarlo; probablemente `local_encuestum` deba detectar al módulo
y ceder el lugar.

## Orden sugerido

1. El esqueleto del módulo y la conexión (par de claves, registro de la pública,
   rotación).
2. El lanzamiento del alumno y del docente.
3. El libro de calificaciones (`grade_update`, escala, recorrección).
4. Finalización de actividad.
5. Copia de seguridad, restauración y Privacy API.
6. Behat y empaquetado.

Cada uno deja algo usable: después de 2 ya se puede responder una encuesta desde
una actividad nativa, y después de 3 ya sirve para evaluar.
