# `mod_encuestum` — Fase A: conectar, lanzar y calificar

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development
> para implementar tarea por tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** que un docente agregue una actividad **Encuestum** nativa en un curso, elija
una encuesta, el alumno la responda embebida y la nota aparezca en el libro de
calificaciones de Moodle — sin `mod_lti` de por medio.

**Architecture:** el módulo no usa LTI. Moodle genera un par de claves RSA, le da a
Encuestum **sólo la pública**, firma un token corto con la privada (RS256) y redirige al
alumno; Encuestum lo canjea por su cookie de sesión. La nota vuelve por un servicio web
que expone el propio módulo y que llama a `grade_update()`. El porqué —y el hecho de
Moodle que lo fuerza— está en
`docs/superpowers/specs/2026-08-06-mod-encuestum-design.md`.

**Tech Stack:** PHP 8.1+ / Moodle 4.5+, FastAPI + SQLModel + Alembic, PyJWT (RS256),
`cryptography`, httpx.

## Global Constraints

- Comentarios y docstrings **en español**, como el resto de `backend/app/`.
- Todo lo nuevo del backend vive detrás de `MOD_ENABLED` (por defecto apagado), con el
  mismo criterio que `LTI_ENABLED`: apagado, la superficie **no existe** (404, no 403).
- El backend corre contra **PostgreSQL**: `docker compose -f dev/test-db/docker-compose.yml up -d`.
  No fabricar `org_id` con `uuid.uuid4()`; usar `crear_org()` de `tests/conftest.py`.
- Nunca `request.url_for()` ni `request.base_url` — detrás del nginx de este proyecto el
  esquema sale `http://`. Usar `get_settings().public_base_url`.
- Las cookies que viajan dentro del iframe van `Secure` + `SameSite=None` **siempre**,
  también en `delete_cookie`. Reusar `_lti_cookie_kwargs()`.
- `session.rollback()` expira toda la identity map: releer de la base después.
- `ruff check .` limpio; suite sin regresiones.
- Frankenstyle: el componente es `mod_encuestum`, la carpeta `mod/encuestum`.

---

### Task 1: El sitio conectado (modelo y registro)

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0021_mod_sites.py`
- Create: `backend/app/routers/modapi.py`
- Modify: `backend/app/main.py`, `backend/app/config.py`
- Test: `backend/tests/test_mod_registro.py`

**Interfaces:**
- Produces: modelo `MoodleSite`; `POST /api/v1/mod/connect-url` (admin, mintea token de
  30 min); `POST /mod/register` (lo llama Moodle con ese token).

**Modelo.** En `models.py`, junto a `LtiPlatform`:

```python
class MoodleSite(SQLModel, table=True):
    """Un Moodle conectado por el módulo nativo (no por LTI).

    `public_key`: la firma es asimétrica (RS256). Moodle genera el par y manda
    sólo la pública, que se guarda tal cual porque no es secreta. Un secreto
    compartido no se puede guardar hasheado -- verificar un HMAC exige la misma
    clave que lo firmó -- así que habría que guardarlo en claro y de forma
    reversible."""
    __tablename__ = "mod_sites"
    __table_args__ = (UniqueConstraint("wwwroot", name="uq_mod_site"),)

    id: uuid.UUID = Field(primary_key=True, default_factory=uuid.uuid4)
    org_id: uuid.UUID = Field(
        sa_column=Column(GUID, ForeignKey("organizations.id", ondelete="CASCADE"),
                         nullable=False, index=True))
    wwwroot: str = Field(sa_column=Column(String, nullable=False))
    name: Optional[str] = Field(sa_column=Column(String), default=None)
    public_key: str = Field(sa_column=Column(String, nullable=False))
    # Token de servicio web de Moodle, para empujarle la nota. Es un secreto de
    # ELLOS que guardamos nosotros; va cifrado igual que el resto de las
    # credenciales salientes del producto.
    ws_token: Optional[str] = Field(sa_column=Column(String), default=None)
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, default=_utcnow))
```

Mirar cómo `LtiPlatform` declara `org_id` y copiar exactamente ese patrón (tipo de
columna GUID, índice, `ondelete`).

La unicidad va por `wwwroot` **solo**, no compuesta con `org_id`: un Moodle firma con
una única clave a nivel sitio, así que pertenece a exactamente una organización. Con la
compuesta, dos organizaciones podían tener su fila para el mismo `wwwroot` y el 409 de
abajo quedaba dependiendo sólo de la aplicación, con la carrera SELECT→INSERT abierta.

**Registro.** `POST /mod/register` recibe `{token, wwwroot, public_key, ws_token}`:

1. `read_purpose_token(MOD_REGISTER_PURPOSE, token)` → de ahí sale el `org_id`, **nunca**
   de un parámetro que controle quien llama. Vencido o ausente → 400.
2. `assert_public_url(wwwroot, require_https=True)` — si no, 400. Esto ya existe en
   `app/net_guard.py` y se usa igual en el registro LTI.
3. `public_key` tiene que ser una clave pública **RSA** parseable de al menos **2048
   bits**; si no, 400 y no se guarda nada. Una clave privada pegada por error, una EC o
   una RSA de 1024 bits pasan cualquier prueba funcional: firman y verifican bien.
4. Si ya hay un sitio con ese `wwwroot` bajo la misma organización, se **rota** la
   clave. Si el `wwwroot` existe pero bajo **otra** organización, 409 y no se toca nada:
   sin ese chequeo, el que registra segundo se queda con el sitio del primero.
5. Devuelve `{"site_id": "...", "wwwroot": "<forma canónica>"}`. **No hay ningún secreto
   que devolver.**

**Tests que importan** (los dos fallan en silencio si se rompen):

```python
async def test_no_se_puede_robar_el_sitio_de_otra_organizacion(...):
    """Registrar el mismo wwwroot desde otra org debe dar 409 y dejar la fila
    original intacta -- si se sobreescribe, el atacante manda SU clave pública,
    se queda con la privada y el Moodle de la escuela A pasa a lanzar contra
    los datos de la escuela B."""

async def test_no_se_acepta_una_clave_que_no_sirve(...):
    """Basura, clave privada en vez de pública, RSA de 1024 bits: 400 y nada
    guardado."""
```

- [ ] Escribir los dos tests y verlos fallar.
- [ ] Modelo + migración `0021`.
- [ ] Router y endpoints.
- [ ] `MOD_ENABLED` en `config.py` con el mismo `_bool()` que `LTI_ENABLED`.
- [ ] Suite en verde; commit `feat(mod): registro de sitios Moodle del módulo nativo`.

---

### Task 2: El lanzamiento

**Files:**
- Modify: `backend/app/routers/modapi.py`
- Create: `backend/app/mod/launch.py`
- Test: `backend/tests/test_mod_launch.py`

**Interfaces:**
- Produces: `GET /mod/launch?t=<JWT>` → 302 a `/s/{slug}` con la cookie sembrada.

El JWT lo firma Moodle con **su clave privada (RS256)** — Encuestum sólo tiene la
pública, ver la Tarea 1 — y trae:

```
iss = wwwroot        exp <= iat + 120        jti (aleatorio, único)
site_id, survey_id, cmid, course_id, context_title
sub  = HMAC(secreto, user_id) -- NO el id de Moodle
name, email          (ausentes si la actividad es anónima)
roles = ["teacher"] | ["student"]
anonymous = bool
```

**Lo que hay que validar, y por qué cada cosa:**

| Validación | Si falta |
|---|---|
| Firma con la clave pública de ESE `site_id` | cualquiera lanza como cualquiera |
| `exp` presente y `<= iat + 120` | un token robado sirve para siempre |
| `jti` no visto antes (cache con TTL de 120 s) | replay: repetir el mismo lanzamiento |
| La encuesta pertenece a la org del sitio | acceso cruzado entre organizaciones |
| `alg` es exactamente `RS256` | `alg: none`, o confusión de algoritmo — si se acepta HS256 con la clave pública como secreto, la pública **es** la de firmar |

Esa última fila no es teórica: es la confusión de algoritmo clásica. Pasar
`algorithms=["RS256"]` explícito a `jwt.decode`, nunca leerlo del header.

El `sub` **no** es el `id` de Moodle: es un HMAC que calcula Moodle con un secreto
**suyo**, que no se comparte. Encuestum lo recibe hecho y nunca necesita reproducirlo.

Reusar la cookie que ya existe (`LTI_COOKIE`, `_lti_cookie_kwargs()`): el lado público
(`_lti_context` en `routers/public.py`) ya sabe leerla y saltear el PIN. **No inventar
una cookie nueva** — habría que enseñarle a `public.py` a leer dos.

- [ ] Tests: firma inválida → 401; `exp` vencido → 401; `jti` repetido → 401; encuesta de
      otra org → 404; lanzamiento válido → 302 + cookie `Secure; SameSite=None`.
- [ ] Verificar que discriminan rompiendo cada validación.
- [ ] Commit `feat(mod): lanzamiento firmado del módulo nativo`.

---

### Task 3: La nota de vuelta

**Files:**
- Create: `backend/app/mod/grades.py`
- Modify: `backend/app/lti/ags.py` (sólo el despacho)
- Test: `backend/tests/test_mod_grades.py`

Cuando una respuesta viene de un `MoodleSite` (no de un `LtiResourceLink`), la nota se
empuja al servicio web de Moodle:

```
POST {wwwroot}/webservice/rest/server.php
  wstoken={ws_token}&wsfunction=mod_encuestum_submit_grade&moodlewsrestformat=json
  cmid=..&sub=..&grade=..&max=..&needs_review=0|1
```

**Tres cosas que no son obvias:**

1. **La escala la define Moodle.** El `grade_item` del módulo tiene su `grademax`; hay que
   mandar la nota en esa escala. Mismo problema que ya resolvió `get_lineitem_max()` para
   AGS: se lee y se reescala, no se asume 100.
2. **`anonymous` corta antes de pedir nada.** Igual que `_deliver` hoy. Publicar una nota
   por alumno es identificarlo.
3. **`assert_public_url` en cada envío**, no sólo al registrar: el `wwwroot` guardado pudo
   quedar apuntando a otro lado.

Reusar el disparador que ya existe (`schedule_score`): cambia el transporte, no el
momento. Una respuesta pertenece a un vínculo LTI **o** a un sitio del módulo, nunca a
los dos.

- [ ] Tests: se reescala a la escala de Moodle; anónimo no genera NINGUNA llamada
      saliente; un 500 de Moodle no propaga (la respuesta del alumno ya está guardada).
- [ ] Commit `feat(mod): publicación de notas al servicio web de Moodle`.

---

### Task 4: El esqueleto del plugin

**Files (repo nuevo `moodle-mod_encuestum`):**
- `version.php`, `db/install.xml`, `db/access.php`, `lib.php`, `mod_form.php`,
  `view.php`, `settings.php`, `lang/en/mod_encuestum.php`, `lang/es/mod_encuestum.php`,
  `pix/icon.svg`, `classes/privacy/provider.php`

`version.php`: `component = 'mod_encuestum'`, `requires = 2024100700`,
`supported = [405, 500]`, `MATURITY_ALPHA` mientras no esté completo.

`db/install.xml` — tabla `encuestum`: `id, course, name, intro, introformat, survey_id
(char 36), survey_title, anonymous (int 1), grade (int), timemodified`.

**La Privacy API acá NO es `null_provider`**, a diferencia de `local_encuestum`: el módulo
manda nombre y email del alumno a un sistema externo. Hay que declarar
`\core_privacy\local\metadata\provider` con un `external_location_link`, y decir
exactamente qué se manda.

- [ ] El plugin instala en el Moodle del entorno Docker (`admin/cli/upgrade.php`,
      **nunca como root** — crea cachés que el servidor web no puede escribir y Moodle
      responde 500 en todo).
- [ ] Commit inicial.

---

### Task 5: Conexión y lanzamiento desde Moodle

**Files:** `settings.php`, `classes/connect.php`, `launch.php`, `view.php`

> **Dos correcciones hechas al implementarla** (ver
> `.superpowers/sdd/task-mod-5-report.md`):
>
> 1. **Faltaba el endpoint del selector.** "Consulta a Encuestum" contra algo
>    que no existía: `modapi.py` sólo tenía `connect-url`, `register` y
>    `launch`. Se agregó `GET /mod/surveys?t=<JWT>`, con la misma firma RS256
>    del lanzamiento pero con `purpose: "list"` en vez de `"launch"` — y el
>    `purpose` pasó a ser un claim requerido y comparado en los dos endpoints,
>    así que ninguno de los dos tokens vale en lugar del otro. El listado filtra
>    por `Survey.org_id == sitio.org_id`, igual que `/lti/select/surveys`.
> 2. **La trampa del botón se eliminó en vez de documentarse.** El campo de la
>    URL vive en `connect.php`, la página que hace la conexión, así que lo que
>    se usa es lo que se escribió y no hay ningún "guardá primero".

- Ajustes: campo "URL de conexión" (la que genera Encuestum) + botón *Conectar*.
  Al conectar: **genera el par de claves RSA de 2048 bits**, guarda la privada en la
  configuración del plugin, crea un token de servicio web para el usuario de servicio y
  hace el `POST /mod/register` con `wwwroot` + la clave **pública** + ese token. Lo único
  que vuelve es el `site_id`.
- `view.php`: firma el JWT con la privada (RS256) y embebe `/mod/launch?t=...` en un
  iframe.
- El docente ve además un selector de encuesta en `mod_form.php`, que consulta a Encuestum
  autenticándose con la misma firma.

> ~~El botón lee la URL **guardada**, no la que está en pantalla. Mismo tropiezo
> que documenta `docs/INSTALAR-PLUGIN-VPS.md` para `local_encuestum`: hay que
> guardar antes.~~ Resuelto: ver la corrección 2 de arriba.

- [ ] Commit.

---

### Task 6: El servicio web de notas

**Files:** `db/services.php`, `classes/external/submit_grade.php`, `lib.php`

`mod_encuestum_submit_grade(cmid, sub, grade, max, needs_review)`:

1. Valida el token (lo hace Moodle) y la capacidad `mod/encuestum:receivegrade`.
2. Resuelve el alumno desde `sub` recorriendo los inscriptos del curso y comparando
   `HMAC(secreto, user_id)` — el `sub` es opaco a propósito.
3. `grade_update('mod/encuestum', $courseid, 'mod', 'encuestum', $instance, 0, $grades)`.

**REQUISITO BLOQUEANTE, no un adorno: comparar el `max` que llega contra el
`grademax` de hoy.** Encuestum manda la escala que Moodle le dio *en el
lanzamiento*, y esa escala se persiste en la fila de la respuesta, no en la
cookie: una respuesta de marzo recorregida en septiembre se publica con el
`grademax` de marzo. La decisión de mandarlo en el token (en vez de preguntarlo)
se tomó a sabiendas, y **esta comparación es la única mitigación que existe**.
Si el `max` que llega no coincide con el `grademax` actual del `grade_item`, hay
que reescalar acá o rechazar — nunca ignorarlo y publicar el número crudo.

**Un alumno no inscripto no recibe nota**: si el `sub` no matchea a nadie del curso, error,
no un `grade_update` a ciegas.

- [ ] Commit.

---

### Task 7: De punta a punta contra el Docker

- [x] Montar `mod/encuestum` en `dev/moodle/docker-compose.yml` junto al `local/`.
- [x] Conectar, crear una actividad, elegir encuesta, responder como alumno y confirmar la
      nota en el libro de calificaciones.
- [x] Repetir con la actividad marcada anónima: sin atribución y **sin** nota.
- [x] Documentar en `docs/MOODLE.md` cuándo conviene cada plugin.

Reporte: `.superpowers/sdd/task-mod-7-report.md`.

---

## Cierre

- [ ] `cd backend && python -m pytest -q` en verde.
- [ ] Los dos plugins instalados a la vez no duplican "Encuestum" en el selector de
      actividades (decidir quién cede y documentarlo).
      **Confirmado que SÍ duplican** (Tarea 7, Moodle 5.0.2): el selector devuelve
      `lti_type_3` y `encuestum`, los dos titulados "Encuestum". Queda documentado en
      `docs/MOODLE.md` y sin arreglar: falta decidir quién cede el nombre.
