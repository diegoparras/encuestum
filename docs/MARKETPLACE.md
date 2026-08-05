# Publicar el plugin en el Moodle Marketplace

Guía operativa para dar de alta `local_encuestum`. **Los pasos 1, 4 y 6 los tenés que
hacer vos**: no se pueden crear cuentas, aceptar términos ni publicar contenido en nombre
de otra persona.

---

## Antes que nada: qué cambió en 2026

El histórico **Moodle Plugins Directory** (`moodle.org/plugins`) dejó de aceptar envíos. En
febrero de 2026 quedó en solo lectura y el **20 de julio de 2026** lo reemplazó el
**Moodle Marketplace** (<https://marketplace.moodle.com/>). Los plugins gratuitos que ya
estaban se migraron solos con sus archivos y metadatos; los nuevos se envían al
Marketplace, que acepta gratuitos y pagos.

Cualquier tutorial que encuentres hablando de "registrar un plugin en moodle.org/plugins"
está desactualizado.

---

## Qué se publica

Se publica **`local_encuestum`**, que vive en su propio repositorio, separado del de
Encuestum:

```
github.com/diegoparras/encuestum              (MIT)    ← el tool LTI, ya funciona
github.com/diegoparras/moodle-local_encuestum (GPLv3)  ← esto es lo que se publica
```

El plugin **no se despliega en ningún lado**: es un ZIP que el admin de cada institución
instala en su propio Moodle. Vos no lo hosteás.

---

## Paso 1 — Publicar el repositorio (lo hacés vos)

El repositorio existe localmente en `E:\Claude\Escriba-Suite\moodle-local_encuestum`, con
todo commiteado y **sin remoto configurado a propósito**.

Creá el repositorio en GitHub como **público** y con **Issues habilitados** — el
Marketplace exige un rastreador público y transparente; sin eso no aprueban.

```bash
cd E:\Claude\Escriba-Suite\moodle-local_encuestum
git branch -M main
git remote add origin https://github.com/diegoparras/moodle-local_encuestum.git
git push -u origin main
```

> La rama local se llama `master`; el `git branch -M main` la renombra antes de subir. El
> workflow de CI corre en cualquier rama, así que no hay nada más que ajustar.

Cuando termine el push, entrá a la pestaña **Actions** y esperá a que el workflow quede en
verde. Corre `phpcs`, `phpmd`, `validate`, `savepoints`, `mustache`, `grunt` y `phpunit`
contra Moodle 4.5 LTS y 5.0. **Dos de esos pasos nunca se pudieron correr localmente**
—`validate` necesita una instalación real de Moodle y `grunt` necesita npm— así que esa
primera corrida es su estreno. Si algo sale rojo, es ahí.

---

## Paso 2 — Capturas de pantalla

El Marketplace las pide y son lo primero que mira quien evalúa si instalar algo. Con el
entorno de `dev/moodle/` levantado, sacá al menos tres:

1. **La página de ajustes del plugin** con la conexión establecida
   (*Administración del sitio → Plugins → Local → Encuestum*).
2. **El selector de actividades** de un curso, mostrando "Encuestum" con su ícono verde.
3. **Una encuesta respondiéndose dentro de Moodle**, embebida en la actividad.

Y si podés, una cuarta que es la que convence: **el libro de calificaciones con la nota
puesta por la corrección automática**. Es el argumento de venta de toda la integración.

---

## Paso 3 — Preparar los textos de la ficha

En inglés, que es el idioma del Marketplace.

**Descripción breve** (una línea):

> Connect your Moodle to a self-hosted Encuestum site: surveys and exams with AI grading,
> with grades flowing back to the gradebook.

**Descripción larga** — cubrí estos puntos:

- Qué hace: pone "Encuestum" en el selector de actividades y conecta el sitio en un clic.
- **Que requiere una instalación propia de Encuestum.** Esto es obligatorio declararlo: el
  Marketplace exige avisar claramente cuando un plugin depende de un servicio externo.
- Que no implementa LTI: usa el `mod_lti` de Moodle, o sea el código certificado de ellos.
- Que las respuestas y la corrección viven en Encuestum; Moodle solo recibe la nota.
- Que la marca se aplica con una tarea programada, así que **el cron de Moodle tiene que
  estar corriendo**.

Declará también: tipo de plugin **local**, versiones soportadas **Moodle 4.5 y 5.0**,
licencia **GPL v3 o posterior**, y el enlace al repositorio y a sus Issues.

---

## Paso 4 — Darte de alta como proveedor (lo hacés vos)

Entrá a <https://marketplace.moodle.com/>, buscá la guía de listado y registrate como
proveedor. Vas a tener que aceptar los *Provider terms*.

La documentación fina está detrás del login de Confluence de Moodle, así que los pasos
exactos hay que confirmarlos ahí:

- Guía de listado: <https://moodle.atlassian.net/wiki/external/MzFlM2RkYjM3ZDVhNDgyMGJmYjA2ZjIyMzQ1NDRlYmY>
- Documentación de proveedores: <https://moodle.atlassian.net/wiki/external/YTI4MmY4MWU2MDQyNDk5MTllZWY4YTBiNjA5ZDRjNWY>
- Términos: <https://moodle.atlassian.net/wiki/external/NzZlYWExYTIzZmU5NDJiYzgwODJjNmU1MjhiNDQ0YjQ>
- Soporte: <https://moodle.atlassian.net/servicedesk/customer/portal/166>

---

## Paso 5 — Armar el ZIP

El Marketplace recibe un ZIP, no se sincroniza solo con GitHub: **cada versión nueva se
publica explícitamente**.

La carpeta dentro del ZIP tiene que llamarse `encuestum` (el componente menos el prefijo
`local_`), no `moodle-local_encuestum`. Si el nombre no coincide, Moodle no reconoce el
plugin al instalarlo.

```bash
cd E:\Claude\Escriba-Suite
git -C moodle-local_encuestum archive --format=zip --prefix=encuestum/ -o local_encuestum.zip HEAD
```

`git archive` respeta el `.gitignore` y no mete nada que no esté versionado, que es
justamente lo que querés.

---

## Paso 6 — Enviar (lo hacés vos)

Subí el ZIP y completá la ficha. Después:

1. **Validación automática.** Corre pruebas sobre el ZIP, prácticamente las mismas que ya
   tenés en el CI. Si el workflow está verde, este paso debería pasar.
2. **Revisión humana.** Se abre un ticket de Jira donde el revisor deja observaciones.
   **Tarda varias semanas.**
3. **Casi todos los plugins vuelven como "necesita más trabajo" en la primera vuelta.**
   Presupuestá al menos una ronda de correcciones; no es señal de que algo esté mal.
4. Al aprobarse, las cadenas de idioma se registran en **AMOS** para que la comunidad las
   traduzca.

---

## Bloqueadores conocidos de aprobación

No se aprueba un plugin que:

- no tenga rastreador de issues público,
- no funcione en MySQL y PostgreSQL a la vez,
- colisione en el namespace frankenstyle,
- tenga fallas de seguridad,
- no implemente la Privacy API,
- entre en conflicto con productos comerciales de Moodle.

Dónde estamos parados con cada uno:

| Requisito | Estado |
|---|---|
| Rastreador público | habilitá Issues al crear el repo |
| MySQL y PostgreSQL | el plugin no crea tablas propias; el CI corre sobre PostgreSQL |
| Namespace frankenstyle | `local_encuestum`, verificar que esté libre |
| Privacy API | implementada como `null_provider` (no guarda datos personales) |
| Backup/restore | no aplica: es un plugin `local_`, no un módulo de actividad |
| Licencia GPLv3 | encabezado completo en cada archivo, verificado con `phpcs` |

---

## Sobre las licencias

Todo plugin de Moodle debe ser **GPL v3 o posterior**. Encuestum es MIT, que es compatible
con GPL: código MIT puede incorporarse a un proyecto GPL, no al revés. El plugin vive en su
propio repositorio bajo GPLv3 y Encuestum sigue siendo MIT. No hay conflicto.

El ícono (`pix/icon.svg`) se copió del repositorio de Encuestum y queda bajo GPLv3 junto
con el resto del plugin. El original sigue siendo MIT en su repositorio.

---

## Cosas que conviene resolver antes de enviar

Ninguna bloquea, pero un revisor puede mencionarlas:

- **`lang/es/`**: el Marketplace prefiere que el repositorio traiga solo inglés y que las
  traducciones se manejen por AMOS. El español está en neutro y correcto, pero si el
  revisor pide sacarlo, no discutas: se borra la carpeta y se sube la traducción a AMOS.
- **Doble conexión**: si un admin conecta dos veces, quedan dos entradas "Encuestum" en el
  selector. El plugin lo **detecta y avisa**, pero no lo impide.
- **Los pasos `validate` y `grunt` del CI** nunca corrieron localmente.
