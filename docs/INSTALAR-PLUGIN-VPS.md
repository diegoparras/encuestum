# Instalar el plugin `local_encuestum` en un Moodle de un VPS

> **Para un agente de IA con acceso al VPS.** Seguí los pasos en orden. No saltees las
> verificaciones: cada una existe porque su ausencia produce un fallo que se manifiesta
> lejos de su causa.

---

## Qué vas a instalar

`local_encuestum` es un plugin de Moodle que conecta el sitio con una instalación de
**Encuestum** (plataforma de encuestas y exámenes con corrección por IA).

**El plugin no implementa LTI.** Toda la mecánica —lanzamiento, identidad del alumno, deep
linking y devolución de notas— la hace el `mod_lti` que Moodle ya trae. El plugin solo
hace dos cosas: conectar el sitio en un clic y poner "Encuestum" en el selector de
actividades con su ícono.

Consecuencia práctica: **si el plugin falla, Moodle no se rompe.** En el peor caso el admin
configura la herramienta externa a mano y todo funciona igual.

---

## Requisitos previos — verificalos ANTES de tocar nada

```bash
# 1. Versión de Moodle. Tiene que ser 4.5 o superior.
php admin/cli/cfg.php --name=release
```

Si es menor que 4.5, **detenete y avisá**. El plugin declara `requires = 2024100700` y
Moodle va a rechazar la instalación; además el flujo de registro dinámico que usa no
existe en versiones anteriores.

```bash
# 2. mod_lti tiene que estar presente y habilitado.
ls -d "$(php -r 'define("CLI_SCRIPT",true); require("config.php"); echo $CFG->dirroot;')/mod/lti"
```

El plugin declara una dependencia dura sobre `mod_lti`. Si no está, la instalación falla
de forma limpia.

```bash
# 3. La URL de Encuestum tiene que ser HTTPS y resolver públicamente.
```

Encuestum **rechaza** registrarse contra un Moodle cuyo `wwwroot` no sea públicamente
resolvible, y exige HTTPS en el endpoint de registro sin excepción. Un Moodle en
`http://localhost` o en una IP privada no va a poder conectarse.

---

## Paso 1 — Ubicar la instalación de Moodle

No adivines la ruta. Averiguala:

```bash
# Buscá el config.php de Moodle
find / -name "config.php" -path "*moodle*" -maxdepth 6 2>/dev/null | head -5
```

Una vez que la tengas, guardá estas dos variables. Las vas a usar en todo el instructivo:

```bash
MOODLE=/ruta/real/a/moodle        # donde está config.php
cd "$MOODLE"

# El directorio de datos, que NO está dentro de $MOODLE
php -r 'define("CLI_SCRIPT",true); require("config.php"); echo $CFG->dataroot, PHP_EOL;'
```

---

## Paso 2 — Averiguar con qué usuario corre el servidor web

**Este es el paso que más problemas evita.** Anotalo bien.

```bash
ps -o user= -C apache2 -C httpd -C nginx -C php-fpm 2>/dev/null | sort -u
```

Vas a obtener algo como `www-data` (Debian/Ubuntu), `apache` (RHEL/CentOS), `nginx`, o
`daemon` (imágenes de Bitnami). Guardalo:

```bash
WEBUSER=www-data   # reemplazá por lo que devolvió el comando anterior
```

> ⚠️ **Nunca corras los comandos CLI de Moodle como root.** Crean archivos de caché en el
> directorio de datos que después el servidor web no puede escribir, y Moodle empieza a
> responder **500 en todas las páginas** con el mensaje *"Invalid permissions detected when
> trying to create a directory"*. El síntoma aparece mucho después de la causa y manda a
> investigar el lugar equivocado. Usá siempre `sudo -u "$WEBUSER"`.

---

## Paso 3 — Copiar el plugin

El ZIP contiene una carpeta llamada `encuestum/`. Tiene que quedar en `local/encuestum`.

```bash
cd "$MOODLE/local"
unzip /ruta/al/local_encuestum.zip
ls -d encuestum/version.php   # tiene que existir
```

> ⚠️ **El nombre de la carpeta debe ser exactamente `encuestum`**, no
> `moodle-local_encuestum` ni `local_encuestum`. Moodle deriva el nombre del componente de
> la ruta: `local/encuestum` → `local_encuestum`. Si no coincide, el plugin simplemente no
> aparece, sin ningún mensaje de error.

Ajustá el dueño para que coincida con el resto de la instalación:

```bash
chown -R "$WEBUSER":"$(stat -c '%G' "$MOODLE")" encuestum
find encuestum -type d -exec chmod 755 {} \;
find encuestum -type f -exec chmod 644 {} \;
```

---

## Paso 4 — Instalar

```bash
cd "$MOODLE"
sudo -u "$WEBUSER" php admin/cli/upgrade.php --non-interactive
```

Esperá ver una línea como:

```
-->local_encuestum
++ Success (0.13 seconds) ++
```

**Verificá que quedó instalado de verdad**, no confíes en la salida:

```bash
sudo -u "$WEBUSER" php admin/cli/cfg.php --component=local_encuestum --name=version
```

Tiene que devolver un número (`2026080503` o mayor). Si devuelve vacío o error, el plugin
no está instalado.

**Verificá que el sitio sigue en pie:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://TU-MOODLE/login/index.php
```

Tiene que dar `200`. Si da `500`, casi seguro corriste algo como root: revisá el paso 2 y
arreglá los permisos del directorio de datos.

---

## Paso 5 — Verificar que el cron de Moodle corre

**Esto no es opcional.** El plugin aplica la marca (nombre, ícono, visibilidad en el
selector de actividades) mediante una tarea programada que corre cada minuto. Sin cron, la
conexión se completa pero la herramienta **queda invisible** para los docentes.

```bash
# ¿Está la tarea registrada?
sudo -u "$WEBUSER" php admin/cli/scheduled_task.php --list 2>/dev/null | grep -i encuestum

# ¿Corrió el cron alguna vez recientemente?
sudo -u "$WEBUSER" php -r 'define("CLI_SCRIPT",true); require("config.php");
  $t = $DB->get_field("config", "value", ["name" => "lastcronstart"]);
  echo $t ? "último cron: " . date("Y-m-d H:i:s", $t) . PHP_EOL : "EL CRON NUNCA CORRIÓ\n";'
```

Si el cron no está configurado, agregalo (una línea en el crontab del usuario web):

```bash
* * * * * /usr/bin/php /ruta/a/moodle/admin/cli/cron.php >/dev/null 2>&1
```

Si no podés configurar cron, **no es bloqueante**: la página de ajustes del plugin tiene un
botón **"Aplicar marca ahora"** que hace lo mismo a mano.

---

## Paso 6 — Conectar con Encuestum

Este paso lo hace una persona, no vos: hace falta una sesión de admin en **ambos** sistemas.

Dejale estas instrucciones al administrador:

1. **En Encuestum**, como administrador de la organización, generar el link de registro.
   Vale **30 minutos**.
2. **En Moodle**: *Administración del sitio → Plugins → Local → Encuestum*.
3. Pegar el link en el campo **URL de registro** y **guardar los cambios**.
4. Recién entonces apretar **Conectar con Encuestum**.

> El botón lee la URL **guardada**, no la que está en pantalla. Si aprieta Conectar sin
> guardar primero, va a recibir un error diciendo que la URL no es válida aunque lo sea.

Después de conectar, en menos de un minuto (el tiempo del cron) la página de ajustes debe
mostrar **"Conectado"**.

---

## Paso 7 — Verificación final

```bash
cd "$MOODLE"
sudo -u "$WEBUSER" php -r 'define("CLI_SCRIPT",true); require("config.php");
  $t = $DB->get_record("lti_types", ["name" => "Encuestum"]);
  if (!$t) { echo "NO HAY HERRAMIENTA: el registro no se completó\n"; exit(1); }
  printf("state=%s (debe ser 1)  coursevisible=%s (debe ser 2)  icono=%s\n",
    $t->state, $t->coursevisible, $t->icon ? "sí" : "NO");'
```

El resultado correcto es `state=1`, `coursevisible=2` e `icono=sí`. Con eso, un docente que
entre a cualquier curso y elija *Agregar una actividad* va a ver **"Encuestum"** con su
ícono verde.

---

## Diagnóstico de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El plugin no aparece tras el upgrade | La carpeta no se llama `encuestum` | Renombrarla y repetir el paso 4 |
| Moodle responde 500 en todo | Se corrió un CLI como root | `chown -R "$WEBUSER" "$DATAROOT"` y purgar cachés |
| Dice "Conectado" pero el docente no ve nada | El cron no corre | Paso 5, o usar el botón "Aplicar marca ahora" |
| "La URL no parece válida" con una URL correcta | No se guardó antes de apretar Conectar | Guardar el formulario primero |
| El registro no se completa | Encuestum rechaza el Moodle | El `wwwroot` debe ser HTTPS y público |
| Aparecen dos entradas "Encuestum" | Se conectó más de una vez | *Plugins → LTI → Gestionar herramientas*, borrar la vieja |

---

## Cómo desinstalar

```bash
cd "$MOODLE"
sudo -u "$WEBUSER" php admin/cli/uninstall_plugins.php --plugins=local_encuestum --run
rm -rf "$MOODLE/local/encuestum"
```

La desinstalación **no borra la herramienta LTI** ni desconecta nada: las actividades
existentes siguen funcionando. Solo se pierde la marca en el selector de actividades. Eso
es deliberado — borrar la configuración LTI de un admin al desinstalar sería peor.

---

## Si algo sale mal, no improvises

El plugin es prescindible: **Encuestum funciona con Moodle sin él**, usando la
"Herramienta externa" que Moodle trae de fábrica. Si la instalación se complica, revertí
(desinstalar y borrar la carpeta) y reportá qué pasó, en vez de intentar arreglar Moodle
por tu cuenta.
