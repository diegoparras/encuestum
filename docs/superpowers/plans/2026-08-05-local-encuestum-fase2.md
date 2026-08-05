# Fase 2 — `local_encuestum`: plugin de Moodle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un plugin instalable de Moodle que conecte una instalación de Encuestum en tres
clics y deje "Encuestum" en el selector de actividades con su ícono, sin que el admin
tenga que entender LTI.

**Architecture:** El plugin **no implementa LTI**. Toda la mecánica —lanzamiento,
identidad, deep linking y notas— corre sobre el `mod_lti` de Moodle, que ya está
certificado contra el estándar y que verificamos funcionando de punta a punta en la Fase 1.
El plugin hace tres cosas: dispara el registro dinámico contra la URL que pega el admin,
aplica la marca sobre el tipo de herramienta resultante (nombre, descripción, ícono,
visible en el selector de actividades), y ofrece una página de estado para diagnosticar.

**Tech Stack:** PHP 8.1+, Moodle 4.5 LTS y 5.x, `moodle-plugin-ci` en GitHub Actions.

## Global Constraints

- **Licencia GPL v3 o posterior**, obligatoria para todo plugin de Moodle. Cada archivo
  PHP lleva el encabezado GPL completo. El repositorio es nuevo y separado:
  `moodle-mod_encuestum` no aplica — el nombre correcto es **`moodle-local_encuestum`**,
  con el plugin en la **raíz** del repositorio.
- Nombre frankenstyle: **`local_encuestum`**. Todas las cadenas de idioma van con ese
  prefijo, todas las tablas y ajustes también.
- **Inglés como idioma base.** `lang/en/local_encuestum.php` es obligatorio; el español va
  como traducción en `lang/es/`.
- **Ningún texto visible hardcodeado**: todo pasa por `get_string()`.
- Comentarios y documentación del código **en inglés** (es lo que exige la guía de estilo
  de Moodle, al revés que el repo de Encuestum).
- El plugin **no guarda datos personales**: implementa la Privacy API como
  `null_provider`. Quien guarda datos es Encuestum, del otro lado.
- **No se toca ningún archivo de Moodle core** ni de `mod_lti`. El plugin solo escribe en
  las tablas `lti_types` y `lti_types_config` a través de las funciones públicas de
  `mod/lti/locallib.php`.
- Nada de dependencias vendored ni de `composer`: el revisor del Marketplace lo penaliza y
  Moodle no lo soporta en instalaciones estándar.
- Cada tarea termina con `moodle-plugin-ci` en verde y un commit.

## Por qué `local_` y no `mod_`

Decisión tomada con evidencia, en contra del diseño original. Queda acá para que nadie la
revierta sin leerla:

1. **"Encuestum" ya aparece en el selector de actividades sin escribir un módulo.** Basta
   con `lti_types.coursevisible = LTI_COURSEVISIBLE_ACTIVITYCHOOSER` (2). Verificado
   contra Moodle 5.0.2: el selector devuelve la entrada "Encuestum" apuntando a
   `modedit.php?add=lti&typeid=1`. Con `lti_types.icon` seteado, además usa nuestro ícono
   (`mod/lti/lib.php:311-314` para el selector, `:370-377` para la página del curso).
2. **Un `mod_` propio no puede reutilizar el sistema de notas de Moodle.**
   `gradebookservices::get_launch_parameters()` busca el ítem del libro con
   `itemmodule = 'lti'` hardcodeado
   (`mod/lti/service/gradebookservices/classes/local/service/gradebookservices.php:266-267`).
   Una actividad `mod_encuestum` tendría `itemmodule = 'encuestum'`, Moodle nunca
   encontraría su ítem, no mandaría `lineitem_url` en el lanzamiento, y la nota no
   llegaría. Para tener notas habría que implementar el lado plataforma completo —JWKS,
   endpoint de token, servicios AGS— que es código de autenticación propio y permanente.

`mod_encuestum` sigue teniendo sentido el día que se quiera algo que el genérico no da: un
selector visual de encuestas dentro del formulario de la actividad, o ver resultados sin
salir de Moodle. Ese trabajo no se pierde: el lado del tool, que es lo que ya está hecho y
probado, no cambia. Cuando se encare, hay que presupuestar el lado plataforma completo
—JWKS, endpoint de token, servicios AGS y el ítem del libro propio— porque el punto 2 de
arriba no tiene vuelta.

### Qué cambia respecto del spec

El spec (`docs/superpowers/specs/2026-08-03-moodle-lti-design.md`) dice `mod_encuestum` y
repositorio `moodle-mod_encuestum`. **Este plan lo reemplaza**: el componente es
`local_encuestum` y el repositorio `moodle-local_encuestum`.

Dos requisitos del spec dejan de aplicar por el cambio de tipo de plugin:

- **Backup / restore**: obligatorio para módulos de actividad, no para plugins `local_`.
  Este plugin no crea actividades ni guarda contenido de curso; la actividad que agrega el
  docente es una instancia de `mod_lti`, y de su backup se encarga Moodle.
- **El formulario de ajustes por actividad** (intentos, anonimato) que describía el spec:
  con `mod_lti` esos valores se pasan como parámetros custom. El toggle de anonimato
  queda pendiente y se resuelve del lado del tool, no del plugin.

## Estructura de archivos

Repositorio nuevo `moodle-local_encuestum`, plugin en la raíz.

| Archivo | Responsabilidad |
|---|---|
| `version.php` | Identidad y versión del plugin, versiones de Moodle soportadas |
| `settings.php` | Página de administración con el formulario de conexión |
| `lang/en/local_encuestum.php` | Cadenas en inglés (idioma base, obligatorio) |
| `lang/es/local_encuestum.php` | Traducción al español |
| `classes/privacy/provider.php` | Privacy API: declara que no guarda datos personales |
| `classes/tool_manager.php` | Toda la lógica: registro, marca, estado. Sin salida HTML |
| `connect.php` | Endpoint que dispara el registro dinámico y vuelve |
| `pix/icon.svg` | Ícono de Encuestum, usado en el selector y en el curso |
| `README.md` | Instalación, uso y capturas |
| `LICENSE` | GPL v3 |
| `.github/workflows/ci.yml` | `moodle-plugin-ci` contra la matriz soportada |
| `tests/tool_manager_test.php` | phpunit sobre `tool_manager` |

`tool_manager.php` concentra la lógica y no imprime nada; `connect.php` y `settings.php`
solo orquestan. Eso es lo que permite testear con phpunit sin simular un navegador.

---

### Task 1: Esqueleto instalable del plugin

**Files:**
- Create: `version.php`
- Create: `lang/en/local_encuestum.php`
- Create: `lang/es/local_encuestum.php`
- Create: `classes/privacy/provider.php`
- Create: `LICENSE`
- Create: `README.md`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nada.
- Produces: el componente `local_encuestum` instalable, con las cadenas
  `pluginname`, `privacy:metadata`.

- [ ] **Step 1: Crear el repositorio y el `version.php`**

Crear el repositorio nuevo (fuera del repo de Encuestum):

```bash
mkdir -p ../moodle-local_encuestum && cd ../moodle-local_encuestum && git init
```

`version.php`:

```php
<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Plugin version and metadata.
 *
 * @package    local_encuestum
 * @copyright  2026 Diego Parras
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

$plugin->component = 'local_encuestum';
$plugin->version   = 2026080500;
// 4.5 LTS. Antes de esa no existe el registro dinámico tal como lo usamos.
$plugin->requires  = 2024100700;
$plugin->maturity  = MATURITY_ALPHA;
$plugin->release   = '0.1.0';
```

- [ ] **Step 2: Cadenas en inglés**

`lang/en/local_encuestum.php` (con el mismo encabezado GPL de 15 líneas que
`version.php`, omitido acá por brevedad — **hay que ponerlo, el revisor lo verifica**):

```php
$string['pluginname'] = 'Encuestum';
$string['privacy:metadata'] = 'The Encuestum plugin only stores the connection settings for an Encuestum site. It does not store any personal data itself; responses are stored by the connected Encuestum site.';
```

- [ ] **Step 3: Traducción al español**

`lang/es/local_encuestum.php`:

```php
$string['pluginname'] = 'Encuestum';
$string['privacy:metadata'] = 'El plugin de Encuestum solo guarda los datos de conexión con un sitio Encuestum. No almacena datos personales: las respuestas las guarda el sitio Encuestum conectado.';
```

- [ ] **Step 4: Privacy API**

`classes/privacy/provider.php`:

```php
namespace local_encuestum\privacy;

/**
 * Privacy provider. This plugin stores no personal data: it only holds the
 * connection settings for an Encuestum site. The responses themselves live in
 * Encuestum, and the data sent to it during a launch is declared by mod_lti,
 * which is what actually performs the launch.
 */
class provider implements \core_privacy\local\metadata\null_provider {

    public static function get_reason(): string {
        return 'privacy:metadata';
    }
}
```

- [ ] **Step 5: Licencia y README**

`LICENSE`: el texto completo de la GPL v3, tal cual, desde
<https://www.gnu.org/licenses/gpl-3.0.txt>.

`README.md`: qué hace el plugin, que requiere una instalación propia de Encuestum, y los
pasos de instalación. Se completa en la Fase 3 con capturas.

`.gitignore`:

```
/vendor/
/node_modules/
/moodle/
```

- [ ] **Step 6: Verificar que instala**

Montar el plugin en el Moodle de pruebas y correr el instalador:

```bash
cd /mnt/e/Claude/Escriba-Suite/encuestum-standalone/dev/moodle
docker compose cp ../../../moodle-local_encuestum moodle:/opt/bitnami/moodle/local/encuestum
docker compose exec -T -u daemon moodle php /opt/bitnami/moodle/admin/cli/upgrade.php --non-interactive
```

Expected: `local_encuestum ... Success`. Si dice "Plugin not found", el nombre de la
carpeta no coincide con el componente.

> Ojo: el CLI se corre como `daemon`, no como root. Como root crea archivos de caché que
> Apache después no puede escribir y Moodle empieza a responder 500 con "Invalid
> permissions detected when trying to create a directory".

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: installable plugin skeleton"
```

---

### Task 2: `tool_manager` — aplicar la marca sobre el tipo de herramienta

**Files:**
- Create: `classes/tool_manager.php`
- Create: `pix/icon.svg`
- Create: `tests/tool_manager_test.php`
- Modify: `lang/en/local_encuestum.php`, `lang/es/local_encuestum.php`

**Interfaces:**
- Consumes: el esqueleto de la Task 1.
- Produces:
  - `\local_encuestum\tool_manager::TOOL_NAME` = `'Encuestum'`
  - `\local_encuestum\tool_manager::find_tool(): ?\stdClass` — el tipo de herramienta de
    Encuestum, o `null` si no hay ninguno.
  - `\local_encuestum\tool_manager::apply_branding(int $typeid): void` — nombre,
    descripción, ícono y visibilidad en el selector de actividades.
  - `\local_encuestum\tool_manager::icon_url(): string`

- [ ] **Step 1: Escribir el test que falla**

`tests/tool_manager_test.php`:

```php
namespace local_encuestum;

/**
 * @covers \local_encuestum\tool_manager
 */
final class tool_manager_test extends \advanced_testcase {

    /** Creates a bare LTI 1.3 tool type, like dynamic registration leaves it. */
    private function crear_tipo(): int {
        global $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');
        $type = new \stdClass();
        $type->name = 'Sin marca';
        $type->baseurl = 'https://encuestum.example/lti/launch';
        $type->state = LTI_TOOL_STATE_CONFIGURED;
        $type->coursevisible = LTI_COURSEVISIBLE_PRECONFIGURED;
        $type->ltiversion = LTI_VERSION_1P3;
        $type->clientid = 'cliente-de-prueba';
        $config = new \stdClass();
        $config->lti_toolurl = $type->baseurl;
        return lti_add_type($type, $config);
    }

    public function test_apply_branding_deja_la_herramienta_en_el_selector(): void {
        global $DB, $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');
        $this->resetAfterTest();

        $typeid = $this->crear_tipo();
        tool_manager::apply_branding($typeid);

        $tipo = $DB->get_record('lti_types', ['id' => $typeid], '*', MUST_EXIST);
        $this->assertSame(tool_manager::TOOL_NAME, $tipo->name);
        $this->assertEquals(LTI_COURSEVISIBLE_ACTIVITYCHOOSER, (int)$tipo->coursevisible);
        $this->assertNotEmpty($tipo->description);
        $this->assertSame(tool_manager::icon_url(), $tipo->icon);
    }

    public function test_find_tool_encuentra_la_herramienta_marcada(): void {
        $this->resetAfterTest();
        $this->assertNull(tool_manager::find_tool());

        $typeid = $this->crear_tipo();
        tool_manager::apply_branding($typeid);

        $encontrada = tool_manager::find_tool();
        $this->assertNotNull($encontrada);
        $this->assertEquals($typeid, $encontrada->id);
    }

    public function test_find_tool_ignora_herramientas_de_otros(): void {
        global $DB;
        $this->resetAfterTest();
        $typeid = $this->crear_tipo();
        // Otra herramienta LTI cualquiera del sitio no debe confundirse con la nuestra.
        $this->assertNull(tool_manager::find_tool());
        $this->assertNotEmpty($DB->get_record('lti_types', ['id' => $typeid]));
    }
}
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
docker compose exec -T -u daemon moodle php /opt/bitnami/moodle/admin/tool/phpunit/cli/init.php
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter tool_manager_test
```

Expected: FAIL con `Class "local_encuestum\tool_manager" not found`.

- [ ] **Step 3: El ícono**

`pix/icon.svg` — copiar el de Encuestum:

```bash
cp ../encuestum-standalone/frontend/app/icon.svg pix/icon.svg
```

Es el mismo logo (cuadrado verde `#8faf0e` con las barras). Al copiarlo a este
repositorio queda bajo GPL v3 junto con el resto del plugin; el original sigue siendo MIT
en el repo de Encuestum, y MIT es compatible con GPL en esa dirección.

- [ ] **Step 4: Implementar `tool_manager`**

`classes/tool_manager.php`:

```php
namespace local_encuestum;

/**
 * Everything this plugin knows how to do to an LTI tool type. No HTML output:
 * settings.php and connect.php orchestrate, this class decides.
 */
class tool_manager {

    /** Name shown in the activity chooser and on the course page. */
    public const TOOL_NAME = 'Encuestum';

    /**
     * URL of the icon Moodle shows in the activity chooser and next to the
     * activity. It is served from this plugin, not from the connected
     * Encuestum site: the icon must render even when that site is unreachable.
     */
    public static function icon_url(): string {
        global $OUTPUT;
        return $OUTPUT->image_url('icon', 'local_encuestum')->out(false);
    }

    /**
     * The Encuestum tool type, or null when the site has not been connected yet.
     * Matched by name because that is what apply_branding() guarantees; the
     * base URL is not usable as a key since each institution runs its own
     * Encuestum on its own domain.
     */
    public static function find_tool(): ?\stdClass {
        global $DB;
        $tipo = $DB->get_record('lti_types', ['name' => self::TOOL_NAME]);
        return $tipo ?: null;
    }

    /**
     * Turns the bare tool type left by dynamic registration into a branded one:
     * our name, our description, our icon, and — the point of this plugin —
     * visible in the activity chooser as its own entry.
     */
    public static function apply_branding(int $typeid): void {
        global $DB, $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');

        $tipo = $DB->get_record('lti_types', ['id' => $typeid], '*', MUST_EXIST);
        $tipo->name = self::TOOL_NAME;
        $tipo->description = get_string('tooldescription', 'local_encuestum');
        $tipo->icon = self::icon_url();
        $tipo->secureicon = $tipo->icon;
        $tipo->coursevisible = LTI_COURSEVISIBLE_ACTIVITYCHOOSER;
        $tipo->timemodified = time();
        $DB->update_record('lti_types', $tipo);
    }
}
```

Agregar a `lang/en/local_encuestum.php`:

```php
$string['tooldescription'] = 'Surveys and exams with AI grading. Pick one of your Encuestum surveys and the grade comes back to the gradebook.';
```

y a `lang/es/local_encuestum.php`:

```php
$string['tooldescription'] = 'Encuestas y exámenes con corrección por IA. Elegí una de tus encuestas de Encuestum y la nota vuelve al libro de calificaciones.';
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

```bash
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter tool_manager_test
```

Expected: OK (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: brand the LTI tool type and show it in the activity chooser"
```

---

### Task 3: Conexión en un clic (registro dinámico)

**Files:**
- Create: `connect.php`
- Create: `settings.php`
- Modify: `classes/tool_manager.php`
- Modify: `lang/en/local_encuestum.php`, `lang/es/local_encuestum.php`
- Modify: `tests/tool_manager_test.php`

**Interfaces:**
- Consumes: `tool_manager::apply_branding()`, `tool_manager::find_tool()` de la Task 2.
- Produces:
  - `tool_manager::registration_url(string $encuestumurl): \moodle_url` — la URL a la que
    hay que mandar al admin, con `openid_configuration` y `registration_token` colgados.
  - Página de admin en *Administración del sitio → Plugins → Local → Encuestum*.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/tool_manager_test.php`:

```php
    public function test_registration_url_lleva_los_dos_parametros(): void {
        $this->resetAfterTest();
        $url = tool_manager::registration_url('https://encuestum.example/lti/register?enc=abc');

        $partes = [];
        parse_str(parse_url($url->out(false), PHP_URL_QUERY), $partes);
        // El token propio de Encuestum tiene que sobrevivir intacto.
        $this->assertSame('abc', $partes['enc']);
        // Y hay que agregarle los dos que espera el estándar.
        $this->assertStringContainsString('/mod/lti/openid-configuration.php',
            $partes['openid_configuration']);
        $this->assertNotEmpty($partes['registration_token']);
        // Es un JWT firmado por el sitio: tres partes separadas por punto.
        $this->assertCount(3, explode('.', $partes['registration_token']));
    }

    public function test_registration_url_rechaza_una_url_que_no_es_http(): void {
        $this->resetAfterTest();
        $this->expectException(\moodle_exception::class);
        tool_manager::registration_url('javascript:alert(1)');
    }
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter tool_manager_test
```

Expected: FAIL con `Call to undefined method ...::registration_url()`.

- [ ] **Step 3: Implementar `registration_url`**

Agregar a `classes/tool_manager.php`:

```php
    /**
     * Builds the URL that starts LTI Dynamic Registration against an Encuestum
     * site, exactly as mod/lti/startltiadvregistration.php does: a client id,
     * a registration token signed with this site's private key, and the URL of
     * this site's OpenID configuration. The tool does the rest when it is hit.
     */
    public static function registration_url(string $encuestumurl): \moodle_url {
        global $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');

        $limpia = clean_param($encuestumurl, PARAM_URL);
        if ($limpia === '' || !preg_match('#^https?://#i', $limpia)) {
            throw new \moodle_exception('invalidurl', 'local_encuestum');
        }

        $ahora = time();
        $token = [
            'sub'   => \mod_lti\local\ltiopenid\registration_helper::get()->new_clientid(),
            'scope' => \mod_lti\local\ltiopenid\registration_helper::REG_TOKEN_OP_NEW_REG,
            'iat'   => $ahora,
            'exp'   => $ahora + HOURSECS,
        ];
        $clave = \mod_lti\local\ltiopenid\jwks_helper::get_private_key();
        $firmado = \Firebase\JWT\JWT::encode($token, $clave['key'], 'RS256', $clave['kid']);

        $url = new \moodle_url($limpia);
        $url->param('openid_configuration',
            (new \moodle_url('/mod/lti/openid-configuration.php'))->out(false));
        $url->param('registration_token', $firmado);
        return $url;
    }
```

Cadenas nuevas en `lang/en/local_encuestum.php`:

```php
$string['invalidurl'] = 'That does not look like a valid Encuestum registration URL. It should start with https:// and be the link you copied from Encuestum.';
```

y en `lang/es/local_encuestum.php`:

```php
$string['invalidurl'] = 'Esa no parece una URL de registro de Encuestum válida. Tiene que empezar con https:// y ser el link que copiaste desde Encuestum.';
```

- [ ] **Step 4: Correr los tests**

```bash
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter tool_manager_test
```

Expected: OK (5 tests).

- [ ] **Step 5: La página de administración**

`settings.php`:

```php
defined('MOODLE_INTERNAL') || die();

if ($hassiteconfig) {
    $pagina = new admin_settingpage('local_encuestum',
        get_string('pluginname', 'local_encuestum'));

    $herramienta = \local_encuestum\tool_manager::find_tool();
    if ($herramienta) {
        $pagina->add(new admin_setting_heading('local_encuestum/estado',
            get_string('connected', 'local_encuestum'),
            get_string('connected_desc', 'local_encuestum', s($herramienta->baseurl))));
    } else {
        $pagina->add(new admin_setting_heading('local_encuestum/estado',
            get_string('notconnected', 'local_encuestum'),
            get_string('notconnected_desc', 'local_encuestum')));
    }

    $pagina->add(new admin_setting_configtext('local_encuestum/registrationurl',
        get_string('registrationurl', 'local_encuestum'),
        get_string('registrationurl_desc', 'local_encuestum'), '', PARAM_RAW_TRIMMED));

    // El sesskey va acá: connect.php lo exige para que nadie pueda disparar un
    // registro desde afuera con un enlace preparado.
    $enlace = new moodle_url('/local/encuestum/connect.php', ['sesskey' => sesskey()]);
    $pagina->add(new admin_setting_heading('local_encuestum/conectar', '',
        html_writer::link($enlace, get_string('connect', 'local_encuestum'),
            ['class' => 'btn btn-primary'])));

    $ADMIN->add('localplugins', $pagina);
}
```

Cadenas en inglés:

```php
$string['connect'] = 'Connect to Encuestum';
$string['connected'] = 'Connected';
$string['connected_desc'] = 'This site is connected to the Encuestum instance at {$a}. Teachers will find "Encuestum" in the activity chooser.';
$string['notconnected'] = 'Not connected yet';
$string['notconnected_desc'] = 'Paste the registration URL from your Encuestum site below and press Connect.';
$string['registrationurl'] = 'Registration URL';
$string['registrationurl_desc'] = 'In Encuestum, as an organisation admin, generate a registration link and paste it here. It is valid for 30 minutes.';
```

Y en español:

```php
$string['connect'] = 'Conectar con Encuestum';
$string['connected'] = 'Conectado';
$string['connected_desc'] = 'Este sitio está conectado con la instalación de Encuestum en {$a}. Los docentes van a encontrar "Encuestum" en el selector de actividades.';
$string['notconnected'] = 'Todavía sin conectar';
$string['notconnected_desc'] = 'Pegá abajo la URL de registro de tu Encuestum y apretá Conectar.';
$string['registrationurl'] = 'URL de registro';
$string['registrationurl_desc'] = 'En Encuestum, como admin de la organización, generá un link de registro y pegalo acá. Vale 30 minutos.';
```

- [ ] **Step 6: El endpoint de conexión**

`connect.php`:

```php
require_once(__DIR__ . '/../../config.php');

require_login();
$contexto = context_system::instance();
require_capability('moodle/site:config', $contexto);
require_sesskey();

$destino = new moodle_url('/admin/settings.php', ['section' => 'local_encuestum']);
$configurada = get_config('local_encuestum', 'registrationurl');

try {
    $url = \local_encuestum\tool_manager::registration_url((string)$configurada);
} catch (moodle_exception $e) {
    redirect($destino, $e->getMessage(), null, \core\output\notification::NOTIFY_ERROR);
}

// A partir de acá manda Encuestum: recibe el token, se registra contra este
// sitio y devuelve la página que cierra el asistente.
redirect($url);
```

`require_sesskey()` obliga a que el enlace lleve el token anti-CSRF, que `settings.php` ya
agrega en el paso anterior. Sin eso, cualquiera podría hacer que un admin logueado dispare
un registro contra un sitio ajeno con solo hacerle clic a un enlace.

- [ ] **Step 7: Probar el circuito completo a mano**

Con el entorno de la Fase 1 levantado:

1. En Encuestum, generar el link de registro:
   `POST /api/v1/lti/registration-url` como admin de la organización.
2. En Moodle: *Administración del sitio → Plugins → Local → Encuestum*, pegar el link,
   Guardar, y apretar **Conectar**.
3. Verificar que vuelve con la herramienta dada de alta:

```bash
docker compose exec -T postgres psql -U encuestum -d encuestum -c \
  "select issuer, client_id, deployment_ids from lti_platforms;"
```

Expected: una fila con el issuer de Moodle.

4. Verificar que quedó marcada y en el selector:

```bash
docker compose exec -T moodle php -r '
define("CLI_SCRIPT",true); require("/opt/bitnami/moodle/config.php");
$t = $DB->get_record("lti_types", ["name" => "Encuestum"]);
echo "coursevisible={$t->coursevisible} icon={$t->icon}\n";'
```

Expected: `coursevisible=2` y el icono apuntando a `/local/encuestum/pix/icon.svg`.

> El registro dinámico deja la herramienta en `state=2` (pendiente de aprobación del
> admin). `apply_branding()` tiene que activarla además de marcarla: agregar
> `$tipo->state = LTI_TOOL_STATE_CONFIGURED;` si el paso 4 muestra que sigue pendiente.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: one-click connection via dynamic registration"
```

---

### Task 4: Enganchar la marca al alta de la herramienta

**Files:**
- Create: `db/events.php`
- Create: `classes/observer.php`
- Create: `tests/observer_test.php`

**Interfaces:**
- Consumes: `tool_manager::apply_branding()` de la Task 2.
- Produces: la marca se aplica sola cuando el registro dinámico crea la herramienta, sin
  que el admin tenga que apretar nada más.

**Por qué hace falta:** `connect.php` redirige al tool y **pierde el control**: el resto
del registro ocurre entre Encuestum y Moodle por detrás, y el admin vuelve a la página del
asistente, no a la nuestra. Sin un observador, la herramienta queda creada pero sin marca
ni visible en el selector, y habría que pedirle al admin un paso más.

- [ ] **Step 1: Escribir el test que falla**

`tests/observer_test.php`:

```php
namespace local_encuestum;

/**
 * @covers \local_encuestum\observer
 */
final class observer_test extends \advanced_testcase {

    public function test_la_marca_se_aplica_al_crearse_la_herramienta(): void {
        global $DB, $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');
        $this->resetAfterTest();

        $type = new \stdClass();
        $type->name = 'Sin marca';
        $type->baseurl = 'https://encuestum.example/lti/launch';
        $type->state = LTI_TOOL_STATE_CONFIGURED;
        $type->coursevisible = LTI_COURSEVISIBLE_PRECONFIGURED;
        $type->ltiversion = LTI_VERSION_1P3;
        $type->clientid = 'cliente';
        $config = new \stdClass();
        $config->lti_toolurl = $type->baseurl;
        $typeid = lti_add_type($type, $config);

        // El evento que dispara Moodle al crear un tipo de herramienta.
        $evento = \mod_lti\event\lti_type_created::create([
            'context' => \context_system::instance(),
            'objectid' => $typeid,
        ]);
        observer::lti_type_created($evento);

        $tipo = $DB->get_record('lti_types', ['id' => $typeid], '*', MUST_EXIST);
        $this->assertSame(tool_manager::TOOL_NAME, $tipo->name);
        $this->assertEquals(LTI_COURSEVISIBLE_ACTIVITYCHOOSER, (int)$tipo->coursevisible);
    }

    public function test_no_toca_herramientas_de_otros_proveedores(): void {
        global $DB, $CFG;
        require_once($CFG->dirroot . '/mod/lti/locallib.php');
        $this->resetAfterTest();

        $type = new \stdClass();
        $type->name = 'Otra herramienta';
        $type->baseurl = 'https://otra.example/launch';
        $type->state = LTI_TOOL_STATE_CONFIGURED;
        $type->coursevisible = LTI_COURSEVISIBLE_PRECONFIGURED;
        $type->ltiversion = LTI_VERSION_1P3;
        $type->clientid = 'otro';
        $config = new \stdClass();
        $config->lti_toolurl = $type->baseurl;
        $typeid = lti_add_type($type, $config);

        $evento = \mod_lti\event\lti_type_created::create([
            'context' => \context_system::instance(),
            'objectid' => $typeid,
        ]);
        observer::lti_type_created($evento);

        $tipo = $DB->get_record('lti_types', ['id' => $typeid], '*', MUST_EXIST);
        $this->assertSame('Otra herramienta', $tipo->name);
    }
}
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter observer_test
```

Expected: FAIL con `Class "local_encuestum\observer" not found`.

- [ ] **Step 3: Implementar el observador**

`classes/observer.php`:

```php
namespace local_encuestum;

/**
 * Applies our branding when dynamic registration creates the tool type.
 *
 * connect.php hands control over to Encuestum and never gets it back: the rest
 * of the registration happens between the two servers, and the admin lands on
 * the wizard's own closing page. This observer is what makes the connection
 * one click instead of two.
 */
class observer {

    /**
     * Only touches tool types whose base URL belongs to the Encuestum site the
     * admin pasted. Other providers registered on the same Moodle are left
     * alone — a site can have many LTI tools and none of them are ours.
     */
    public static function lti_type_created(\mod_lti\event\lti_type_created $evento): void {
        global $DB;

        $typeid = (int)$evento->objectid;
        $tipo = $DB->get_record('lti_types', ['id' => $typeid]);
        if (!$tipo) {
            return;
        }

        $configurada = (string)get_config('local_encuestum', 'registrationurl');
        $esperado = parse_url($configurada, PHP_URL_HOST);
        $recibido = parse_url((string)$tipo->baseurl, PHP_URL_HOST);
        if (!$esperado || !$recibido || strcasecmp($esperado, $recibido) !== 0) {
            return;
        }

        tool_manager::apply_branding($typeid);
    }
}
```

`db/events.php`:

```php
defined('MOODLE_INTERNAL') || die();

$observers = [
    [
        'eventname' => '\mod_lti\event\lti_type_created',
        'callback'  => '\local_encuestum\observer::lti_type_created',
    ],
];
```

- [ ] **Step 4: Correr los tests**

```bash
docker compose exec -T -u daemon moodle vendor/bin/phpunit --filter observer_test
```

Expected: OK (2 tests).

- [ ] **Step 5: Subir la versión y reinstalar**

Los observadores se leen al instalar. Subir `$plugin->version` a `2026080501` y correr:

```bash
docker compose exec -T -u daemon moodle php /opt/bitnami/moodle/admin/cli/upgrade.php --non-interactive
```

- [ ] **Step 6: Probar el circuito de una sola pasada**

Borrar la herramienta existente, generar un link nuevo en Encuestum, y repetir el paso 7
de la Task 3 **sin tocar nada después**. La herramienta tiene que quedar con el nombre
"Encuestum", el ícono, y `coursevisible=2` sola.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: apply branding automatically when the tool is registered"
```

---

### Task 5: Integración continua

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: CI que corre en cada push, con la misma batería que usa el Marketplace.

- [ ] **Step 1: Escribir el workflow**

`.github/workflows/ci.yml`, con la matriz de versiones mantenidas de Moodle:

```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_USER: postgres
          POSTGRES_HOST_AUTH_METHOD: trust
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 3
        ports:
          - 5432:5432

    strategy:
      fail-fast: false
      matrix:
        include:
          - php: '8.1'
            moodle-branch: 'MOODLE_405_STABLE'
          - php: '8.3'
            moodle-branch: 'MOODLE_500_STABLE'

    steps:
      - uses: actions/checkout@v4
        with:
          path: plugin

      - uses: shivammathur/setup-php@v2
        with:
          php-version: ${{ matrix.php }}
          extensions: pgsql, zip, gd, xmlrpc, soap
          ini-values: max_input_vars=5000
          coverage: none

      - name: Instalar moodle-plugin-ci
        run: |
          composer create-project -n --no-dev --prefer-dist \
            moodlehq/moodle-plugin-ci ci ^4
          echo $(cd ci/bin; pwd) >> $GITHUB_PATH
          echo $(cd ci/vendor/bin; pwd) >> $GITHUB_PATH

      - name: Preparar el sitio
        run: moodle-plugin-ci install --plugin ./plugin --db-host=127.0.0.1
        env:
          DB: pgsql
          MOODLE_BRANCH: ${{ matrix.moodle-branch }}

      # Cada paso por separado: si falla el estilo, se ve que el estilo falló y
      # no "el CI".
      - run: moodle-plugin-ci phplint
      - run: moodle-plugin-ci phpmd
      - run: moodle-plugin-ci phpcs --max-warnings 0
      - run: moodle-plugin-ci validate
      - run: moodle-plugin-ci savepoints
      - run: moodle-plugin-ci mustache
      - run: moodle-plugin-ci grunt --max-lint-warnings 0
      - run: moodle-plugin-ci phpunit --fail-on-warning
```

- [ ] **Step 2: Correr las mismas comprobaciones localmente antes de empujar**

`phpcs` es el que más suele fallar en un plugin nuevo: exige el encabezado GPL en cada
archivo, `@package` en cada bloque de documentación, y líneas de menos de 132 caracteres.

```bash
cd ../moodle-local_encuestum
docker run --rm -v "$PWD":/plugin -w / moodlehq/moodle-php-apache:8.3 \
  bash -c "composer create-project -n --no-dev moodlehq/moodle-plugin-ci /ci ^4 >/dev/null \
    && /ci/vendor/bin/phpcs --standard=moodle /plugin"
```

Expected: `No errors or warnings found`. Si aparecen, corregirlos antes de commitear: el
Marketplace corre exactamente esto.

- [ ] **Step 3: Commit y push**

```bash
git add -A && git commit -m "ci: moodle-plugin-ci across supported Moodle versions"
git remote add origin https://github.com/diegoparras/moodle-local_encuestum.git
git push -u origin main
```

Verificar que el workflow queda en verde en GitHub antes de dar la tarea por terminada.

---

## Cierre de la Fase 2

- [ ] Los cinco pasos del CI en verde en las dos versiones de Moodle de la matriz.
- [ ] El circuito completo probado a mano en el entorno de la Fase 1: instalar el plugin,
      pegar la URL, conectar, y que "Encuestum" aparezca en el selector de actividades con
      su ícono.
- [ ] Un docente puede agregar la actividad, elegir la encuesta con el selector, y la nota
      llega al libro de calificaciones — es decir, no rompimos nada de lo que ya andaba.
- [ ] `README.md` con los pasos de instalación y qué requiere (una instalación propia de
      Encuestum).

Lo que **no** entra en esta fase y queda para la Fase 3: capturas de pantalla, el texto de
la ficha del Marketplace, y el ZIP de release.
